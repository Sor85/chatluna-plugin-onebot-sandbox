import { describe, expect, it } from 'vitest'
import {
  MODEL_REQUEST_COMPOSITION_KINDS,
  MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_PIXELS,
  MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_WIDTH,
  MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH,
  MODEL_REQUEST_COMPOSITION_SEGMENT_GAP,
  MODEL_REQUEST_COMPOSITION_ZOOM_MAX,
  aggregateModelRequestComposition,
  groupModelRequestCompositionSegments,
  isModelRequestCompositionSegmentSelected,
  layoutModelRequestCompositionSegment,
  layoutModelRequestCompositionSlots,
  modelRequestCompositionKindOf,
  resolveModelRequestCompositionGranularity,
  type ModelRequestCompositionSlot,
} from '../src/model-request-composition'
import type { SandboxModelRequestPromptCompositionItem } from '../src/types'

/** 均分布局下每格恒为 1/请求数；用它构造「时间上完全不相近」的会话。 */
function spread(count: number, segmentCount: number): ModelRequestCompositionSlot[] {
  return Array.from({ length: count }, () => ({ timeShare: 0, segmentCount }))
}

describe('请求组成粒度判定', () => {
  it('没有请求时按逐条证据，不会因为空会话切到聚合', () => {
    expect(resolveModelRequestCompositionGranularity([])).toBe('evidence')
  })

  it('请求少且分段少时保持逐条证据', () => {
    expect(resolveModelRequestCompositionGranularity(spread(3, 40))).toBe('evidence')
    expect(resolveModelRequestCompositionGranularity(spread(10, 20))).toBe('evidence')
  })

  it('请求多到均分后每段都不足最小宽度时改为聚合', () => {
    expect(resolveModelRequestCompositionGranularity(spread(200, 500))).toBe('aggregate')
    expect(resolveModelRequestCompositionGranularity(spread(50, 130))).toBe('aggregate')
  })

  it('阈值按最大缩放倍率折算：拉到最大倍率仍看得清的会话不聚合', () => {
    // 每格 1/40，段数正好让最大倍率下的分段宽度落在最小宽度上。
    const legible = Math.floor(100 / 40 * MODEL_REQUEST_COMPOSITION_ZOOM_MAX / MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_WIDTH)

    expect(resolveModelRequestCompositionGranularity(spread(40, legible))).toBe('evidence')
    expect(resolveModelRequestCompositionGranularity(spread(40, legible + 1))).toBe('aggregate')
  })

  it('时间不相近就按时间槽判定：耗时占比够宽的请求仍然逐条', () => {
    // 两条请求，一条独占九成时间跨度，另一条只有千分之一——窄的那条决定结果。
    const slots: ModelRequestCompositionSlot[] = [
      { timeShare: 0.9, segmentCount: 400 },
      { timeShare: 0.001, segmentCount: 400 },
    ]

    // 均分布局下每格 50%，两条都够宽，因此仍按逐条下发；只按实际耗时判会白白丢掉细节。
    expect(resolveModelRequestCompositionGranularity(slots)).toBe('evidence')
    expect(resolveModelRequestCompositionGranularity([
      { timeShare: 0.9, segmentCount: 4000 },
      { timeShare: 0.001, segmentCount: 4000 },
    ])).toBe('aggregate')
  })

  it('没有分段的请求不参与判定，进行中的请求不会把整张图推成聚合', () => {
    expect(resolveModelRequestCompositionGranularity([
      { timeShare: 0.5, segmentCount: 6 },
      { timeShare: 0, segmentCount: 0 },
    ])).toBe('evidence')
  })

  it('跨度重叠的请求先按总量归一，不会各自都以为独占全宽', () => {
    // 十条请求同一时刻发出且耗时相同：占比各为 1，加起来是整条轴的十倍。
    const overlapping = Array.from({ length: 10 }, () => ({ timeShare: 1, segmentCount: 300 }))

    // 不归一时每条都按 100% 宽判定，三百段也算看得清；归一后退回均分的 10%，判定与真实空间一致。
    expect(resolveModelRequestCompositionGranularity(overlapping)).toBe('aggregate')
    expect(resolveModelRequestCompositionGranularity(
      overlapping.map(slot => ({ ...slot, segmentCount: 100 })),
    )).toBe('evidence')
  })
})

describe('请求组成聚合', () => {
  const items: readonly SandboxModelRequestPromptCompositionItem[] = [
    { kind: 'user', evidenceId: 'req:message:messages.1', characters: 30, requestId: 'r1' },
    { kind: 'system', evidenceId: 'req:message:messages.0', characters: 100, requestId: 'r1' },
    { kind: 'user', evidenceId: 'variable:v1', characters: 20, variableId: 'v1', variableName: '{name}', requestId: 'r1' },
    { kind: 'tool-interaction', evidenceId: 'req:tool-call:messages.2.tool_calls.0', characters: 7, requestId: 'r1' },
    { kind: 'system', evidenceId: 'req:message:messages.0', characters: 40, requestId: 'r2' },
  ]

  it('每请求每种类折成一段，并按轨道顺序排列', () => {
    expect(aggregateModelRequestComposition(items)).toEqual([
      { kind: 'system', characters: 100, segmentCount: 1, requestId: 'r1' },
      { kind: 'user', characters: 50, segmentCount: 2, requestId: 'r1' },
      { kind: 'tool-interaction', characters: 7, segmentCount: 1, requestId: 'r1' },
      { kind: 'system', characters: 40, segmentCount: 1, requestId: 'r2' },
    ])
  })

  it('字符数只做加总，聚合前后每一档的总量完全相等', () => {
    const aggregated = aggregateModelRequestComposition(items)
    const total = (list: readonly SandboxModelRequestPromptCompositionItem[]) =>
      list.reduce((sum, item) => sum + item.characters, 0)

    expect(total(aggregated)).toBe(total(items))
    for (const kind of MODEL_REQUEST_COMPOSITION_KINDS) {
      expect(total(aggregated.filter(item => item.kind === kind)))
        .toBe(total(items.filter(item => item.kind === kind)))
    }
  })

  it('聚合段不再携带证据身份与变量身份，请求顺序按首次出现保留', () => {
    const aggregated = aggregateModelRequestComposition([...items].reverse())

    expect(aggregated.every(item => item.evidenceId === undefined)).toBe(true)
    expect(aggregated.every(item => item.variableId === undefined)).toBe(true)
    expect([...new Set(aggregated.map(({ requestId }) => requestId))]).toEqual(['r2', 'r1'])
  })

  it('零字符的档位不产出空段', () => {
    expect(aggregateModelRequestComposition([
      { kind: 'system', evidenceId: 'req:message:messages.0', characters: 0, requestId: 'r1' },
      { kind: 'user', evidenceId: 'req:message:messages.1', characters: 5, requestId: 'r1' },
    ])).toEqual([{ kind: 'user', characters: 5, segmentCount: 1, requestId: 'r1' }])
  })
})

describe('轨迹行落在哪条组成轨道', () => {
  it('变量与用户消息同轨，工具调用与工具结果并入工具交互', () => {
    expect(modelRequestCompositionKindOf('variable')).toBe('user')
    expect(modelRequestCompositionKindOf('user')).toBe('user')
    expect(modelRequestCompositionKindOf('tool-call')).toBe('tool-interaction')
    expect(modelRequestCompositionKindOf('tool-result')).toBe('tool-interaction')
    expect(modelRequestCompositionKindOf('system')).toBe('system')
    expect(modelRequestCompositionKindOf('assistant')).toBe('assistant')
    expect(modelRequestCompositionKindOf('tool-definition')).toBe('tool-definition')
  })

  it('请求边界与模型响应不进请求体统计，因此没有轨道', () => {
    expect(modelRequestCompositionKindOf('request')).toBeUndefined()
    expect(modelRequestCompositionKindOf('response')).toBeUndefined()
  })
})

describe('哪一块分段是选中的那一条', () => {
  /** 一条请求的工具声明轨道：合成块与逐段分段都落在这一档。 */
  const TOOL_DEFS = { kind: 'tool-definition', requestId: 'r1' } as const
  /** 账本里选中了这条请求的第三个工具声明。 */
  const SELECTED_TOOL = { kind: 'tool-definition', requestId: 'r1', evidenceId: 'req:tool-definition:tools.2' } as const

  it('逐段分段按证据身份判：同一轨道上的其余分段不受影响', () => {
    expect(isModelRequestCompositionSegmentSelected(
      { ...TOOL_DEFS, evidenceId: 'req:tool-definition:tools.2' },
      SELECTED_TOOL,
    )).toBe(true)
    expect(isModelRequestCompositionSegmentSelected(
      { ...TOOL_DEFS, evidenceId: 'req:tool-definition:tools.3' },
      SELECTED_TOOL,
    )).toBe(false)
  })

  it('合成块按它合了哪几条判：合进去的任意一条被选中都算命中', () => {
    // 合成块曾借用聚合段的「请求 + 轨道」判据，于是点中一个工具声明会把同一轨道上所有合成块
    // 一起描边——实测一条请求里点一块、亮四块。它们各自只覆盖这一档里的几条，不是整档。
    expect(isModelRequestCompositionSegmentSelected(
      { ...TOOL_DEFS, evidenceIds: ['req:tool-definition:tools.1', 'req:tool-definition:tools.2'] },
      SELECTED_TOOL,
    )).toBe(true)
    expect(isModelRequestCompositionSegmentSelected(
      { ...TOOL_DEFS, evidenceIds: ['req:tool-definition:tools.7', 'req:tool-definition:tools.8'] },
      SELECTED_TOOL,
    )).toBe(false)
  })

  it('有证据身份的块不因为选中请求边界行而整轨道亮起', () => {
    const boundary = { kind: 'request', requestId: 'r1' } as const

    expect(isModelRequestCompositionSegmentSelected({ ...TOOL_DEFS, evidenceId: 'req:tool-definition:tools.0' }, boundary)).toBe(false)
    expect(isModelRequestCompositionSegmentSelected({ ...TOOL_DEFS, evidenceIds: ['req:tool-definition:tools.0'] }, boundary)).toBe(false)
  })

  it('聚合段按请求加轨道判：选中请求边界行时整条请求的各档一起亮', () => {
    const aggregated = { kind: 'user', requestId: 'r1' } as const

    expect(isModelRequestCompositionSegmentSelected(aggregated, { kind: 'request', requestId: 'r1' })).toBe(true)
    // 变量行落在 User 轨道，工具调用落在工具交互轨道。
    expect(isModelRequestCompositionSegmentSelected(aggregated, { kind: 'variable', requestId: 'r1', evidenceId: 'variable:v1' })).toBe(true)
    expect(isModelRequestCompositionSegmentSelected(aggregated, { kind: 'tool-call', requestId: 'r1', evidenceId: 'req:tool-call:messages.2.tool_calls.0' })).toBe(false)
    expect(isModelRequestCompositionSegmentSelected(aggregated, { kind: 'request', requestId: 'r2' })).toBe(false)
  })

  it('请求身份先对上：同一条证据身份在每条请求里各出现一次', () => {
    // 第 N 条请求的请求体含前 N 轮历史，不比请求会让一次选中点亮整段会话里的同名分段。
    const selected = { kind: 'system', requestId: 'r2', evidenceId: 'req:message:messages.0' } as const

    expect(isModelRequestCompositionSegmentSelected({ kind: 'system', requestId: 'r1', evidenceId: 'req:message:messages.0' }, selected)).toBe(false)
    expect(isModelRequestCompositionSegmentSelected({ kind: 'system', requestId: 'r1', evidenceIds: ['req:message:messages.0'] }, selected)).toBe(false)
    expect(isModelRequestCompositionSegmentSelected({ kind: 'system', requestId: 'r2', evidenceId: 'req:message:messages.0' }, selected)).toBe(true)
  })

  it('单请求视图的分段没有请求身份，只按定位信号的证据身份判', () => {
    const segment = { kind: 'user', evidenceId: 'req:message:messages.1' } as const

    expect(isModelRequestCompositionSegmentSelected(segment, { evidenceId: 'req:message:messages.1' })).toBe(true)
    expect(isModelRequestCompositionSegmentSelected(segment, { evidenceId: 'req:message:messages.2' })).toBe(false)
    // 空证据身份表示定位信号来自没有模型证据的行，此时一块都不亮。
    expect(isModelRequestCompositionSegmentSelected(segment, { evidenceId: '' })).toBe(false)
  })

  it('没有选中态时一块都不亮', () => {
    expect(isModelRequestCompositionSegmentSelected({ ...TOOL_DEFS, evidenceId: 'req:tool-definition:tools.0' }, undefined)).toBe(false)
    expect(isModelRequestCompositionSegmentSelected({ ...TOOL_DEFS, evidenceIds: ['req:tool-definition:tools.0'] }, undefined)).toBe(false)
    expect(isModelRequestCompositionSegmentSelected({ kind: 'user', requestId: 'r1' }, undefined)).toBe(false)
  })
})

describe('请求时间槽铺位', () => {
  /** 相邻两格是否有重合；重合意味着两条请求的组成会画在同一段横轴上。 */
  function overlaps(boxes: readonly { left: number, width: number }[]) {
    return boxes.slice(1).filter((box, index) => {
      const previous = boxes[index]!
      return box.width > 0 && previous.width > 0 && box.left < previous.left + previous.width - 1e-9
    }).length
  }

  it('按次序均分时每格恰好一份均分宽，首尾贴住两端', () => {
    const boxes = layoutModelRequestCompositionSlots(
      Array.from({ length: 4 }, (_, index) => ({ start: index * 25, span: 25 })),
    )

    expect(boxes).toEqual([
      { left: 0, width: 25 },
      { left: 25, width: 25 },
      { left: 50, width: 25 },
      { left: 75, width: 25 },
    ])
  })

  it('跨度不足下限时补到下限，位置照旧按真实时刻', () => {
    const boxes = layoutModelRequestCompositionSlots([
      { start: 0, span: 0.01 },
      { start: 40, span: 0.01 },
    ])

    expect(boxes[0]).toEqual({ left: 0, width: MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH })
    expect(boxes[1]).toEqual({ left: 40, width: MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH })
  })

  it('时间上挤在一起的几条请求各自分到一格，不再互相重合', () => {
    // 二十小时的会话里连着发了四次十秒请求：自然起点只差万分之几，各自都要占到下限那么宽。
    const boxes = layoutModelRequestCompositionSlots([
      { start: 99.9, span: 0.014 },
      { start: 99.92, span: 0.014 },
      { start: 99.94, span: 0.014 },
      { start: 99.96, span: 0.014 },
    ])

    expect(overlaps(boxes)).toBe(0)
    // 四格各 0.75% 宽，末格右边界正好贴住轴的终点：起点被「后面还要留几格」逐格顶回来。
    expect(boxes.map(({ left }) => Math.round(left * 100) / 100)).toEqual([97, 97.75, 98.5, 99.25])
    expect(boxes.at(-1)).toEqual({ left: 99.25, width: MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH })
  })

  it('末尾几格不会被挤出轴外：每格都为后面的请求留出下限宽度', () => {
    const boxes = layoutModelRequestCompositionSlots([
      { start: 0, span: 99 },
      { start: 99, span: 1 },
      { start: 99.5, span: 0.5 },
    ])

    expect(overlaps(boxes)).toBe(0)
    expect(boxes.every(({ left, width }) => left >= 0 && left + width <= 100 + 1e-9)).toBe(true)
    expect(boxes[0]!.width).toBeCloseTo(98.5)
  })

  it('请求多到均分宽小于下限时下限让步，总宽仍然铺不出轴外', () => {
    const boxes = layoutModelRequestCompositionSlots(
      Array.from({ length: 400 }, () => ({ start: 100, span: 0.001 })),
    )

    expect(overlaps(boxes)).toBe(0)
    expect(boxes.every(({ width }) => width === 0.25)).toBe(true)
    expect(boxes.at(-1)!.left + boxes.at(-1)!.width).toBeCloseTo(100)
  })

  it('进行中的请求只标起点：不占宽度，也不推开后面的请求', () => {
    const boxes = layoutModelRequestCompositionSlots([
      { start: 0, span: 30 },
      { start: 30, span: 0 },
      { start: 30, span: 20 },
    ])

    expect(boxes[1]).toEqual({ left: 30, width: 0 })
    expect(boxes[2]).toEqual({ left: 30, width: 20 })
  })

  it('没有请求或全部进行中时不产出任何宽度', () => {
    expect(layoutModelRequestCompositionSlots([])).toEqual([])
    expect(layoutModelRequestCompositionSlots([{ start: 0, span: 0 }])).toEqual([{ left: 0, width: 0 }])
  })
})

describe('分段在格里的铺位', () => {
  /** 单请求视图的那一格：整条轴。 */
  const FULL_SLOT = { left: 0, width: 100 }
  /** 一条五等分的请求：每档各占自己那一格的两成。 */
  const EVEN_SHARES = [0, 20, 40, 60, 80].map((start, index, list) => ({
    start,
    span: 20,
    gapAfter: index < list.length - 1,
  }))

  /** 相邻两段之间露出的缝有多宽。 */
  function gaps(boxes: readonly { left: number, width: number }[]) {
    return boxes.slice(1).map(({ left }, index) => left - (boxes[index]!.left + boxes[index]!.width))
  }

  it('相邻分段各自让出一份间隙，最后一段贴住格的右边界', () => {
    const boxes = EVEN_SHARES.map(share => layoutModelRequestCompositionSegment(FULL_SLOT, share))

    for (const { width } of boxes.slice(0, -1)) {
      expect(width).toBeCloseTo(20 - MODEL_REQUEST_COMPOSITION_SEGMENT_GAP, 9)
    }
    expect(boxes.at(-1)).toEqual({ left: 80, width: 20 })
    // 间隙只从分段自己的宽度里扣，不推开后面的分段：每一段的起点仍是它的真实占比位置。
    expect(boxes.map(({ left }) => left)).toEqual([0, 20, 40, 60, 80])
    for (const gap of gaps(boxes)) {
      expect(gap).toBeCloseTo(MODEL_REQUEST_COMPOSITION_SEGMENT_GAP, 9)
    }
  })

  it('会话里一格只占整条轴的一小段，把这一格拉到全宽后与单请求视图逐像素一致', () => {
    const slot = { left: 37.5, width: 5 }
    const scale = 100 / slot.width
    const projected = EVEN_SHARES
      .map(share => layoutModelRequestCompositionSegment(slot, share))
      .map(({ left, width }) => ({ left: (left - slot.left) * scale, width: width * scale }))

    projected.forEach((box, index) => {
      const full = layoutModelRequestCompositionSegment(FULL_SLOT, EVEN_SHARES[index]!)
      expect(box.left).toBeCloseTo(full.left, 9)
      expect(box.width).toBeCloseTo(full.width, 9)
    })
  })
  it('薄于最小宽度的分段同样留缝：下限不再把间隙填回去', () => {
    // 一条请求只占到时间槽下限那么宽，五档各占它的两成——每段都远薄于分段下限。
    const slot = { left: 0, width: MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH }
    const boxes = EVEN_SHARES.map(share => layoutModelRequestCompositionSegment(slot, share))

    expect(boxes.every(({ width }) => width > 0 && width < MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_WIDTH)).toBe(true)
    expect(gaps(boxes).every(gap => gap > 0)).toBe(true)
    // 下限兜的是「扣完间隙还是薄到看不见」，绝不把分段撑得比真实占比宽：末段仍然正好贴住格的右边界。
    expect(boxes.at(-1)!.left + boxes.at(-1)!.width).toBeCloseTo(slot.width, 9)
  })

  it('间隙最多吃掉四分之一宽度，密集分段不会被扣成零宽', () => {
    const slot = { left: 0, width: 1 }
    // 一格里塞进一百段：按格宽算出的间隙比每一段本身还宽。
    const boxes = Array.from({ length: 100 }, (_, index) => layoutModelRequestCompositionSegment(slot, {
      start: index,
      span: 1,
      gapAfter: index < 99,
    }))

    expect(boxes.every(({ width }) => width > 0)).toBe(true)
    expect(boxes[0]!.width).toBeCloseTo(0.01 * 0.75, 12)
  })

  it('铺到格右边界的分段不越界，也不为不存在的下一段留缝', () => {
    const slot = { left: 90, width: 10 }

    expect(layoutModelRequestCompositionSegment(slot, { start: 0, span: 100, gapAfter: false }))
      .toEqual({ left: 90, width: 10 })
  })
})

describe('挤不开的分段合成一块', () => {
  /** 一条请求里等宽铺开的几条证据。 */
  function evenSegments(requestId: string, left: number, width: number, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      requestId,
      left: left + (index * width) / count,
      width: width / count,
    }))
  }

  it('相邻分段一路并到够宽为止，够宽的分段自己独占一块', () => {
    const groups = groupModelRequestCompositionSegments([
      { left: 0, width: 0.1 },
      { left: 0.1, width: 0.1 },
      { left: 0.2, width: 0.1 },
      { left: 0.3, width: 5 },
      { left: 5.3, width: 0.1 },
    ], 0.25)

    expect(groups.map(({ from, to, left }) => ({ from, to, left }))).toEqual([
      { from: 0, to: 3, left: 0 },
      { from: 3, to: 4, left: 0.3 },
      { from: 4, to: 5, left: 5.3 },
    ])
    expect(groups[0]!.width).toBeCloseTo(0.3, 9)
  })

  it('合成块覆盖首段左边界到末段右边界，占比读数因此不变', () => {
    const segments = evenSegments('r1', 10, 4, 40)
    const groups = groupModelRequestCompositionSegments(segments, 1)

    expect(groups.every(({ width }) => width >= 1 || width === segments[0]!.width)).toBe(true)
    expect(groups[0]!.left).toBe(10)
    expect(groups.at(-1)!.left + groups.at(-1)!.width).toBeCloseTo(14, 9)
  })

  it('跨请求不合并：请求边界是这张图的横轴刻度', () => {
    const groups = groupModelRequestCompositionSegments([
      ...evenSegments('r1', 0, 0.2, 2),
      ...evenSegments('r2', 0.2, 0.2, 2),
    ], 5)

    expect(groups).toHaveLength(2)
    expect(groups.map(({ from, to }) => [from, to])).toEqual([[0, 2], [2, 4]])
  })

  it('不跨变量档的边界合并，相邻的不同变量照旧并成一块', () => {
    // 一条请求里普通 User 内容与变量片段交替，每段都薄到挤不开。
    const groups = groupModelRequestCompositionSegments([
      { requestId: 'r1', left: 0, width: 0.05 },
      { requestId: 'r1', left: 0.05, width: 0.05 },
      { requestId: 'r1', left: 0.1, width: 0.05, variableId: 'v1' },
      { requestId: 'r1', left: 0.15, width: 0.05, variableId: 'v1' },
      { requestId: 'r1', left: 0.2, width: 0.05, variableId: 'v2' },
      { requestId: 'r1', left: 0.25, width: 0.05 },
    ], 5)

    // 前两段是非变量档，中间三段都在变量档（v1 v1 v2 并成一块），末段又回到非变量档。
    expect(groups.map(({ from, to }) => [from, to])).toEqual([[0, 2], [2, 5], [5, 6]])
  })

  it('阈值为零时逐段保留：放大到分段自己就够宽的倍率后不再合并', () => {
    const segments = evenSegments('r1', 0, 100, 12)

    expect(groupModelRequestCompositionSegments(segments, 0)).toHaveLength(12)
    expect(groupModelRequestCompositionSegments(segments, MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_PIXELS / 1400 * 100))
      .toHaveLength(12)
  })

  it('没有分段时不产出任何一块', () => {
    expect(groupModelRequestCompositionSegments([], 1)).toEqual([])
  })
})

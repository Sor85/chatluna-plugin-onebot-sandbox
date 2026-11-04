import { describe, expect, it } from 'vitest'
import {
  buildModelRequestTrajectorySearchMutes,
  buildModelRequestTrajectorySearchTexts,
  filterModelRequestTrajectoryRows,
  isModelRequestTrajectoryRowCollapsed,
  orderModelRequestTrajectoryRows,
  toggleModelRequestTrajectoryCollapse,
} from '../client/model-request/trajectory-display'
import type { SandboxEvidenceKind } from '../src/evidence-kind'
import type { SandboxModelRequestTrajectoryRow } from '../src/types'

function row(id: string, kind: SandboxModelRequestTrajectoryRow['kind'], requestId: string): SandboxModelRequestTrajectoryRow {
  return { id, index: 1, kind, preview: id, requestId }
}

describe('模型请求轨迹账本展示', () => {
  const rows = [
    row('one:request', 'request', 'one'),
    row('one:system', 'system', 'one'),
    row('one:variable', 'variable', 'one'),
    row('two:request', 'request', 'two'),
    row('two:user', 'user', 'two'),
  ]

  it('默认倒序请求组，但保留每条请求内的阅读顺序', () => {
    expect(orderModelRequestTrajectoryRows(rows, 'desc').map(({ id }) => id)).toEqual([
      'two:request', 'two:user', 'one:request', 'one:system', 'one:variable',
    ])
  })

  it('正序恢复服务端请求组顺序，并且只隐藏折叠请求的内容行', () => {
    expect(orderModelRequestTrajectoryRows(rows, 'asc').map(({ id }) => id)).toEqual(rows.map(({ id }) => id))
    const collapsed = new Set(['one'])
    expect(isModelRequestTrajectoryRowCollapsed(rows[0]!, collapsed)).toBe(false)
    expect(isModelRequestTrajectoryRowCollapsed(rows[1]!, collapsed)).toBe(true)
    expect(isModelRequestTrajectoryRowCollapsed(rows[3]!, collapsed)).toBe(false)
  })

  it('折叠开关按请求来回切换，没有请求标识时什么都不改', () => {
    const empty: ReadonlySet<string> = new Set()

    const collapsed = toggleModelRequestTrajectoryCollapse(empty, 'one')
    expect([...collapsed]).toEqual(['one'])

    const expanded = toggleModelRequestTrajectoryCollapse(collapsed, 'one')
    expect([...expanded]).toEqual([])

    // 缺请求标识时原集合原样返回：塞进 undefined 会让所有同样缺标识的行被判成已折叠。
    expect(toggleModelRequestTrajectoryCollapse(collapsed, undefined)).toBe(collapsed)
    expect(toggleModelRequestTrajectoryCollapse(collapsed, '')).toBe(collapsed)
  })
})

describe('模型请求轨迹账本可见行', () => {
  const rows = [
    row('one:request', 'request', 'one'),
    row('one:system', 'system', 'one'),
    row('one:user', 'user', 'one'),
    row('two:request', 'request', 'two'),
    row('two:system', 'system', 'two'),
  ]
  const noHiddenKinds: ReadonlySet<SandboxEvidenceKind> = new Set()

  it('默认全部显示', () => {
    expect(filterModelRequestTrajectoryRows({
      rows,
      requestsCollapsed: false,
      hiddenKinds: noHiddenKinds,
    }).map(({ id }) => id)).toEqual(rows.map(({ id }) => id))
  })

  it('全局折叠只留请求边界行', () => {
    expect(filterModelRequestTrajectoryRows({
      rows,
      requestsCollapsed: true,
      hiddenKinds: noHiddenKinds,
    }).map(({ id }) => id)).toEqual(['one:request', 'two:request'])
  })

  it('种类过滤隐藏对应证据行，但请求边界行不参与种类过滤', () => {
    expect(filterModelRequestTrajectoryRows({
      rows,
      requestsCollapsed: false,
      hiddenKinds: new Set<SandboxEvidenceKind>(['system', 'user']),
    }).map(({ id }) => id)).toEqual(['one:request', 'two:request'])
  })

  it('两条规则叠加时仍然留下请求边界行，账本不会变成空白', () => {
    expect(filterModelRequestTrajectoryRows({
      rows,
      requestsCollapsed: true,
      hiddenKinds: new Set<SandboxEvidenceKind>(['system', 'user', 'assistant', 'tool-definition']),
    }).map(({ id }) => id)).toEqual(['one:request', 'two:request'])
  })
})

describe('模型请求轨迹账本搜索', () => {
  const rows = [
    row('one:system', 'system', 'one'),
    row('one:user', 'user', 'one'),
  ]
  const describeRow = (row: SandboxModelRequestTrajectoryRow) => [row.preview, row.toolName, row.callId]
  const textsOf = (source: readonly SandboxModelRequestTrajectoryRow[] = rows) =>
    buildModelRequestTrajectorySearchTexts(source, describeRow)

  it('可搜索文本按行折叠成小写一次，与查询无关', () => {
    let described = 0
    const texts = buildModelRequestTrajectorySearchTexts(rows, (row) => {
      described += 1
      return describeRow(row)
    })

    // 每行只问一次描述；静音判定另算，输入一个字不会把整张表重新小写一遍。
    expect(described).toBe(rows.length)
    expect(texts.get('one:system')).toBe('one:system')
  })

  it('查询为空时不给静音集合，调用方据此跳过整张表', () => {
    expect(buildModelRequestTrajectorySearchMutes(rows, '', textsOf())).toBeUndefined()
    expect(buildModelRequestTrajectorySearchMutes(rows, '   ', textsOf())).toBeUndefined()
  })

  it('压暗未命中的行而不是过滤掉它们', () => {
    const muted = buildModelRequestTrajectorySearchMutes(rows, 'one:user', textsOf())

    expect(muted && [...muted]).toEqual(['one:system'])
  })

  it('大小写与首尾空格不影响命中', () => {
    const cased = [row('ONE:System', 'system', 'one')]

    const muted = buildModelRequestTrajectorySearchMutes(cased, '  one:SYSTEM  ', textsOf(cased))

    expect(muted && [...muted]).toEqual([])
  })

  it('描述函数给出的多个字段任一命中即算命中', () => {
    const tooled: SandboxModelRequestTrajectoryRow[] = [
      { id: 'call', index: 1, kind: 'tool-call', preview: '无关', requestId: 'one', toolName: 'search_web' },
    ]

    const muted = buildModelRequestTrajectorySearchMutes(tooled, 'search_web', textsOf(tooled))

    expect(muted && [...muted]).toEqual([])
  })

  it('文本表里没有这一行时按未命中处理，不会漏掉刚追加的行', () => {
    const muted = buildModelRequestTrajectorySearchMutes(rows, 'one', new Map())

    expect(muted && [...muted]).toEqual(['one:system', 'one:user'])
  })
})

import type {
  SandboxModelRequestPromptCompositionGranularity,
  SandboxModelRequestPromptCompositionItem,
  SandboxModelRequestPromptKind,
  SandboxModelRequestTrajectoryKind,
} from './types'

/**
 * 请求组成图的轨道顺序、分段可辨识度判定、按请求聚合与分段身份。
 *
 * 与证据种类 module 同一形状的浏览器安全纯 module：不依赖 Node、Koishi、Vue 或 DOM，
 * 因此服务端派生组成项与客户端铺轨道共用同一份顺序、同一个最小宽度和同一条粒度判据。
 * 三者任意一侧自己留一份，都会表现为「服务端按聚合下发、客户端仍按逐段量宽度」这类无声错位。
 *
 * 它只描述组成图的几何、粒度与「哪一块是选中的那一条」，不描述字符怎么数（那是模型证据投影的
 * 度量）、也不描述账本行怎么展开（那是轨迹派生的事）。
 */

/**
 * 组成图的轨道顺序，按证据在请求体里出现的先后排列：
 * 系统前缀 → 用户消息 → 能力目录 → 模型自己的发言 → 工具往返。
 * Assistant 紧贴 Tool I/O，两者的分段都落在请求尾部，同屏才能看出一次工具往返由哪条发言发起。
 *
 * 单请求与完整会话共用这一份顺序：两种模式的分段来自同一份组成投影，只是横轴一个按占比、
 * 一个按时间铺开；各自留一份种类清单会让同一条会话在切换模式时凭空多出或少掉几条轨道。
 * 聚合粒度也按它排每个请求内部的先后，因此两种粒度的读法一致。
 */
export const MODEL_REQUEST_COMPOSITION_KINDS: readonly SandboxModelRequestPromptKind[] = Object.freeze([
  'system',
  'user',
  'tool-definition',
  'assistant',
  'tool-interaction',
])

/**
 * 一条分段仍然看得清的最小宽度，单位是占整条轨道的百分比。
 *
 * 视图给每条分段兜的最小宽度就是这个数：低于它的分段在默认倍率下已经不足一个像素宽。
 */
export const MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_WIDTH = 0.35

/**
 * 相邻两条分段之间留出的间隙，单位是占**所在那一格**的百分比。
 *
 * 口径必须相对那一格而不是整条轴：单请求视图里一条请求铺满全轴，会话视图里同一条请求只占
 * 一格，写成占整条轴的绝对值会让会话轨道的间隙随请求数一起缩到看不见，而轨道放大到单条请求时
 * 又要与单请求视图逐像素一致（焦点窗口的整段设计就建立在这条承诺上）。
 *
 * 间隙从分段自己的宽度里扣，绝不推开后面的分段：占比是从左边界读出来的，推开会让整格的读数
 * 一路右移。
 */
export const MODEL_REQUEST_COMPOSITION_SEGMENT_GAP = 0.35

/**
 * 间隙最多吃掉一条分段的几成宽度。
 *
 * 一格里塞进几十条分段时，按格宽算出的间隙会比分段本身还宽，扣完只剩零宽。按分段自身宽度
 * 设上限之后，薄分段留下的是一条更细的实体加一条更细的缝，而不是彻底消失。
 */
const SEGMENT_GAP_MAX_SHARE = 0.25

/**
 * 一条分段仍然能与邻段分辨开所需的像素宽：一格实体加一条缝。
 *
 * 这是唯一一处以像素为单位的口径。分段宽度是占比的函数，而「看不看得清」是像素的函数：会话
 * 轨道把整段会话铺在一屏里时，一条请求只分到几十个像素，它内部的几十条证据无论怎么算占比都
 * 落不到一个像素上。视图给每条分段兜的那个像素级最小宽度会把它们全部撑到同一个厚度，于是相邻
 * 分段互相压住，整条请求糊成一根实心条——读出来的既不是占比也不是条数。
 */
export const MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_PIXELS = 4

/** 一组挤不开、要合成一块来画的相邻分段：覆盖输入的哪几条，以及合成后的几何。 */
export interface ModelRequestCompositionSegmentGroup {
  /** 覆盖输入里的 `[from, to)` 这几条分段。 */
  from: number
  to: number
  left: number
  width: number
}

/**
 * 把一条轨道上挤不开的相邻分段并成一块。
 *
 * 合成块的宽度取首段左边界到末段右边界，因此它等于这几段连同中间的缝所占的那一段横轴——占比
 * 读数不会因为合并而变化，变化的只是「这一块里有几条证据」这一层细节。它是服务端聚合粒度的
 * 几何版本：粒度判据按最大缩放倍率一次性判定整份投影，而这里按当前实际画出来的像素判定，因此
 * 放大到一条请求时同一批分段会自动散开，不必重新取一份投影。
 *
 * 只合并相邻、同属一条请求且同在变量档或同在非变量档的分段。请求边界是这张图的横轴刻度，
 * 跨请求合并会把两次请求的内容画成一块；变量片段在 User 轨道上自带一档颜色，把它与前后的普通
 * User 内容并成一块会让那一档颜色整块消失——读图的人看到的是「这条请求没有变量」，而不是
 * 「变量太薄」。相邻的不同变量之间照旧合并：它们本来就是同一档颜色，硬按具体变量身份分开只会
 * 让每一个都薄到看不见，而丢掉的「这一块里是哪几个变量」与丢掉「有几条证据」是同一层细节。
 * 输入按左边界升序、同一条请求的分段相邻给出。
 */
export function groupModelRequestCompositionSegments(
  segments: readonly {
    readonly left: number
    readonly width: number
    readonly requestId?: string
    readonly variableId?: string
  }[],
  minWidth: number,
): ModelRequestCompositionSegmentGroup[] {
  const groups: ModelRequestCompositionSegmentGroup[] = []
  for (const [index, segment] of segments.entries()) {
    const open = groups.at(-1)
    const head = open ? segments[open.from]! : undefined
    // 只要当前这一块还没够宽就继续吞下一段；够宽之后另起一块，宽分段因此不会被并进来。
    if (open && head && open.to === index && open.width < minWidth
      && head.requestId === segment.requestId
      && Boolean(head.variableId) === Boolean(segment.variableId)) {
      open.to = index + 1
      open.width = Math.max(segment.left + segment.width - open.left, open.width)
      continue
    }
    groups.push({ from: index, to: index + 1, left: segment.left, width: segment.width })
  }
  return groups
}

/**
 * 一条请求的时间槽至少多宽，单位同样是占整条轴的百分比。
 *
 * 只按真实耗时铺开时，一次十秒的请求在跨越二十小时的会话里不到千分之一，连一个像素都画不出，
 * 那一格里的组成因此完全读不到。这个下限保证每条请求都还留有一格可读的位置；代价是宽度在
 * 下限处不再等于真实耗时，位置仍然是真实的。
 */
export const MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH = 0.75

/** 轨道横向缩放的上下界与步长。粒度判据要按最大倍率算，因此上界与判据同住一处。 */
export const MODEL_REQUEST_COMPOSITION_ZOOM_MIN = 1
export const MODEL_REQUEST_COMPOSITION_ZOOM_MAX = 10
export const MODEL_REQUEST_COMPOSITION_ZOOM_STEP = 0.25

/** 判定粒度所需的每个请求一格：它在时间轴上占多宽，逐段粒度下会画出多少段。 */
export interface ModelRequestCompositionSlot {
  /** 按实际耗时布局时该请求占整条轴的比例（0~1）。进行中的请求没有跨度，取 0。 */
  timeShare: number
  /** 逐段粒度下该请求会画出的分段数。 */
  segmentCount: number
}

/** 一条请求在时间轴上的自然位置，两项都是占整条轴的百分比。 */
export interface ModelRequestCompositionSlotSpan {
  /** 自然起点：按实际耗时布局时由开始时刻求得，按次序均分时由序号求得。 */
  start: number
  /** 自然宽度。进行中的请求跨度未知，取 0——它只在轴上标出起点，不占可读的宽度。 */
  span: number
}

/** 一条请求实际铺到的那一格。 */
export interface ModelRequestCompositionSlotBox {
  left: number
  width: number
}

/**
 * 把每条请求的自然位置铺成互不重叠的时间槽。
 *
 * 最小宽度必然带来重叠：两条相隔九秒的请求在跨越二十小时的会话里自然起点只差万分之一，
 * 而各自都要占到下限那么宽，于是两格画在同一段横轴上。默认倍率下它只是一条 0.75% 宽的糊涂
 * 细线，看不出问题；一旦放大到那一格，两三条请求的组成就完整地叠在一起——一条请求的 Tool Defs
 * 横穿另一条请求的 Assistant，读出来的占比毫无意义。轨道支持放大到单条请求之后，这个重叠
 * 从看不见的糊涂变成了首屏就能看到的错。
 *
 * 因此这里做一次单向扫描：每格的起点不早于前一格的终点，并为后面每一格各留出一份下限宽度，
 * 否则末尾几格会被挤到轴外。挤不开时下限自己让步（退到均分宽），因此无论多少条请求，结果都是
 * 一份落在 [0, 100] 内、按输入顺序单调递增且互不重叠的划分。
 *
 * 输入按时间先后给出，扫描因此不改变请求的先后；跨度为 0 的请求不占位也不推进扫描位置。
 */
export function layoutModelRequestCompositionSlots(
  spans: readonly ModelRequestCompositionSlotSpan[],
  minWidth: number = MODEL_REQUEST_COMPOSITION_MIN_SLOT_WIDTH,
): ModelRequestCompositionSlotBox[] {
  const sizable = spans.reduce((count, { span }) => span > 0 ? count + 1 : count, 0)
  const floor = sizable ? Math.min(minWidth, 100 / sizable) : minWidth
  let pendingFloors = sizable
  let cursor = 0
  return spans.map(({ start, span }) => {
    if (span <= 0) return { left: Math.min(Math.max(start, cursor), 100), width: 0 }
    pendingFloors -= 1
    const reserved = pendingFloors * floor
    const left = Math.min(Math.max(start, cursor), Math.max(100 - reserved - floor, 0))
    const width = Math.min(Math.max(span, floor), Math.max(100 - reserved - left, 0))
    cursor = left + width
    return { left, width }
  })
}

/** 一条分段在自己那一格里占的位置，三项都相对那一格。 */
export interface ModelRequestCompositionSegmentShare {
  /** 格内起点，占该格的百分比。 */
  start: number
  /** 格内宽度，占该格的百分比。 */
  span: number
  /** 右侧还有分段时留间隙；一格的最后一段贴住格的右边界。 */
  gapAfter: boolean
}

/**
 * 把一条分段铺进它所在的那一格。
 *
 * 单请求视图传入整条轴那一格，会话视图传入这条请求的时间槽，因此两种模式的间隙与下限完全同源。
 * 除了扣间隙，这里只做一次线性映射：同一份格内占比换算到任意一格，得到的都是同一份几何按格宽
 * 缩放的结果，焦点窗口把一格拉到全宽后读出来的正是单请求视图里的那条轨道。
 */
export function layoutModelRequestCompositionSegment(
  slot: ModelRequestCompositionSlotBox,
  share: ModelRequestCompositionSegmentShare,
): ModelRequestCompositionSlotBox {
  const left = slot.left + (share.start / 100) * slot.width
  const rawWidth = (share.span / 100) * slot.width
  const gap = share.gapAfter
    ? Math.min((MODEL_REQUEST_COMPOSITION_SEGMENT_GAP / 100) * slot.width, rawWidth * SEGMENT_GAP_MAX_SHARE)
    : 0
  const target = Math.max(rawWidth - gap, 0)
  // 下限只兜「扣完间隙仍然薄到看不见」，绝不把刚扣出来的间隙填回去：一格里的分段绝大多数都薄于
  // 下限，按未扣的占比兜下限等于让间隙在会话轨道上全程失效，同一条请求的几档因此糊成一条实心条。
  // 真实占比本来就低于下限时按真实占比画成发丝线——看不清是事实本身，粒度判据会在挤不开时聚合。
  const floor = Math.min(target, MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_WIDTH)
  const available = Math.max(slot.left + slot.width - left, 0)
  return { left, width: Math.min(target, Math.max(available, floor)) }
}

/**
 * 会话组成图该按逐段还是按聚合下发。
 *
 * 判据是几何而不是记录条数：一个请求的分段能不能看清，取决于它的时间槽有多宽、槽里要塞几段。
 * 两种横轴布局都算一遍并取宽的那个——按实际耗时铺开时槽宽由耗时决定，按次序均分时每格恒为
 * `1/请求数`，用户随时可以切换，只按其中一种判会让另一种布局白白丢掉细节。
 *
 * 时间槽占比先按总量归一：几条请求的跨度重叠时占比之和会超过整条轴，各自都以为独占全宽，
 * 归一后重叠的那几条一起退回均分宽度，也就是它们真正能分到的空间。
 *
 * 宽度按最大缩放倍率折算，因此「放大就能看清」的会话仍然按逐段下发：只有连拉到最大倍率
 * 都挤不开的会话才聚合，聚合因此不会拿走用户本来够得到的细节。
 */
export function resolveModelRequestCompositionGranularity(
  slots: readonly ModelRequestCompositionSlot[],
): SandboxModelRequestPromptCompositionGranularity {
  if (!slots.length) return 'evidence'
  const evenShare = 1 / slots.length
  const totalShare = slots.reduce((sum, slot) => sum + Math.max(slot.timeShare, 0), 0)
  const scale = totalShare > 1 ? 1 / totalShare : 1
  const legible = slots.every((slot) => {
    if (slot.segmentCount <= 0) return true
    const share = Math.max(Math.max(slot.timeShare, 0) * scale, evenShare)
    const widest = share * 100 * MODEL_REQUEST_COMPOSITION_ZOOM_MAX / slot.segmentCount
    return widest >= MODEL_REQUEST_COMPOSITION_MIN_SEGMENT_WIDTH
  })
  return legible ? 'evidence' : 'aggregate'
}

/**
 * 把逐段组成项折成「每请求 × 每种类」一段。
 *
 * 字符数只做加总，不重新度量：聚合段的占比因此与逐段粒度下同一档的占比之和完全相等，
 * 切换粒度不会让同一条会话的轨道厚度发生变化。变量片段在逐段粒度下已经带着 User 种类，
 * 折叠后自然并入 User 档，两种粒度的种类归属因此也一致。
 */
export function aggregateModelRequestComposition(
  items: readonly SandboxModelRequestPromptCompositionItem[],
): SandboxModelRequestPromptCompositionItem[] {
  const byRequest = new Map<string, Map<SandboxModelRequestPromptKind, { characters: number, segmentCount: number }>>()
  const order: string[] = []
  for (const item of items) {
    const requestId = item.requestId ?? ''
    let kinds = byRequest.get(requestId)
    if (!kinds) {
      kinds = new Map()
      byRequest.set(requestId, kinds)
      order.push(requestId)
    }
    const bucket = kinds.get(item.kind) ?? { characters: 0, segmentCount: 0 }
    bucket.characters += item.characters
    bucket.segmentCount += 1
    kinds.set(item.kind, bucket)
  }

  const aggregated: SandboxModelRequestPromptCompositionItem[] = []
  for (const requestId of order) {
    const kinds = byRequest.get(requestId)!
    for (const kind of MODEL_REQUEST_COMPOSITION_KINDS) {
      const bucket = kinds.get(kind)
      if (!bucket || bucket.characters <= 0) continue
      aggregated.push({
        kind,
        characters: bucket.characters,
        segmentCount: bucket.segmentCount,
        ...(requestId ? { requestId } : {}),
      })
    }
  }
  return aggregated
}

/**
 * 某种轨迹行落在组成图的哪条轨道上。
 *
 * 服务端聚合段没有单一证据身份，因此「当前选中的行属不属于这一段」只能按请求加轨道判断。
 * 请求边界与模型响应不进请求体统计，两者都返回缺省。
 */
export function modelRequestCompositionKindOf(
  kind: SandboxModelRequestTrajectoryKind,
): SandboxModelRequestPromptKind | undefined {
  if (kind === 'system' || kind === 'assistant' || kind === 'tool-definition') return kind
  // 模型请求变量在组成图中统一投影到 User 轨道，与逐段粒度的切分口径一致。
  if (kind === 'user' || kind === 'variable') return 'user'
  if (kind === 'tool-call' || kind === 'tool-result') return 'tool-interaction'
  return undefined
}

/**
 * 画出来的一块分段的身份：它落在哪条轨道、属于哪条请求、覆盖了哪几条证据。
 *
 * 三种块的证据身份各不相同。逐段分段就是那一条证据；几何合成块是按当前像素并起来的，
 * 合了哪几条是已知的，因此列出清单；服务端聚合段在下发之前就把身份折掉了，两项都缺省。
 */
export interface ModelRequestCompositionSegmentIdentity {
  kind: SandboxModelRequestPromptKind
  requestId?: string
  /** 这一块自己就是那一条证据。 */
  evidenceId?: string
  /** 这一块合了哪几条证据；给出时以它为准，`evidenceId` 只是其中的落点。 */
  evidenceIds?: readonly string[]
}

/** 组成图当前的选中态：账本里选中的那一行，或分析视图里的一次定位信号。 */
export interface ModelRequestCompositionSelection {
  /** 选中的那条证据。请求边界行没有模型证据，回落到第一条卡片的定位信号也没有。 */
  evidenceId?: string
  requestId?: string
  /** 选中行的种类，`request` 表示选中的是整条请求。定位信号不带种类。 */
  kind?: SandboxModelRequestTrajectoryKind
}

/**
 * 一块分段要不要画成选中。
 *
 * 有证据身份的块按成员判定，合成块也走这一条：合并只是把挤不开的相邻分段画成一块，
 * 「选中的那条证据在不在这一块里」仍然回答得出来。借用聚合段的「请求 + 轨道」判据会让点中
 * 一条证据把同一轨道上所有合成块一起描边——它们各自只覆盖这一档里的几条，不是整档。
 *
 * 只有服务端聚合段无从按身份判：它覆盖那条请求那一档的全部证据，因此按请求加轨道判，
 * 选中请求边界行时整条请求的各档一起亮起——点聚合段选中的正是这一行，只按轨道判会让刚点过的
 * 那一块没有任何反馈。
 *
 * 请求身份必须先对上：一次会话里第 N 条请求的请求体含前 N 轮历史，同一条证据身份会在每条请求
 * 里各出现一次，不比请求就会让一次选中点亮整段会话里的同名分段。
 */
export function isModelRequestCompositionSegmentSelected(
  segment: ModelRequestCompositionSegmentIdentity,
  selection: ModelRequestCompositionSelection | undefined,
): boolean {
  if (!selection) return false
  if (segment.requestId && selection.requestId !== segment.requestId) return false
  const covered = segment.evidenceIds ?? (segment.evidenceId ? [segment.evidenceId] : undefined)
  if (covered) return selection.evidenceId ? covered.includes(selection.evidenceId) : false
  if (!segment.requestId) return false
  if (selection.kind === 'request') return true
  return selection.kind !== undefined && modelRequestCompositionKindOf(selection.kind) === segment.kind
}

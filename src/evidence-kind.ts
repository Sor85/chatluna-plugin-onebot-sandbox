/**
 * 证据种类：模型请求证据的最细一档分类，以及它在两种排版语境下的展示标签。
 *
 * 分类与标签由本 module 独占。轨迹账本的种类列、证据种类过滤开关、请求组成图的图例与分段、
 * 分析导航的分组标题全部从这里取值；任何一侧再自己列一张标签表，同一种证据就会在同屏出现两种说法。
 *
 * 本 module 是浏览器安全的纯 module：不依赖 Node、Koishi、Vue 或 DOM，
 * 因此服务端轨迹派生与客户端视图共用同一实现，与共享模型证据投影同一形状。
 * 它只描述「一条证据属于哪一类、这一类怎么显示」，不描述任何证据数据、DOM、排序或交互状态。
 */

/**
 * 基础证据种类，取最细一档，与领域词汇表的证据词条一一对应。
 *
 * 请求边界不在其中：它是「一次模型请求从这里开始」的结构标记而不是证据，
 * 隐藏全部证据种类后仍要能看出有哪些请求，因此它的标签留在轨迹账本这一侧。
 */
export type SandboxEvidenceKind =
  | 'system'
  | 'user'
  | 'assistant'
  | 'variable'
  | 'tool-definition'
  | 'tool-call'
  | 'tool-result'
  | 'response'

/**
 * 具名聚合：多档粒度都从基础种类派生。
 *
 * - `tool-interaction`：请求组成图使用。它按字符占比统计，而工具调用与工具结果在请求消息里成对出现，合并统计才有意义。
 * - `tool`：分析导航使用。分组标题下要挂多个条目，因此三种工具证据收在一个分组里。
 */
export type SandboxEvidenceAggregateId = 'tool-interaction' | 'tool'

/** 展示标签的两个变体，按排版语境区分，成对声明因此不会各自漂移。 */
export interface SandboxEvidenceLabels {
  /** 徽标语境：有背景色、内边距与固定高度的种类标记，全大写。 */
  badge: string
  /** 标题与图例语境：分组标题、轨道图例，词首大写。 */
  title: string
}

const EVIDENCE_KIND_LABELS = {
  system: { badge: 'SYSTEM', title: 'System' },
  user: { badge: 'USER', title: 'User' },
  assistant: { badge: 'ASSISTANT', title: 'Assistant' },
  variable: { badge: 'VARIABLE', title: 'Variable' },
  'tool-definition': { badge: 'TOOL DEFS', title: 'Tool Defs' },
  'tool-call': { badge: 'TOOL CALL', title: 'Tool Call' },
  'tool-result': { badge: 'TOOL RESULT', title: 'Tool Result' },
  response: { badge: 'RESPONSE', title: 'Response' },
} as const satisfies Record<SandboxEvidenceKind, SandboxEvidenceLabels>

const EVIDENCE_AGGREGATE_MEMBERS = {
  'tool-interaction': Object.freeze(['tool-call', 'tool-result'] as const),
  tool: Object.freeze(['tool-definition', 'tool-call', 'tool-result'] as const),
} satisfies Record<SandboxEvidenceAggregateId, readonly SandboxEvidenceKind[]>

const EVIDENCE_AGGREGATE_LABELS = {
  'tool-interaction': { badge: 'TOOL I/O', title: 'Tool I/O' },
  tool: { badge: 'TOOL', title: 'Tool' },
} as const satisfies Record<SandboxEvidenceAggregateId, SandboxEvidenceLabels>

/** 基础证据种类的全集，按视图里从上到下、从左到右的既有阅读顺序声明。 */
export const SANDBOX_EVIDENCE_KINDS = Object.freeze(
  Object.keys(EVIDENCE_KIND_LABELS) as SandboxEvidenceKind[],
) as readonly SandboxEvidenceKind[]

export const SANDBOX_EVIDENCE_AGGREGATE_IDS = Object.freeze(
  Object.keys(EVIDENCE_AGGREGATE_MEMBERS) as SandboxEvidenceAggregateId[],
) as readonly SandboxEvidenceAggregateId[]

/** 某个聚合的成员种类，用于让「取子集还是取聚合」在类型上也是显式选择。 */
export type SandboxEvidenceAggregateMemberKind<Id extends SandboxEvidenceAggregateId> =
  typeof EVIDENCE_AGGREGATE_MEMBERS[Id][number]

export interface SandboxEvidenceAggregate<Id extends SandboxEvidenceAggregateId = SandboxEvidenceAggregateId> {
  id: Id
  members: readonly SandboxEvidenceAggregateMemberKind<Id>[]
  labels: SandboxEvidenceLabels
}

/**
 * 取展示标签。基础种类与聚合走同一个入口，因此视图不必自己判断某个取值是不是聚合，
 * 取标签也只需要一个参数。
 */
export function sandboxEvidenceLabels(
  id: SandboxEvidenceKind | SandboxEvidenceAggregateId,
): SandboxEvidenceLabels {
  return isAggregateId(id) ? EVIDENCE_AGGREGATE_LABELS[id] : EVIDENCE_KIND_LABELS[id]
}

/** 取具名聚合。成员显式声明，因此「组成图把工具调用与工具结果算作一类」是可断言的事实。 */
export function sandboxEvidenceAggregate<Id extends SandboxEvidenceAggregateId>(
  id: Id,
): SandboxEvidenceAggregate<Id> {
  return {
    id,
    members: EVIDENCE_AGGREGATE_MEMBERS[id],
    labels: EVIDENCE_AGGREGATE_LABELS[id],
  }
}

export function isSandboxEvidenceAggregateMember<Id extends SandboxEvidenceAggregateId>(
  aggregate: Id,
  kind: SandboxEvidenceKind,
): kind is SandboxEvidenceAggregateMemberKind<Id> {
  return (EVIDENCE_AGGREGATE_MEMBERS[aggregate] as readonly SandboxEvidenceKind[]).includes(kind)
}

/**
 * 请求组成图的种类：四种基础证据种类加工具交互聚合。
 *
 * 工具定义不参与聚合——它是请求前缀里的能力目录，按字符占比独立成轨；
 * 模型请求变量投影到 User 轨道，模型响应不进请求体统计，因此两者都不在这一档里。
 */
export type SandboxEvidenceCompositionKind =
  | Exclude<SandboxEvidenceKind, 'variable' | 'response' | SandboxEvidenceAggregateMemberKind<'tool-interaction'>>
  | 'tool-interaction'

function isAggregateId(
  id: SandboxEvidenceKind | SandboxEvidenceAggregateId,
): id is SandboxEvidenceAggregateId {
  return id in EVIDENCE_AGGREGATE_LABELS
}

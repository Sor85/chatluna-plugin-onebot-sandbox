import {
  SANDBOX_EVIDENCE_KINDS,
  sandboxEvidenceLabels,
  type SandboxEvidenceKind,
} from '../../src/evidence-kind'

/**
 * 模型证据显示过滤。
 *
 * 轨迹账本、分析导航和分析卡片共用同一份过滤定义：种类就是证据种类 module 的基础证据种类本身，
 * 标签也来自那里。任何一侧自己重算一套判定或另列一张标签表，都会让同一条证据在两个视图里
 * 出现和消失得不一致，或者在同屏读出两种说法。
 */
export interface ModelEvidenceFilter {
  hiddenKinds: ReadonlySet<SandboxEvidenceKind>
}

/**
 * 过滤开关暴露的种类：八种基础证据种类里的七种，不含模型响应。
 *
 * 暴露哪个子集是视图决策，与组成图只用聚合后的五档、导航只用聚合后的六档同理。
 * 因此模型响应种类不参与过滤：响应分组不会被 ASSISTANT 之类的开关连带隐藏。
 */
export const MODEL_EVIDENCE_FILTER_KINDS: readonly { kind: SandboxEvidenceKind, label: string }[] =
  SANDBOX_EVIDENCE_KINDS
    .filter(kind => kind !== 'response')
    .map(kind => ({ kind, label: sandboxEvidenceLabels(kind).badge }))

export const EMPTY_MODEL_EVIDENCE_FILTER: ModelEvidenceFilter = {
  hiddenKinds: new Set(),
}

/**
 * 判断一条证据当前是否可见。
 *
 * `kind` 为 undefined 表示这一条不参与种类过滤——请求边界行没有对应的模型证据（它是请求本身），
 * 否则把整条请求过滤掉之后账本会连边界一起消失，看不出还有哪些请求。
 */
export function isEvidenceVisible(
  filter: ModelEvidenceFilter,
  kind: SandboxEvidenceKind | undefined,
): boolean {
  return !(kind !== undefined && filter.hiddenKinds.has(kind))
}

export function isModelEvidenceFilterActive(filter: ModelEvidenceFilter): boolean {
  return filter.hiddenKinds.size > 0
}

/** 无障碍标签用的过滤摘要，说明当前隐藏了什么而不是罗列全部选项。 */
export function modelEvidenceFilterSummary(filter: ModelEvidenceFilter): string {
  if (!isModelEvidenceFilterActive(filter)) return '显示全部证据'
  const kinds = MODEL_EVIDENCE_FILTER_KINDS
    .filter(({ kind }) => filter.hiddenKinds.has(kind))
    .map(({ label }) => label)
  return `已隐藏 ${kinds.join('、')}`
}

/** 切换集合成员，返回新集合，让 Vue 的 ref 能识别变更。 */
export function toggleFilterMember<T>(current: ReadonlySet<T>, member: T): Set<T> {
  const next = new Set(current)
  if (!next.delete(member)) next.add(member)
  return next
}

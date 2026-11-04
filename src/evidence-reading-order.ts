import {
  isSandboxEvidenceAggregateMember,
  type SandboxEvidenceAggregateMemberKind,
  type SandboxEvidenceKind,
} from './evidence-kind'

/**
 * 证据在阅读面上的档位与先后。
 *
 * 分析导航的分组、分析视图右侧的卡片分区、轨迹账本的事件行三处都按这一份顺序铺开。原先三处
 * 各自留一份：导航按种类分组，卡片按请求体原始顺序平铺，账本又按第三套次序排，于是同一条请求
 * 在同一屏里给出三种先后——点导航里的 Assistant 会跳到卡片列表中段，账本里的响应行又排在
 * 请求侧 assistant 行之后。这类错位不报错，只能靠人逐条比对才看得出来。
 *
 * 与证据种类 module 同一形状的浏览器安全纯 module：不依赖 Node、Koishi、Vue 或 DOM，
 * 因此服务端派生账本行与客户端铺卡片共用同一实现。它只描述「哪一档、第几位」，
 * 不描述证据数据、DOM 或交互状态。
 */

/**
 * 阅读面上的档位：三种工具证据收成一档，其余基础种类各自成档。
 *
 * 工具收成一档是因为导航要在一个分组标题下挂多个条目；粒度差异因此是显式选择，
 * 而不是又一套分类词汇。
 */
export type SandboxEvidenceReadingGroup =
  | Exclude<SandboxEvidenceKind, SandboxEvidenceAggregateMemberKind<'tool'>>
  | 'tool'

/**
 * 档位顺序：系统前缀 → 用户消息 → 变量展开 → 模型自己的发言 → 本次响应 → 工具往返与能力目录。
 *
 * Response 排在 Tool 之前而不是末尾：它是这一次请求的产物，读完请求侧发言就该看到它，
 * 而工具结果与能力目录属于下一轮的输入材料。
 */
export const SANDBOX_EVIDENCE_READING_ORDER = Object.freeze([
  'system',
  'user',
  'variable',
  'assistant',
  'response',
  'tool',
]) as readonly SandboxEvidenceReadingGroup[]

export interface SandboxEvidenceReadingInput {
  kind: SandboxEvidenceKind
  /** 响应侧证据整体归 Response 一档，不按 assistant / tool-call / tool-result 拆开。 */
  source?: 'request' | 'response'
  /**
   * 这条证据挂在哪一档上。
   *
   * 工具调用要跟着发起它的那条消息走：它渲染在消息卡片内部，导航也把它列在那条消息之后，
   * 落到 Tool 档会让同一条工具调用在导航里跟着 assistant、在账本里却跑到末尾。
   */
  parent?: SandboxEvidenceReadingGroup
}

export function sandboxEvidenceReadingGroup(input: SandboxEvidenceReadingInput): SandboxEvidenceReadingGroup {
  if (input.source === 'response') return 'response'
  if (input.parent) return input.parent
  return isSandboxEvidenceAggregateMember('tool', input.kind) ? 'tool' : input.kind
}

/** 档位的位次。找不到的档位排在末尾，而不是排到最前面把已知档位顶下去。 */
export function sandboxEvidenceReadingRank(group: SandboxEvidenceReadingGroup): number {
  const rank = SANDBOX_EVIDENCE_READING_ORDER.indexOf(group)
  return rank < 0 ? SANDBOX_EVIDENCE_READING_ORDER.length : rank
}

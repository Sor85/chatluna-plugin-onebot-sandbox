import type { MessageCapabilities } from '../../src/message-capabilities'

/**
 * 多选转发的整个流程：进入、切换、退出、可选性、键盘、以及确认转发到目标会话。
 *
 * 这些判定此前散在聊天区域的 `script` 里，唯一的验证手段是点界面。其中「哪些消息可选」原先
 * 由组件自己按 `!message.event && !isRecalledMessage(message)` 推导——那是消息能力里
 * `forward` 那一位的第二份口径（ADR 0078 明确只许有一份），现在改成读投影给出的能力位。
 */

export interface MessageSelectionState {
  readonly active: boolean
  readonly messageIds: readonly string[]
}

export const NO_MESSAGE_SELECTION: MessageSelectionState = { active: false, messageIds: [] }

/** 可选性只问投影给出的能力位。 */
export interface MessageSelectionContext {
  readonly messageCapabilities: Record<string, MessageCapabilities>
}

/**
 * 这条消息能不能进多选。
 *
 * 投影还没给出这条消息时读作不能——这与右键菜单的口径一致：宁可少给一个动作，也不要提供一个
 * 服务端会拒绝的动作。
 */
export function readForwardCapability(messageId: string, context: MessageSelectionContext): boolean {
  return context.messageCapabilities[messageId]?.forward ?? false
}

/**
 * 从某条消息进入多选，并把它作为默认选中。
 *
 * 不可转发的消息不能作为入口：它进不了选中集合，进入后会得到一个「已选 0 条」的空多选态。
 */
export function enterMessageSelection(
  messageId: string,
  context: MessageSelectionContext,
): MessageSelectionState | undefined {
  if (!readForwardCapability(messageId, context)) return
  return { active: true, messageIds: [messageId] }
}

/**
 * 切换某条消息的选中。
 *
 * 不在多选态时什么都不做——列表在非多选态下不会派发这个动作，但外壳与页面都能派发，
 * 少这道闸门会让一次误派发悄悄改掉选中集合。
 */
export function toggleMessageSelection(
  state: MessageSelectionState,
  messageId: string,
  context: MessageSelectionContext,
): MessageSelectionState {
  if (!state.active || !readForwardCapability(messageId, context)) return state
  if (state.messageIds.includes(messageId)) {
    return { active: true, messageIds: state.messageIds.filter((id) => id !== messageId) }
  }
  return { active: true, messageIds: [...state.messageIds, messageId] }
}

export function exitMessageSelection(): MessageSelectionState {
  return NO_MESSAGE_SELECTION
}

/**
 * 目标会话对话框只在有选中时才该打开：空选中打开它，确认那一步一定失败。
 *
 * 名字避开「can + 动作」的形状：那是架构守卫「客户端不自己判定消息能力」的谓词，
 * 而这里问的是本地选中集合有没有内容，不是消息能力。
 */
export function hasSelectedMessages(state: MessageSelectionState): boolean {
  return state.messageIds.length > 0
}

export type ForwardConfirmation =
  | { readonly kind: 'send', readonly conversationId: string, readonly messageIds: readonly string[] }
  | { readonly kind: 'reject', readonly message: string }

/**
 * 确认转发。
 *
 * 确认那一刻重新按能力位过滤一遍：从进入多选到点确认之间，选中的消息可能已经被撤回，
 * 此时把它一起发出去会被服务端拒掉整批。过滤后为空则本地就拒绝，不发无谓的 RPC。
 */
export function resolveForwardConfirmation(
  state: MessageSelectionState,
  conversationId: string,
  context: MessageSelectionContext,
): ForwardConfirmation {
  const messageIds = state.messageIds.filter((messageId) => readForwardCapability(messageId, context))
  if (!messageIds.length) return { kind: 'reject', message: '请先选择可转发的消息' }
  return { kind: 'send', conversationId, messageIds }
}

export type EscapeAction =
  /** 目标会话对话框开着时先关它，多选态保留。 */
  | { readonly kind: 'close-forward-target' }
  /** 退出多选。 */
  | { readonly kind: 'exit-selection' }
  /** 关闭搜索并把焦点还回入口按钮。 */
  | { readonly kind: 'close-search' }
  | { readonly kind: 'none' }

export interface EscapeContext {
  readonly selectionActive: boolean
  readonly forwardTargetOpen: boolean
  readonly searchOpen: boolean
  /** 日期弹层自己会吃掉 Escape；此时不该连搜索一起关。 */
  readonly searchDatePopoverOpen: boolean
}

/**
 * Escape 的优先级：目标会话对话框 → 多选 → 搜索。
 *
 * 顺序是判定而不是巧合：多选态下开着目标对话框时按 Escape 应该只退回多选，而不是把多选一起
 * 退掉——那样用户选好的一批消息就白选了。
 */
export function routeEscapeKey(context: EscapeContext): EscapeAction {
  if (context.selectionActive) {
    if (context.forwardTargetOpen) return { kind: 'close-forward-target' }
    return { kind: 'exit-selection' }
  }
  if (context.searchOpen && !context.searchDatePopoverOpen) return { kind: 'close-search' }
  return { kind: 'none' }
}

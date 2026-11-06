import type { MessageCapabilities } from '../../src/message-capabilities'

/**
 * 多选转发的整个流程：进入、切换、退出、可选性，以及确认转发到目标会话。
 *
 * 「哪些消息可选」只读投影给出的 `forward` 能力位，不在客户端按事件、撤回状态另行推导：
 * 消息能力只许有一份口径（`src/message-capabilities`），服务端写入时问的是同一份判据。
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

export type ForwardConfirmation =
  | { readonly kind: 'send', readonly conversationId: string, readonly messageIds: readonly string[] }
  | { readonly kind: 'reject' }

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
  if (!messageIds.length) return { kind: 'reject' }
  return { kind: 'send', conversationId, messageIds }
}

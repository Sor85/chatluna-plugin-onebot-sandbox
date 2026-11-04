/** 发送请求完成后，是否应把焦点交回消息输入框。 */
export interface ComposerFocusRestoreContext {
  /** 发起本次发送时的逻辑会话 */
  requestConversationId: string
  /** 发起本次发送时的当前操作者 */
  requestOperatorId: string
  /** 请求完成时仍活跃的逻辑会话 */
  activeConversationId?: string
  /** 请求完成时仍活跃的当前操作者 */
  activeOperatorId?: string
  /** 请求发起时捕获的 composer 实例标识 */
  requestComposerId: symbol
  /** 请求完成时仍挂载的 composer 实例标识 */
  activeComposerId?: symbol
  /**
   * 发起发送时捕获的原输入控件（textarea 或 contenteditable）。
   * 组件卸载或 DOM 替换后 isConnected 为 false，不得再 focus。
   */
  inputElement?: HTMLElement | null
}

/**
 * 判断一次异步发送结束后是否应恢复输入焦点。
 *
 * 只在“原 composer + 原会话 + 原操作者 + 原输入控件仍挂载有效”时返回 true，
 * 避免切换会话/操作者或卸载后的旧请求抢焦点。
 */
export function shouldRestoreComposerFocus(context: ComposerFocusRestoreContext): boolean {
  const {
    inputElement,
    requestComposerId,
    activeComposerId,
    requestConversationId,
    requestOperatorId,
    activeConversationId,
    activeOperatorId,
  } = context
  if (!inputElement || !inputElement.isConnected) return false
  if (activeComposerId !== requestComposerId) return false
  if (!requestConversationId || !requestOperatorId) return false
  if (activeConversationId !== requestConversationId) return false
  if (activeOperatorId !== requestOperatorId) return false
  return true
}

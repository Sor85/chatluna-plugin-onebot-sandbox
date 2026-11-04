/** 引用跳转与聊天记录搜索共用的消息定位/高亮工具。 */

export const MESSAGE_HIGHLIGHT_MS = 1400

export function findMessageElement(messageId: string, root: ParentNode = document): HTMLElement | null {
  if (!messageId) return null
  // messageId 由沙盒生成，不含引号；仍做属性选择器转义，避免特殊字符打断 querySelector。
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(messageId)
    : messageId.replace(/["\\]/g, '\\$&')
  return root.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`)
}

export function scrollMessageIntoView(element: HTMLElement) {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

export function highlightMessageElement(input: {
  messageId: string
  root?: ParentNode
  onHighlight: (messageId: string) => void
  onClear: () => void
  clearTimer?: ReturnType<typeof setTimeout>
  highlightMs?: number
}): { highlighted: boolean, clearTimer?: ReturnType<typeof setTimeout> } {
  const element = findMessageElement(input.messageId, input.root ?? document)
  if (!element) return { highlighted: false, clearTimer: input.clearTimer }

  scrollMessageIntoView(element)
  input.onHighlight(input.messageId)
  if (input.clearTimer) clearTimeout(input.clearTimer)
  const clearTimer = setTimeout(() => {
    input.onClear()
  }, input.highlightMs ?? MESSAGE_HIGHLIGHT_MS)
  return { highlighted: true, clearTimer }
}

/**
 * 若消息尚未进入当前列表，循环加载更早历史直到出现或无法继续。
 * 用最旧消息锚点检测“加载无进展”，避免 hasMore 与服务端不一致时死循环。
 */
export async function ensureMessageLoaded(input: {
  messageId: string
  isLoaded: () => boolean
  canLoadMore: () => boolean
  loadMore: () => Promise<void>
  getOldestLoadedMessageId?: () => string | undefined
  maxAttempts?: number
}): Promise<boolean> {
  if (input.isLoaded()) return true

  let attempts = 0
  const maxAttempts = input.maxAttempts ?? 40
  let previousAnchor = input.getOldestLoadedMessageId?.()

  while (!input.isLoaded() && input.canLoadMore() && attempts < maxAttempts) {
    attempts += 1
    await input.loadMore()
    if (input.isLoaded()) return true
    const nextAnchor = input.getOldestLoadedMessageId?.()
    if (input.getOldestLoadedMessageId && nextAnchor === previousAnchor) {
      return false
    }
    previousAnchor = nextAnchor
  }

  return input.isLoaded()
}

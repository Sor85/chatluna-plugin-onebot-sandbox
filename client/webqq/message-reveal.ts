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

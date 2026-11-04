import { isMessageListNearBottom, scrollMessageListToBottom } from './message-list-scroll'

export interface MessageListScrollBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface MessageListFollowAdapter {
  getBox(): MessageListScrollBox | undefined
  nextTick(): Promise<void>
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(id: number): void
}

export function createMessageListFollowController(adapter: MessageListFollowAdapter) {
  let stickingToBottom = true
  let following = false
  let forcing = false
  let userInitiated = false
  let lastScrollHeight = 0
  let scrollFrame = 0
  let settleFrame = 0
  let userIntentFrame = 0

  function cancel() {
    if (scrollFrame) adapter.cancelAnimationFrame(scrollFrame)
    if (settleFrame) adapter.cancelAnimationFrame(settleFrame)
    scrollFrame = 0
    settleFrame = 0
    following = false
    forcing = false
  }

  function rememberHeight(box: MessageListScrollBox) {
    lastScrollHeight = box.scrollHeight
  }

  function handleScroll() {
    const box = adapter.getBox()
    if (!box) return
    const nearBottom = isMessageListNearBottom(box)
    const contentGrew = box.scrollHeight > lastScrollHeight
    rememberHeight(box)

    if (userInitiated) {
      userInitiated = false
      stickingToBottom = nearBottom
      if (!nearBottom) cancel()
      return
    }

    // 内容增高（新消息、思考面板、图片、composer padding）会立刻让距底部超过阈值。
    // Firefox 会在 scrollHeight 变化时派发 scroll，Chrome 的 overflow-anchor 也可能改 scrollTop。
    // 这类滚动不是用户上滑，不能取消置底追踪，否则会出现“有时能跟上、有时掉底”。
    if (following) return

    if (stickingToBottom && contentGrew) {
      void scheduleBottom()
      return
    }

    stickingToBottom = nearBottom
  }

  function handleUserScrollIntent() {
    userInitiated = true
    if (userIntentFrame) adapter.cancelAnimationFrame(userIntentFrame)
    // 贴底时继续向下滚不会产生 scroll；下一帧清掉标记，避免后续布局滚动被误当成用户上滑。
    userIntentFrame = adapter.requestAnimationFrame(() => {
      userIntentFrame = 0
      userInitiated = false
    })
  }

  async function scheduleBottom(force = false) {
    following = true
    forcing ||= force
    if (force) stickingToBottom = true
    await adapter.nextTick()
    if (scrollFrame) adapter.cancelAnimationFrame(scrollFrame)
    if (settleFrame) adapter.cancelAnimationFrame(settleFrame)
    scrollFrame = adapter.requestAnimationFrame(() => {
      scrollFrame = 0
      const box = adapter.getBox()
      if (!box || (!stickingToBottom && !forcing)) {
        following = false
        forcing = false
        return
      }
      scrollMessageListToBottom(box)
      rememberHeight(box)
      settleFrame = adapter.requestAnimationFrame(() => {
        settleFrame = 0
        const settled = adapter.getBox()
        if (settled && (stickingToBottom || forcing)) {
          scrollMessageListToBottom(settled)
          rememberHeight(settled)
        }
        following = false
        forcing = false
      })
    })
  }

  return {
    get stickingToBottom() {
      return stickingToBottom
    },
    get following() {
      return following
    },
    setStickingToBottom(value: boolean) {
      stickingToBottom = value
    },
    handleScroll,
    handleUserScrollIntent,
    scheduleBottom,
    cancel,
  }
}

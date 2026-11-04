import {
  calculateAnchoredMessageListScrollTop,
  type MessageListScrollAnchor,
  type MessageListScrollState,
} from './message-list-scroll-state'

/**
 * 「切回一个会话时滚动位置回到离开时那一行」的四块判定：锚点选取、恢复的三分支、
 * 保存的两条边界、分趟排程。
 *
 * 四块此前全留在视图里。它们改坏了都不会报错，只会静默漂移——回到会话时落在错误的一行、
 * 恢复过程中途的位置把目标覆盖掉、快速来回切换时前一次的排程污染后一次。
 * 判定进这个模块，`scrollTop` 的写入、`querySelectorAll` 与帧调度由参数注入（ADR 0075）。
 */

/** 一条消息行的几何。视图从 `[data-message-id]` 元素映射出来，映射本身是机械动作。 */
export interface ScrollAnchorRow {
  readonly messageId: string
  readonly top: number
  readonly bottom: number
}

/**
 * 锚点选取：取第一个**底缘越过容器顶缘**的那一行。
 *
 * 这是判定不是机械动作。取「顶缘越过」会选到上一行——那一行绝大部分已经滚出视口，恢复后
 * 用户看到的第一行不是离开时看到的那一行；取最后一个越过的会选到视口底部那一行。
 * 一行都没越过（列表为空，或全部滚出视口下方）时不给锚点，恢复退回直写滚动位置。
 */
export function selectMessageListScrollAnchor(
  containerTop: number,
  rows: readonly ScrollAnchorRow[],
): MessageListScrollAnchor | undefined {
  for (const row of rows) {
    if (row.bottom <= containerTop) continue
    return { messageId: row.messageId, offsetTop: row.top - containerTop }
  }
}

export type ScrollRestoreOutcome =
  /** 离开时贴在底部：直接置底，不必找锚点——新消息已经把内容顶长了。 */
  | { readonly kind: 'bottom' }
  /** 有滚动位置但锚点对不上（消息已被保留窗口淘汰）：直写滚动位置，尽量接近。 */
  | { readonly kind: 'scroll-top', readonly scrollTop: number }
  /** 锚点命中：走锚点补偿算术，这一行回到离开时的那个偏移。 */
  | { readonly kind: 'anchored', readonly scrollTop: number }

/**
 * 恢复的三分支。
 *
 * 分支顺序不可颠倒：贴底状态优先，因为贴底时保存的 `scrollTop` 属于旧内容高度，直写会落在
 * 中间；锚点缺失与锚点对不上走同一条退路，因为两者都无从补偿。
 */
export function resolveMessageListScrollRestore(input: {
  readonly state: MessageListScrollState
  readonly containerTop: number
  readonly currentScrollTop: number
  readonly rows: readonly ScrollAnchorRow[]
}): ScrollRestoreOutcome {
  const { state } = input
  if (state.stickingToBottom) return { kind: 'bottom' }

  const anchor = state.anchor
  const row = anchor && input.rows.find(({ messageId }) => messageId === anchor.messageId)
  if (!anchor || !row) return { kind: 'scroll-top', scrollTop: state.scrollTop }

  return {
    kind: 'anchored',
    scrollTop: calculateAnchoredMessageListScrollTop({
      currentScrollTop: input.currentScrollTop,
      currentAnchorTop: row.top,
      containerTop: input.containerTop,
      savedAnchorOffsetTop: anchor.offsetTop,
    }),
  }
}

/**
 * 保存的两条边界。
 *
 * - **预览态直接短路。** 缩略图里的消息列表不是用户在读的那一份，让它写状态会把真实位置覆盖掉。
 * - **正在恢复时写回待恢复状态，而不是当前 DOM 读数。** 恢复分两趟施加，中途读到的是一个
 *   还没走完的位置；把它写回去等于用中间态覆盖目标，表现为「切回来位置差一点」。
 *   这一条此前只是一句注释。
 */
export function resolveMessageListScrollSave(input: {
  readonly preview: boolean
  readonly restoring?: MessageListScrollState
  readonly box?: { readonly scrollTop: number }
  readonly stickingToBottom: boolean
  readonly containerTop: number
  readonly rows: readonly ScrollAnchorRow[]
}): MessageListScrollState | undefined {
  if (input.preview) return
  if (input.restoring) return input.restoring
  if (!input.box) return

  return {
    scrollTop: input.box.scrollTop,
    stickingToBottom: input.stickingToBottom,
    anchor: input.stickingToBottom
      ? undefined
      : selectMessageListScrollAnchor(input.containerTop, input.rows),
  }
}

export interface ScrollRestoreScheduleAdapter {
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(id: number): void
  /** 把一趟恢复施加到 DOM 上。 */
  apply(state: MessageListScrollState): void
  /** 当前活动的状态键。每一趟施加前都要重新问，陈旧排程据此丢弃。 */
  getActiveKey(): string | undefined
}

/**
 * 分趟排程。
 *
 * 恢复分两趟施加：第一趟之后媒体与思考面板可能继续增高，位置会再漂一点，第二趟把它补齐。
 * 每一趟施加前重新校验当前会话键是否仍是排程时的那个——快速来回切换时前一次的排程必须
 * 不能污染后一次，否则会把 A 会话的位置施加到 B 会话上。
 */
export function createMessageListScrollRestoreScheduler(adapter: ScrollRestoreScheduleAdapter) {
  let restoring: MessageListScrollState | undefined
  let frame = 0
  let settleFrame = 0

  function cancelFrames() {
    if (frame) adapter.cancelAnimationFrame(frame)
    if (settleFrame) adapter.cancelAnimationFrame(settleFrame)
    frame = 0
    settleFrame = 0
  }

  /** 开始一次恢复：记下待恢复状态，让保存路径知道该写回它而不是当前读数。 */
  function begin(state: MessageListScrollState) {
    restoring = state
  }

  function schedule(key: string | undefined) {
    if (!restoring) return
    cancelFrames()
    frame = adapter.requestAnimationFrame(() => {
      frame = 0
      if (!restoring || adapter.getActiveKey() !== key) return
      adapter.apply(restoring)
      settleFrame = adapter.requestAnimationFrame(() => {
        settleFrame = 0
        if (!restoring || adapter.getActiveKey() !== key) return
        adapter.apply(restoring)
      })
    })
  }

  /** 结束恢复：用户一碰列表就该交回控制权，后续保存写的是真实读数。 */
  function finish() {
    restoring = undefined
    cancelFrames()
  }

  return {
    get restoring() {
      return restoring
    },
    begin,
    schedule,
    finish,
  }
}

/**
 * 定位揭示的编排：先停掉贴底追踪，再滚到那一行并高亮。
 *
 * 顺序是判定。反过来的话平滑滚动到目标的过程会和贴底排程抢 `scrollTop`，表现为「跳过去
 * 又被拽回底部」。高亮本身（滚入视口、按时超时清理）已经是模块，这里只管这个顺序。
 */
export function revealMessageListMessage(input: {
  readonly stopFollowing: () => void
  readonly highlight: () => boolean
}): boolean {
  input.stopFollowing()
  return input.highlight()
}

import {
  selectMessageListScrollAnchor,
  type ScrollAnchorRow,
} from './message-list-scroll-restore'
import type { MessageListScrollState } from './message-list-scroll-state'

/**
 * 加载更早历史：闸门、外发事件的拒绝，以及「当前这一行不跳走」的补偿。
 *
 * 补偿是这里的正题。更早的消息插在当前这一行**上方**，内容整体下移，而浏览器保留原来的
 * `scrollTop`（列表显式关掉了 `overflow-anchor`），于是用户读的那一行被推到视口下方。
 *
 * 补偿不自己写 `scrollTop`，而是把目标交给**恢复排程**：新插进来的消息里有媒体与思考面板，
 * 它们在 Vue 更新之后还会继续增高，一次性写死的位置会落在半路。恢复排程分趟施加、并在容器
 * 尺寸变化时重排，正是为这件事准备的。
 */

/** 一次几何读数：容器顶缘、当前滚动位置与全部消息行。视图从 DOM 映射出来。 */
export interface MessageListGeometry {
  readonly containerTop: number
  readonly scrollTop: number
  readonly rows: readonly ScrollAnchorRow[]
}

export interface MessageListHistoryLoadAdapter {
  isLoading(): boolean
  setLoading(loading: boolean): void
  /** 用户此刻是否贴在底部。贴底时不补偿：底部才是他在读的地方。 */
  isStickingToBottom(): boolean
  /** 读一次几何；容器还没挂上时给 undefined。 */
  readGeometry(): MessageListGeometry | undefined
  /** 向外发起加载更早历史，拒绝在本模块内吞掉。 */
  requestHistory(): Promise<void>
  /** 把补偿目标交给恢复排程，由它分趟施加锚点算术。 */
  restoreAnchored(state: MessageListScrollState): void
}

export async function loadEarlierMessageListHistory(
  adapter: MessageListHistoryLoadAdapter,
): Promise<void> {
  // 闸门：一趟没结束前再点一次不该发第二次请求，否则会连着插两批消息。
  if (adapter.isLoading()) return
  adapter.setLoading(true)

  // 锚点必须在加载前读：加载后这一行的位置已经被新内容推走了。
  const before = adapter.isStickingToBottom() ? undefined : adapter.readGeometry()
  const anchor = before && selectMessageListScrollAnchor(before.containerTop, before.rows)

  try {
    await adapter.requestHistory()
  } catch {
    // 页面控制层负责展示具体错误；列表只需要结束加载态，避免事件 Promise 泄漏为未处理拒绝。
    return
  } finally {
    adapter.setLoading(false)
  }

  // 贴底、空列表、加载失败三种情形都不补偿：前者由贴底追踪把位置补到底部，后两者没有「当前这一行」。
  if (!before || !anchor) return
  adapter.restoreAnchored({
    scrollTop: before.scrollTop,
    // 贴底与锚点补偿互斥：置底会把用户拽到最新消息，正是这里要避免的。
    stickingToBottom: false,
    anchor,
  })
}

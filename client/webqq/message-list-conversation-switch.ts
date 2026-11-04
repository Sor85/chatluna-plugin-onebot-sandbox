/**
 * 会话切换那一刻的动作顺序，以及容器尺寸变化时的二选一。
 *
 * 两件事此前写死在三个 watch 与一个 `ResizeObserver` 回调里，都属于「改坏了不报错、只静默
 * 漂移」的判定：顺序错一步表现为「切回去位置不对」或「新消息不再自动跟随」，尺寸变化选错分支
 * 表现为「切回会话后被弹到底部」。判定进这个模块，DOM 与观察器由参数注入（ADR 0075）。
 */

export interface MessageListConversationSwitchAdapter {
  /** 存下旧会话的滚动状态。 */
  saveScrollState(key: string): void
  /** 结束进行中的恢复，交回滚动控制权。 */
  finishRestore(): void
  /** 取消贴底追踪。 */
  cancelFollow(): void
  /** 换成新会话的状态键。此后所有排程都按这个键校验。 */
  adoptKey(key: string | undefined): void
  /** 恢复新会话的滚动状态；返回 false 表示没有可恢复的状态。 */
  restoreScrollState(key: string | undefined): boolean
  /** 贴底并置底。 */
  stickToBottom(): void
}

/**
 * 切换的五步顺序：存旧 → 结束恢复 → 取消追踪 → 换键 → 恢复或置底。
 *
 * 三条顺序约束都不会以报错的形式表现出来：
 * - **存旧在结束恢复之前**：恢复中保存的是待恢复状态，先结束恢复会让它写回一个中间读数。
 * - **换键在恢复之前**：恢复分趟排程，每趟施加前重新问当前活动键；键没换过来就排程，
 *   等于让这一趟按旧键校验，前一次的排程会施加到新会话上。
 * - **置底只在恢复不到状态时兜底**：反过来会把刚恢复好的位置又拽到底部。
 */
export function switchMessageListConversation(
  input: {
    readonly preview: boolean
    readonly previousKey: string | undefined
    readonly nextKey: string | undefined
  },
  adapter: MessageListConversationSwitchAdapter,
): void {
  // 缩略图里的消息列表不是用户在读的那一份，整条编排都不跑。
  if (input.preview) return

  if (input.previousKey) adapter.saveScrollState(input.previousKey)
  adapter.finishRestore()
  adapter.cancelFollow()
  adapter.adoptKey(input.nextKey)

  if (adapter.restoreScrollState(input.nextKey)) return
  // 没有新键意味着当前没有会话，置底无从落脚，还会把状态写成贴底。
  if (!input.nextKey) return
  adapter.stickToBottom()
}

export type MessageListContentResizeAction =
  /** 恢复中：补的是恢复目标，而不是底部。 */
  | { readonly kind: 'reschedule-restore' }
  /** 用户本来就贴在底部：把新增的高度补到底。 */
  | { readonly kind: 'stick-to-bottom' }
  | { readonly kind: 'none' }

/**
 * 容器尺寸变化时的二选一。
 *
 * 新消息里的媒体与思考面板会在 Vue 更新之后继续增高，因此尺寸变化时要补一次位置。
 * 恢复优先于贴底：恢复过程中读到的贴底标记来自待恢复状态，据它置底会把恢复目标覆盖掉。
 */
export function routeMessageListContentResize(input: {
  readonly restoring: boolean
  readonly stickingToBottom: boolean
}): MessageListContentResizeAction {
  if (input.restoring) return { kind: 'reschedule-restore' }
  if (input.stickingToBottom) return { kind: 'stick-to-bottom' }
  return { kind: 'none' }
}

/** 观察器的最小结构接口。`ResizeObserver` 天然满足，测试用内存替身。 */
export interface MessageListResizeObserverLike {
  observe(target: object): void
  disconnect(): void
}

export interface MessageListContentResizeAdapter {
  /** 造一个观察器；宿主没有 `ResizeObserver` 时返回 undefined。 */
  createObserver(callback: () => void): MessageListResizeObserverLike | undefined
  /** 观察器报出尺寸变化。处置由调用方按 `routeMessageListContentResize` 决定。 */
  onResize(): void
}

/**
 * 观察器的建立与断开。
 *
 * 每次重新绑定都先断开上一个：容器与内容列表的引用会随会话切换与空会话切换而变，漏掉断开
 * 会留下两个都在报尺寸的观察器，表现为「置底补了两遍」这类抖动。
 */
export function createMessageListContentResizeBinding(adapter: MessageListContentResizeAdapter) {
  let observer: MessageListResizeObserverLike | undefined

  function disconnect() {
    observer?.disconnect()
    observer = undefined
  }

  function bind(input: {
    readonly preview: boolean
    readonly box?: object
    readonly content?: object
  }) {
    disconnect()
    if (input.preview || !input.box) return
    observer = adapter.createObserver(() => adapter.onResize())
    if (!observer) return
    observer.observe(input.box)
    // 空会话下内容列表不渲染；只观察容器仍然有意义，窗口尺寸变化照样要补位置。
    if (input.content) observer.observe(input.content)
  }

  return { bind, disconnect }
}

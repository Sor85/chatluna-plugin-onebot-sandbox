export const MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS = 2000
/** 轮询单次最多重取多少条。上限存在的理由是读放大：翻了十页之后每 2 秒重取一次全部记录。 */
export const MODEL_REQUEST_REFRESH_LIMIT_MAX = 200

/**
 * 是否还有进行中的请求。进行中意味着状态、耗时和响应体都还会变，
 * 详情也算：用户可能正停在一条刚发出的请求上，而它还没进列表首屏。
 */
export function hasPendingModelRequest(
  records: readonly { status: string }[],
  detail?: { status: string },
): boolean {
  return records.some(({ status }) => status === 'pending') || detail?.status === 'pending'
}

/**
 * 手动开关与进行中请求是并联条件，不是二选一：开关关着但有请求在跑时必须自己转起来，
 * 否则用户要手点刷新才能看到刚发出的请求变成已完成；反之开关开着就算全部完成也要继续
 * 轮询，因为随时可能有新请求进来。可见性判定不在这里——那是控制器的停表条件。
 */
export function shouldPollModelRequests(input: {
  manualSwitch: boolean
  hasPendingRequest: boolean
}): boolean {
  return input.manualSwitch || input.hasPendingRequest
}

/**
 * 一次轮询要重取多少条：至少一页，至多把已经加载出来的都覆盖住，再夹到上限。
 * 少取会让已翻出来的记录在刷新后消失，无上限取会让长会话把整张表拉下来。
 */
export function resolveModelRequestRefreshLimit(loadedCount: number, pageSize: number): number {
  return Math.min(Math.max(loadedCount, pageSize), MODEL_REQUEST_REFRESH_LIMIT_MAX)
}

export interface ModelRequestLiveRefreshOptions {
  intervalMs?: number
  isEnabled: () => boolean
  isVisible: () => boolean
  refresh: () => void
  setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>
  clearInterval?: (id: ReturnType<typeof setInterval>) => void
}

// Koishi 控制台用 <keep-alive> 缓存整页，onMounted 与 onActivated 会在首次进入时同拍触发。
// 合并成一次微任务，避免每次打开模型请求页连打两次 Console RPC。
export function createModelRequestEnterRefresh(refresh: () => void) {
  let queued = false

  function schedule() {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      refresh()
    })
  }

  return { schedule }
}

// 页面隐藏或离开视图时必须停表：后台继续 2 秒轮询会空耗 Console RPC，
// 也会在用户回来时覆盖正在翻看的分页。可见且开关仍开时再恢复，而不是重新打开开关。
export function createModelRequestLiveRefresh(options: ModelRequestLiveRefreshOptions) {
  const intervalMs = options.intervalMs ?? MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS
  const schedule: NonNullable<ModelRequestLiveRefreshOptions['setInterval']> = options.setInterval
    ?? ((handler, timeout) => globalThis.setInterval(handler, timeout))
  const cancel: NonNullable<ModelRequestLiveRefreshOptions['clearInterval']> = options.clearInterval
    ?? ((id) => globalThis.clearInterval(id))
  let timer: ReturnType<typeof setInterval> | undefined

  function sync() {
    const shouldRun = options.isEnabled() && options.isVisible()
    if (shouldRun && timer === undefined) {
      timer = schedule(() => {
        if (options.isEnabled() && options.isVisible()) options.refresh()
      }, intervalMs)
      return
    }
    if (!shouldRun && timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
  }

  function dispose() {
    if (timer !== undefined) cancel(timer)
    timer = undefined
  }

  function isRunning() {
    return timer !== undefined
  }

  return { sync, dispose, isRunning }
}

import { describe, expect, it } from 'vitest'
import {
  createModelRequestEnterRefresh,
  createModelRequestLiveRefresh,
  hasPendingModelRequest,
  MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS,
  MODEL_REQUEST_REFRESH_LIMIT_MAX,
  resolveModelRequestRefreshLimit,
  shouldPollModelRequests,
} from '../client/model-request/live-refresh'

describe('模型请求自动刷新策略', () => {
  it('列表或详情里有进行中请求就算有进行中请求', () => {
    expect(hasPendingModelRequest([])).toBe(false)
    expect(hasPendingModelRequest([{ status: 'complete' }, { status: 'error' }])).toBe(false)
    expect(hasPendingModelRequest([{ status: 'complete' }, { status: 'pending' }])).toBe(true)
    // 刚发出的请求可能还没进首屏，用户正停在它的详情上。
    expect(hasPendingModelRequest([{ status: 'complete' }], { status: 'pending' })).toBe(true)
    expect(hasPendingModelRequest([], { status: 'complete' })).toBe(false)
  })

  it('手动开关与进行中请求是并联条件，任一成立就轮询', () => {
    expect(shouldPollModelRequests({ manualSwitch: false, hasPendingRequest: false })).toBe(false)
    // 开关关着也要转起来，否则刚发出的请求要手点刷新才会变成已完成。
    expect(shouldPollModelRequests({ manualSwitch: false, hasPendingRequest: true })).toBe(true)
    // 开关开着就算全部完成也继续轮询，随时可能有新请求进来。
    expect(shouldPollModelRequests({ manualSwitch: true, hasPendingRequest: false })).toBe(true)
    expect(shouldPollModelRequests({ manualSwitch: true, hasPendingRequest: true })).toBe(true)
  })

  it('轮询覆盖已加载的全部记录，但不少于一页也不超过上限', () => {
    expect(resolveModelRequestRefreshLimit(0, 30)).toBe(30)
    expect(resolveModelRequestRefreshLimit(12, 30)).toBe(30)
    expect(resolveModelRequestRefreshLimit(90, 30)).toBe(90)
    expect(resolveModelRequestRefreshLimit(5000, 30)).toBe(MODEL_REQUEST_REFRESH_LIMIT_MAX)
  })
})

describe('模型请求自动刷新控制器', () => {
  it('自动刷新默认关闭，仅在启用且页面可见时按 2 秒轮询', () => {
    expect(MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS).toBe(2000)
    const timeouts: Array<() => void> = []
    const handles: number[] = []
    let enabled = false
    let visible = true
    let refreshCount = 0
    const live = createModelRequestLiveRefresh({
      isEnabled: () => enabled,
      isVisible: () => visible,
      refresh: () => { refreshCount += 1 },
      setInterval: (handler) => {
        timeouts.push(handler)
        handles.push(handles.length + 1)
        return handles.at(-1) as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {
        timeouts.length = 0
      },
    })

    live.sync()
    expect(live.isRunning()).toBe(false)

    enabled = true
    live.sync()
    expect(live.isRunning()).toBe(true)
    timeouts[0]?.()
    expect(refreshCount).toBe(1)

    visible = false
    live.sync()
    expect(live.isRunning()).toBe(false)

    visible = true
    live.sync()
    expect(live.isRunning()).toBe(true)

    live.dispose()
    expect(live.isRunning()).toBe(false)
  })

  it('进入页面时把 onMounted 与 onActivated 合并为一次刷新', async () => {
    let refreshCount = 0
    const enter = createModelRequestEnterRefresh(() => {
      refreshCount += 1
    })

    enter.schedule()
    enter.schedule()
    expect(refreshCount).toBe(0)

    await Promise.resolve()
    expect(refreshCount).toBe(1)

    enter.schedule()
    await Promise.resolve()
    expect(refreshCount).toBe(2)
  })
})

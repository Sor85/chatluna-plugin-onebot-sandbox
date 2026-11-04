import { describe, expect, it } from 'vitest'
import { createScrollRestore } from '../client/shared/scroll-restore'

function createHarness(initial = { scrollTop: 0, maxScrollTop: 0 }) {
  const box = { ...initial }
  const scrolls: number[] = []
  let frames = 0
  let measurable = true
  let onFrame: ((frame: number) => void) | undefined

  const restore = createScrollRestore({
    measure: () => (measurable ? { ...box } : undefined),
    scrollTo: (top) => {
      scrolls.push(top)
      box.scrollTop = top
    },
    nextTick: () => Promise.resolve(),
    frame: () => {
      frames += 1
      onFrame?.(frames)
      return Promise.resolve()
    },
  })

  return {
    restore,
    box,
    scrolls,
    frameCount: () => frames,
    setMeasurable(value: boolean) {
      measurable = value
    },
    /** 在指定帧上模拟页面行为：内容长高、子树重建清零等。 */
    onFrame(hook: (frame: number) => void) {
      onFrame = hook
    },
  }
}

describe('滚动位置恢复', () => {
  it('内容已经足够高时写入目标位置', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })

    await harness.restore.restore(640)

    expect(harness.box.scrollTop).toBe(640)
    // 幂等：到位之后不再重复写入。
    expect(harness.scrolls).toEqual([640])
  })

  it('已经停在目标位置时完全不写入', async () => {
    const harness = createHarness({ scrollTop: 640, maxScrollTop: 2000 })

    await harness.restore.restore(640)

    expect(harness.scrolls).toEqual([])
  })

  it('正文子树被重建清零后把位置按回目标', async () => {
    // 这正是往返后详情面板丢位置的形状：写入成功，随后视图切换把 scrollTop 清零。
    const harness = createHarness({ scrollTop: 260, maxScrollTop: 263 })
    harness.onFrame((frame) => {
      if (frame === 3) harness.box.scrollTop = 0
    })

    await harness.restore.restore(260)

    expect(harness.scrolls).toEqual([260])
    expect(harness.box.scrollTop).toBe(260)
  })

  it('多次被清零都能按回目标', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 263 })
    harness.onFrame((frame) => {
      if (frame === 5 || frame === 12) harness.box.scrollTop = 0
    })

    await harness.restore.restore(260)

    expect(harness.scrolls).toEqual([260, 260, 260])
    expect(harness.box.scrollTop).toBe(260)
  })

  it('目标超过当前上限时先夹取，再随内容长高逼近目标', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 40 })
    harness.onFrame((frame) => {
      if (frame === 4) harness.box.maxScrollTop = 150
      if (frame === 9) harness.box.maxScrollTop = 600
    })

    await harness.restore.restore(260)

    expect(harness.scrolls).toEqual([40, 150, 260])
  })

  it('内容始终长不到目标高度时按上限停住，窗口结束即放弃', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 40 })

    await harness.restore.restore(260)

    expect(harness.scrolls).toEqual([40])
    expect(harness.box.scrollTop).toBe(40)
  })

  it('窗口有界，不会一直占用帧', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })

    await harness.restore.restore(640)

    expect(harness.frameCount()).toBe(30)
  })

  it('窗口结束后内容再被清零也不再干预', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })
    await harness.restore.restore(640)

    harness.box.scrollTop = 0

    expect(harness.box.scrollTop).toBe(0)
    expect(harness.scrolls).toEqual([640])
  })

  it('后一次恢复让前一次立刻停手', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })

    const first = harness.restore.restore(640)
    const second = harness.restore.restore(20)
    await first
    await second

    expect(harness.scrolls).toEqual([20])
    expect(harness.box.scrollTop).toBe(20)
  })

  it('取消后不再写入', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })

    const pending = harness.restore.restore(640)
    harness.restore.cancel()
    await pending

    expect(harness.scrolls).toEqual([])
  })

  it('取消中途的恢复后不再把位置按回目标', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })
    harness.onFrame((frame) => {
      if (frame !== 4) return
      // 同一帧里内容被清零并取消恢复：取消之后不应该再按回 640。
      harness.box.scrollTop = 0
      harness.restore.cancel()
    })

    await harness.restore.restore(640)

    expect(harness.scrolls).toEqual([640])
    expect(harness.box.scrollTop).toBe(0)
  })

  it('测不到滚动容器时不写入', async () => {
    const harness = createHarness({ scrollTop: 0, maxScrollTop: 2000 })
    harness.setMeasurable(false)

    await harness.restore.restore(640)

    expect(harness.scrolls).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  createCompositionHoverIntent,
  resolveCompositionTooltipPosition,
} from '../client/model-request/composition-tooltip'

const shell = { left: 100, top: 200, width: 400, height: 60 }
const clip = { left: 100, top: 120, width: 400, height: 140 }
const tooltip = { width: 160, height: 46 }

describe('请求组成分段浮层的落点', () => {
  it('横向对齐分段中心，纵向钉在分段上方，坐标落在容器自己的坐标系里', () => {
    const position = resolveCompositionTooltipPosition({
      bar: { left: 280, top: 240, width: 20, height: 8 },
      shell,
      clip,
      tooltip,
    })

    expect(position.left).toBe(190)
    expect(position.top).toBe(32)
  })

  it('分段贴着容器左右两边时把浮层夹进容器，不让它半个身子飘在外面', () => {
    const atLeft = resolveCompositionTooltipPosition({
      bar: { left: 100, top: 240, width: 2, height: 8 },
      shell,
      clip,
      tooltip,
    })
    const atRight = resolveCompositionTooltipPosition({
      bar: { left: 498, top: 240, width: 2, height: 8 },
      shell,
      clip,
      tooltip,
    })

    expect(atLeft.left).toBe(86)
    expect(atRight.left).toBe(314)
  })

  it('顶到裁切祖先的上边缘时不再继续往上飘', () => {
    // 分段本身很靠上，按「上方 8px」算会让浮层顶端超出裁切祖先，被整齐切掉一半。
    const tightClip = { left: 100, top: 190, width: 400, height: 80 }
    const position = resolveCompositionTooltipPosition({
      bar: { left: 280, top: 205, width: 20, height: 8 },
      shell,
      clip: tightClip,
      tooltip,
    })

    expect(position.top).toBe(42)
    // 落点是浮层下边缘，因此顶端是 shell.top + top - 高度；它必须仍在裁切祖先里面。
    expect(shell.top + position.top - tooltip.height).toBeGreaterThanOrEqual(tightClip.top)
  })
})

describe('请求组成分段的悬停意图', () => {
  function createClock() {
    const timers = new Map<number, { handler: () => void, timeout: number }>()
    let nextId = 1
    return {
      timers,
      schedule: (handler: () => void, timeout: number) => {
        const id = nextId++
        timers.set(id, { handler, timeout })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      cancel: (id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number)
      },
      fire: () => {
        const [id, entry] = [...timers.entries()][0] ?? []
        if (id === undefined || !entry) return
        timers.delete(id)
        entry.handler()
      },
    }
  }

  it('首次悬停等一拍再显示，等待期间离开就不显示了', () => {
    const clock = createClock()
    const intent = createCompositionHoverIntent({ delayMs: 500, schedule: clock.schedule, cancel: clock.cancel })
    let shown = 0

    intent.enter(() => { shown += 1 })
    expect(shown).toBe(0)
    expect([...clock.timers.values()][0]?.timeout).toBe(500)

    intent.leave(() => { shown -= 1 })
    clock.fire()
    expect(shown).toBe(0)
    expect(intent.isOpen()).toBe(false)
  })

  it('已经显示时在分段之间移动立刻换目标，不重新等待', () => {
    const clock = createClock()
    const intent = createCompositionHoverIntent({ schedule: clock.schedule, cancel: clock.cancel })
    const shown: string[] = []

    intent.enter(() => shown.push('第一段'))
    clock.fire()
    expect(shown).toEqual(['第一段'])
    expect(intent.isOpen()).toBe(true)

    // 同一条轨道上横向滑动：每段各自计时会一路重新等待，读起来像浮层跟不上指针。
    intent.enter(() => shown.push('第二段'))
    expect(shown).toEqual(['第一段', '第二段'])
    expect(clock.timers.size).toBe(0)
  })

  it('离开已显示的分段立刻关闭，下一次悬停重新等一拍', () => {
    const clock = createClock()
    const intent = createCompositionHoverIntent({ schedule: clock.schedule, cancel: clock.cancel })
    let visible = false

    intent.enter(() => { visible = true })
    clock.fire()
    intent.leave(() => { visible = false })
    expect(visible).toBe(false)
    expect(intent.isOpen()).toBe(false)

    intent.enter(() => { visible = true })
    expect(visible).toBe(false)
    clock.fire()
    expect(visible).toBe(true)
  })

  it('没显示过就离开不会触发关闭回调，卸载时清掉等待中的那一次', () => {
    const clock = createClock()
    const intent = createCompositionHoverIntent({ schedule: clock.schedule, cancel: clock.cancel })
    let hidden = 0

    intent.leave(() => { hidden += 1 })
    expect(hidden).toBe(0)

    intent.enter(() => {})
    intent.dispose()
    expect(clock.timers.size).toBe(0)
  })
})

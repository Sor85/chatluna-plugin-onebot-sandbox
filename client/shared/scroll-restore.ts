/**
 * 滚动位置恢复：把一个滚动容器恢复到记录下来的偏移量，并在内容稳定前一直按住这个位置。
 *
 * 写一次不够。返回上一个视图时正文子树会被页签切换和异步数据重建，重建会把 scrollTop 清零；
 * 内容也可能仍在长高，使恢复时刻的可滚动上限小于目标偏移量而被浏览器夹掉。
 * 因此在一个有界的帧窗口内每帧把位置按回目标：写入是幂等的，已经到位时不做任何事。
 *
 * 全部决策与帧时序在本 module 内；DOM 经由 adapter，因此可以在 node 环境完整驱动。
 */

export interface ScrollRestoreBox {
  scrollTop: number
  /** `scrollHeight - clientHeight`，即当前允许的最大滚动量。 */
  maxScrollTop: number
}

export interface ScrollRestoreAdapter {
  measure(): ScrollRestoreBox | undefined
  scrollTo(top: number): void
  nextTick(): Promise<void>
  frame(): Promise<void>
}

/** 约 480ms @ 60fps。用帧数而不是定时器计窗口，避免测试里出现不会结束的循环。 */
const RESTORE_FRAMES = 30
const SCROLL_TOLERANCE = 2

export function createScrollRestore(adapter: ScrollRestoreAdapter) {
  let generation = 0

  async function restore(top: number): Promise<void> {
    const current = ++generation
    await adapter.nextTick()
    for (let frame = 0; frame < RESTORE_FRAMES; frame += 1) {
      await adapter.frame()
      // 切换到另一条记录或另一个目标后立刻停手，不要把新内容拽回旧位置。
      if (current !== generation) return
      apply(top)
    }
  }

  /** 取消进行中的恢复，例如切换到另一条模型请求记录。 */
  function cancel(): void {
    generation += 1
  }

  /** 写入当前可行的最大偏移量；已经到位时不写。 */
  function apply(top: number): void {
    const box = adapter.measure()
    if (!box) return
    const reachable = Math.min(top, Math.max(0, box.maxScrollTop))
    if (Math.abs(box.scrollTop - reachable) < SCROLL_TOLERANCE) return
    adapter.scrollTo(reachable)
  }

  return { restore, cancel }
}

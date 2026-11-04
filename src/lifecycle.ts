import type { Context } from 'cordis'

/**
 * Cordis 4 没有 `ready` / `dispose` 事件：启动任务推迟到本轮插件装配之后执行，收尾挂在当前 Fiber 的
 * effect 上。两者都返回同步 disposer，便于放进已有的 disposer 列表。
 */
export function onStart(ctx: Context, task: () => unknown): () => void {
  let disposed = false
  const timer = setTimeout(() => {
    if (!disposed) void task()
  }, 0)
  return onDispose(ctx, () => {
    disposed = true
    clearTimeout(timer)
  })
}

export function onDispose(ctx: Context, task: () => void): () => void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    task()
  }
  const disposable = ctx.effect(() => run)
  return () => {
    run()
    void disposable()
  }
}

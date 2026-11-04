/**
 * 一个可以从外部决定成败时机的调用。
 *
 * 用来观察「调用途中」的状态：闸门与错误位在第一个 `await` 之前就置好了进行中并清掉了错误，
 * 而假端口是立即结算的，因此需要一个自己控制何时结算的调用才能断言「两条通道可以同时进行中」
 * 这类跨调用的形态。
 */
export function deferred<T>() {
  let settle!: (value: T) => void
  let fail!: (cause: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  return { promise, settle, fail }
}

/** 日志里的异常详情：Cordis 4 的 Logger 会把 Error 参数格式化成 `{}`，必须显式取堆栈。 */
export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

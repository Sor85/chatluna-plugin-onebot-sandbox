import type { Context } from 'cordis'
import { fileURLToPath } from 'node:url'

/** 实例根目录：与 ChatLuna 的运行时配置一致，取 Loader 入口所在目录，缺省回退到进程工作目录。 */
export function resolveBaseDir(ctx: Context): string {
  return ctx.baseUrl ? fileURLToPath(new URL('.', ctx.baseUrl)) : process.cwd()
}

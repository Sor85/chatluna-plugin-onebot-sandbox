import { Context, type Exporter, Logger } from 'cordis'
import { pathToFileURL } from 'node:url'
import TimerPlugin from '@cordisjs/plugin-timer'
import Koishi from 'koishi'

type PluginArgs = Parameters<Context['plugin']>

/**
 * 测试宿主：Cordis 4 根上下文加 Koishi 兼容层（同步装好 Satori 与中间件处理器），并补上源插件测试用到的
 * `start` / `stop` / `baseDir`。插件在 v2 里跑的就是这套组合，测试因此覆盖真实的中间件、
 * 受理人与会话派发路径。
 *
 * Cordis 4 要求插件显式声明依赖；源测试里大量匿名插件直接把 ctx 交给控制服务，因此根上直接
 * 注册的函数插件统一补上 `satori` 依赖，与插件入口的 inject 口径一致。
 */
export class App extends Context {
  private pending: Promise<unknown>[] = []

  constructor() {
    super()
    const base: Context['plugin'] = this.plugin.bind(this)
    const wrap = (...args: PluginArgs) => {
      const [plugin, ...rest] = args
      if (typeof plugin !== 'function' || 'inject' in plugin || plugin.prototype) return base(...args)
      const fiber = base({ name: plugin.name || 'test-plugin', inject: ['satori'], apply: plugin }, ...(rest as []))
      this.pending.push(Promise.resolve(fiber))
      return fiber
    }
    Object.defineProperty(this, 'plugin', { value: wrap, configurable: true, writable: true })
    // 直接构造 Koishi 服务（同步装好 Satori、处理器、指令与 Session 扩展），源测试因此可以在
    // `new App()` 之后立刻使用根上下文。Koishi 服务只需要能声明表的 model：这里给一个只记录声明
    // 的替身，刻意不提供 database——有 database 时处理器会先读 channel/user 表，没有驱动会停住。
    const tables: Record<string, { fields: Record<string, unknown> }> = {}
    this.provide('model', {
      tables,
      extend: (name: string, fields: Record<string, unknown>) => {
        tables[name] = { fields: { ...tables[name]?.fields, ...fields } }
      },
      migrate: () => {},
    })
    new Koishi(this, Koishi.Config({ prefix: [''] }))
    this.pending.push(Promise.resolve(this.plugin(TimerPlugin)))
  }

  set baseDir(dir: string) {
    this.baseUrl = pathToFileURL(dir.endsWith('/') ? dir : `${dir}/`).href
  }

  get baseDir(): string {
    return this.baseUrl ? decodeURIComponent(new URL('.', this.baseUrl).pathname) : process.cwd()
  }

  /** Satori 与 Koishi 兼容层在 Cordis 4 里异步激活；直接在根上构造服务前必须先等它们就绪。 */
  async ready() {
    await Promise.all(this.pending)
  }

  async start() {
    await Promise.all(this.pending)
    // 插件的启动任务挂在下一轮宏任务上，等它们跑完再交给测试。
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  async stop() {
    await Promise.allSettled(this.pending)
    // Koishi 与 Satori 兼容层把 `ready` 回调挂在 setTimeout(0) 上且不随 fiber 取消，先让它们在
    // 宿主还活着时跑完，否则回调在销毁后读 `ctx.bots` / `ctx.satori` 报未处理错误。
    await new Promise((resolve) => setTimeout(resolve, 0))
    await this.fiber.dispose()
  }
}

export async function createApp() {
  const app = new App()
  await app.ready()
  return app
}

/** 截获该上下文树的日志输出，返回已打印文本与恢复函数；Cordis 4 用 exporter 取代了 Koishi 的 targets。 */
export function captureLogs(app: Context) {
  const printed: string[] = []
  const exporter: Exporter = { colors: 0, export: (message) => printed.push(Logger.format(exporter, message)) }
  const dispose = app.logger.exporter(exporter)
  return { printed, restore: () => void dispose() }
}

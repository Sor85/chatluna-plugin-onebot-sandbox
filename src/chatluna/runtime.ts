/**
 * 被测 ChatLuna 插件运行时的解析口。
 *
 * 沙盒要读的两件事——ChatLuna 主功能的对话配置、chatluna-character 的伪装配置与对话上下文——都挂在
 * 各自插件的服务实例上。两个插件都可以随时重载，因此这里只提供「现取一次」的函数，不缓存实例。
 *
 * 两条形态是这个模块存在的理由，不是防御性写法：
 *
 * 1. 走 `get(name)` 而不是属性访问。本插件不把这两个服务写进 `inject`——声明了它们会让被测插件每次
 *    重载都连带重建沙盒，内存模式下整份场景会跟着丢——而未声明的属性访问会被 Cordis 记一条注入告警。
 * 2. 自己的上下文取不到时，遍历插件注册表用提供方自己的上下文再取一次。被测插件可能装在隔离了服务
 *    映射的 loader group 里，此时只有提供方那份上下文能解析到实例；chatluna-usage 已经踩过同一个坑。
 *
 * 形状按运行时读：服务来自仓库外的包，类型不在编译期可见。因此解析口收一个「接受判定」而不是直接把
 * 服务交出去——调用方各自只要服务上的一小块能力，判定不通过就当作没装，而不是等到真的调用那一小块
 * 能力时才在调用点上炸掉。
 */

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function readServiceFrom<T>(
  host: unknown,
  serviceName: string,
  accept: (service: Record<string, unknown>) => T | undefined,
): T | undefined {
  const get = readRecord(host)?.get
  if (typeof get !== 'function') return undefined
  const service = readRecord((get as (name: string) => unknown).call(host, serviceName))
  return service ? accept(service) : undefined
}

function listRegistryContexts(value: unknown): unknown[] {
  const registry = readRecord(readRecord(value)?.registry)
  const values = registry?.values
  if (typeof values !== 'function') return []
  return [...(values as () => Iterable<unknown>).call(registry)].flatMap((runtime) => {
    const ctx = readRecord(runtime)?.ctx
    return ctx ? [ctx] : []
  })
}

/**
 * 按服务名解析被测 ChatLuna 插件的服务，并收窄成调用方真正用到的那一小块。
 *
 * 先在自己的上下文里取；取不到再遍历插件注册表用提供方自己的上下文取一次。第二步不是保险措施，
 * 理由见模块注释第 2 条。
 */
export function findChatLunaRuntime<T>(
  host: unknown,
  serviceName: string,
  accept: (service: Record<string, unknown>) => T | undefined,
): T | undefined {
  const direct = readServiceFrom(host, serviceName, accept)
  if (direct) return direct
  for (const ctx of listRegistryContexts(host)) {
    const resolved = readServiceFrom(ctx, serviceName, accept)
    if (resolved) return resolved
  }
}

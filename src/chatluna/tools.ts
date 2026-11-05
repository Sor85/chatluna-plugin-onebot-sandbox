import type { Context } from 'cordis'
import type {} from '@chatluna/tool'
import type { ToolDefinition } from '@chatluna/tool'
import { schemaFromJsonSchema } from '@chatluna/schema'
import type { SandboxMcpService } from '../mcp/service'
import { SandboxMcpError, type SandboxMcpScope, type SandboxMcpToolCapability } from '../mcp/types'

/**
 * 把测试端点的工具注册给 ChatLuna 机器人（`ctx.tools`）。
 *
 * 调用走 `SandboxMcpService.createInternalCaller`：权限范围、配额、并发、幂等、确认令牌与测试调用记录
 * 和两种网络表述是同一条路径，记录的来路是 `chatluna`。工具声明同样取自服务的对外声明，不另写一份。
 *
 * `tools` 不写进 `inject`：只有开启时才需要它，写进去会让未装工具服务的实例连沙盒都起不来，
 * 工具服务重载也会连带重建沙盒（内存模式下整份场景跟着丢）。子作用域只随工具服务重建，注册挂在
 * 子作用域的 fiber 上，卸载时自动撤销。
 */

export interface SandboxBotToolsConfig {
  enabled: boolean
  scopes: SandboxMcpScope[]
}

/** 工具名前缀；v2 工具名只允许 `[a-zA-Z0-9_-]`，最长 64 个字符，沙盒工具名都在范围内。 */
export const SANDBOX_BOT_TOOL_PREFIX = 'sandbox_'

const CALLER_NAME = 'ChatLuna 机器人'

type JsonSchemaNode = Parameters<typeof schemaFromJsonSchema>[0]

/** v2 能转换的 JSON Schema 关键字（`@chatluna/schema` 的 `assertSupportedJsonSchema`）。 */
const SUPPORTED_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])

/** 等待类工具的同步上限在服务端最长等待之外多留的余量，免得框架先于服务端超时。 */
const WAIT_MARGIN_MS = 5_000

export function registerSandboxBotTools(ctx: Context, mcp: SandboxMcpService, config: SandboxBotToolsConfig): void {
  if (!config.enabled || !config.scopes.length) return
  const caller = mcp.createInternalCaller({ id: 'chatluna-bot', name: CALLER_NAME, scopes: config.scopes, transport: 'chatluna' })
  ctx.inject(['tools'], (inner) => {
    const tools = caller.listTools()
    for (const tool of tools) inner.tools.define(toToolDefinition(tool, (name) => caller.describeTool(name), (name, args) => caller.callTool(name, args)))
    inner.logger('onebot-sandbox').info('registered %d bot tools (%s)', tools.length, caller.scopes.join(', '))
  })
}

export function toToolDefinition(
  tool: SandboxMcpToolCapability,
  describe: (name: string) => SandboxMcpToolCapability | undefined,
  call: (name: string, args: unknown) => Promise<unknown>,
): ToolDefinition<unknown> {
  const properties = readProperties(tool.inputSchema)
  const waitMs = waitBudgetMs(properties)
  return {
    name: `${SANDBOX_BOT_TOOL_PREFIX}${tool.name}`,
    description: tool.description,
    // 带消息正文的工具说明里有唤醒规则，规则随被测插件的路由配置变化，每次组装工具清单时现取。
    ...(properties.content ? { describe: () => describe(tool.name)?.description ?? tool.description } : {}),
    args: schemaFromJsonSchema(toSupportedJsonSchema(tool.inputSchema)),
    traits: {
      effect: tool.scope === 'read' ? 'read' : 'write',
      // 四十来个工具的 schema 不小：search 模式下延迟加载，经 tool_search 取用；native 模式不受影响。
      deferred: true,
      ...(waitMs ? { timeout: waitMs } : {}),
    },
    async run(args) {
      try {
        // 框架要求结果可 JSON 序列化，没有返回值的工具答 null。
        return await call(tool.name, args) ?? null
      } catch (error) {
        throw new Error(formatToolError(error))
      }
    },
  }
}

/**
 * 去掉 v2 不认的关键字（数值与条数范围、对象级 `anyOf`），范围改写进说明：执行体照样按范围校验，
 * 模型只是提前知道边界，不必等一次参数错误。
 */
export function toSupportedJsonSchema(schema: unknown): JsonSchemaNode {
  const source = readRecord(schema)
  // v2 只认单一类型：`type: ['object', 'null']` 拆成按类型分支的 oneOf，说明留在外层。
  if (Array.isArray(source.type)) {
    const { type: types, description, ...rest } = source
    return {
      ...(typeof description === 'string' ? { description } : {}),
      oneOf: types.map((type) => type === 'null' ? { type: 'null' } : toSupportedJsonSchema({ ...rest, type })),
    } as JsonSchemaNode
  }
  const node: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!SUPPORTED_KEYS.has(key)) continue
    if (key === 'properties') node.properties = Object.fromEntries(Object.entries(readRecord(value)).map(([name, child]) => [name, toSupportedJsonSchema(child)]))
    else if (key === 'items' || (key === 'additionalProperties' && typeof value === 'object')) node[key] = toSupportedJsonSchema(value)
    else if (key === 'oneOf' && Array.isArray(value)) node.oneOf = value.map(toSupportedJsonSchema)
    else node[key] = value
  }
  const bounds = describeBounds(source)
  if (bounds) node.description = [source.description, bounds].filter(Boolean).join('；')
  return node as JsonSchemaNode
}

function describeBounds(schema: Record<string, unknown>): string | undefined {
  const { minimum, maximum, minItems, maxItems } = schema
  const parts: string[] = []
  if (typeof minimum === 'number' && typeof maximum === 'number') parts.push(`取值 ${minimum}~${maximum}`)
  else if (typeof minimum === 'number') parts.push(`最小 ${minimum}`)
  else if (typeof maximum === 'number') parts.push(`最大 ${maximum}`)
  if (typeof minItems === 'number') parts.push(`至少 ${minItems} 项`)
  if (typeof maxItems === 'number') parts.push(`最多 ${maxItems} 项`)
  return parts.length ? parts.join('，') : undefined
}

/** 按 schema 形状认出等待类工具：最长等待加最长静默期，再留一点余量。 */
function waitBudgetMs(properties: Record<string, unknown>): number | undefined {
  const timeout = readRecord(properties.timeoutSeconds).maximum
  if (typeof timeout !== 'number') return undefined
  const settle = readRecord(properties.settleSeconds).maximum
  return (timeout + (typeof settle === 'number' ? settle : 0)) * 1000 + WAIT_MARGIN_MS
}

/**
 * v2 只把错误的 message 交给模型，没有错误码通道；码、恢复建议与记录 ID 都写进正文，
 * 模型据此改参数重试，或用 `get_test_call_record` 取回这次失败的记录。
 */
export function formatToolError(error: unknown): string {
  if (!(error instanceof SandboxMcpError)) return error instanceof Error ? error.message : String(error)
  const lines = [`[${error.code}] ${error.message}`, error.recovery]
  if (error.details !== undefined) lines.push(JSON.stringify(error.details))
  if (error.retryAfterMs !== undefined) lines.push(`retryAfterMs: ${error.retryAfterMs}`)
  if (error.traceId) lines.push(`traceId: ${error.traceId}`)
  return lines.join('\n')
}

function readProperties(schema: unknown): Record<string, unknown> {
  return readRecord(readRecord(schema).properties)
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

import type { SandboxMcpService, SandboxMcpStableErrorCode } from './service'
import { SandboxMcpError } from './types'

/**
 * HTTP 测试接口：测试控制端点上与 MCP 并列的第二种协议表述。
 *
 * 它不是第二套实现。路由解析完就把调用原样交给 `SandboxMcpService`，因此参数校验、能力范围、
 * 配额、幂等、确认令牌与测试调用记录全部继承同一份语义；本模块只负责三件 MCP 表述替消费者
 * 做掉、而普通 HTTP 客户端必须自己面对的事：
 *
 * 1. 去掉 JSON-RPC 信封与 `Accept: text/event-stream` 协商，请求体直接就是工具参数。
 * 2. 把错误码映射成真实 HTTP 状态码，而不是恒定 200 + 正文里的 `isError`。
 * 3. 把错误信封平铺到响应体顶层，而不是塞进 `content[0].text` 里的二层 JSON。
 *
 * 成功响应直接就是工具结果。工具结果全部是对象，因此两种表述的结果保真度一致：MCP 表述下每个工具
 * 都拿得到 `structuredContent`，不存在「某几个工具要改走解析文本」这条例外路径。
 */

/** 路径版本段。与 ADR-0028 的 `testApiVersion` 同步推进：破坏性变更走新的版本段而不是原地改。 */
export const HTTP_API_VERSION = 'v1'

/** 请求体上限。`upload_media` 走 base64，正常上传远小于此；超出即拒，避免单个请求吃满内存。 */
export const HTTP_API_MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * 稳定错误码到 HTTP 状态码的映射。
 *
 * 声明成 `Record<SandboxMcpStableErrorCode, number>` 而不是 `Record<string, number>`：错误码清单
 * 新增一项时这里漏配会在 typecheck 阶段报错，而不是等到某次真实失败静默退回 500。反方向（表里
 * 留下已删除的码）编译器管不到，由 `tests/http-api.test.ts` 的守卫双向比对补上。
 */
export const HTTP_API_ERROR_STATUS: Record<SandboxMcpStableErrorCode, number> = {
  // 凭证与权限
  unauthorized: 401,
  permission_denied: 403,
  credential_not_found: 404,
  // 参数与契约
  invalid_arguments: 400,
  unsupported_change: 400,
  unsupported_scene_version: 400,
  tool_not_found: 404,
  resource_not_found: 404,
  // 并发与配额
  idempotency_conflict: 409,
  revision_conflict: 409,
  // 428 而不是 403：确认令牌是「先取令牌再重放」的前置条件，不是权限不足。
  confirmation_required: 428,
  // 410 而不是 400：游标本身合法，只是它指向的记录已被容量策略回收，重取即可。
  cursor_expired: 410,
  rate_limited: 429,
  concurrency_limited: 429,
  // AI 测试空间
  space_id_required: 400,
  space_taken_over: 409,
  space_not_found: 404,
  space_unavailable: 409,
  test_spaces_unavailable: 503,
  // 领域实体
  participant_not_found: 404,
  group_not_found: 404,
  conversation_not_found: 404,
  request_not_found: 404,
  record_not_found: 404,
  robot_request_forbidden: 403,
  // 媒体
  media_not_found: 404,
  invalid_media_url: 400,
  digest_mismatch: 400,
  // 传输层
  method_not_allowed: 405,
  payload_too_large: 413,
  // 兜底两类
  domain_error: 422,
  internal_error: 500,
}

/** 错误信封：字段与 MCP 表述的错误信封逐字一致，消费者可以共用同一份解析代码。 */
export interface HttpApiErrorBody {
  code: string
  message: string
  retryable: boolean
  recovery: string
  details?: unknown
  retryAfterMs?: number
  revision: number
  traceId?: string
}

export interface HttpApiResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type HttpApiRoute =
  | { kind: 'list-tools' }
  | { kind: 'call-tool'; tool: string }
  | { kind: 'list-resources' }
  | { kind: 'read-resource'; uri: string }

export interface HttpApiRequest {
  method: string
  pathname: string
  searchParams: URLSearchParams
  /** 已读取完成的请求体原文；GET 路由不读取请求体，此处为空串。 */
  body: string
}

/** 判定 pathname 是否落在 HTTP 测试接口的路径前缀下。前缀本身与其子路径都算命中。 */
export function isHttpApiPath(pathname: string, basePath: string): boolean {
  const base = normalizeBasePath(basePath)
  return pathname === base || pathname.startsWith(`${base}/`)
}

export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function httpStatusForErrorCode(code: string): number {
  return HTTP_API_ERROR_STATUS[code as SandboxMcpStableErrorCode] ?? 500
}

/**
 * 把路径解析成路由。
 *
 * 未知路径抛 `resource_not_found` 而不是返回 undefined：调用方对「路径不存在」与「工具执行失败」
 * 的处理完全相同（都是按错误码写状态码），分成两条返回形态只会让调用点多一个分支。
 */
export function resolveHttpApiRoute(request: HttpApiRequest, basePath: string): HttpApiRoute {
  const base = normalizeBasePath(basePath)
  const relative = request.pathname.slice(base === '/' ? 0 : base.length)
  const segments = relative.split('/').filter(Boolean)
  if (segments[0] !== HTTP_API_VERSION) {
    throw new SandboxMcpError('resource_not_found', `路径不存在：${request.pathname}`, false, `请使用 ${base}/${HTTP_API_VERSION} 下的路由。`)
  }
  const [, collection, ...rest] = segments
  if (collection === 'tools' && rest.length === 0) return requireMethod(request, 'GET', { kind: 'list-tools' })
  // 工具名不含斜杠，因此 rest 恰好一段；多段路径是拼错的路由而不是嵌套资源。
  if (collection === 'tools' && rest.length === 1) return requireMethod(request, 'POST', { kind: 'call-tool', tool: decodeURIComponent(rest[0]!) })
  if (collection === 'resources' && rest.length === 0) {
    // 同一路径按有无 uri 查询参数分列表与读取：资源 URI 形如 `onebot-sandbox://guide`，
    // 内含 `://`，塞进路径段会被反复转义，放查询参数才是可直接手写的形态。
    const uri = request.searchParams.get('uri')
    return requireMethod(request, 'GET', uri === null ? { kind: 'list-resources' } : { kind: 'read-resource', uri })
  }
  throw new SandboxMcpError('resource_not_found', `路径不存在：${request.pathname}`, false, `请使用 ${base}/${HTTP_API_VERSION} 下的路由。`)
}

function requireMethod(request: HttpApiRequest, method: string, route: HttpApiRoute): HttpApiRoute {
  if (request.method !== method) {
    throw new SandboxMcpError('method_not_allowed', `${request.pathname} 只接受 ${method}`, false, `请改用 ${method} 重试。`)
  }
  return route
}

/**
 * HTTP 测试接口的一条路由。
 *
 * `kind` 与 `resolveHttpApiRoute` 解析出的路由种类同名：自述与解析器共用一套路由词汇，
 * 因此「解析器新认了一条路由，自述里却没有它」是可被测试直接比对出来的，而不是靠人眼。
 *
 * `target` 是 origin-form 的请求目标（路径加可选查询串）而不是纯路径：列出只读资源与读取
 * 单个资源共用同一条路径，只靠有没有 `uri` 查询参数区分，拆成两个字段只会让每个消费者
 * 自己再拼一次。
 */
export interface SandboxHttpApiRoute {
  kind: HttpApiRoute['kind']
  method: 'GET' | 'POST'
  target: string
  summary: string
}

/** 一个稳定错误码在 HTTP 表述下的状态码。按 `STABLE_ERROR_CODES` 的声明顺序给出。 */
export interface SandboxHttpApiErrorStatus {
  code: string
  status: number
}

/** HTTP 表述的自述：开关、基址、路由、请求体上限与错误码映射。 */
export interface SandboxHttpApiCapabilityCatalog {
  enabled: boolean
  basePath: string
  version: string
  /** 可直接拼上路由请求目标的基址，例如 `http://127.0.0.1:61901`。 */
  baseUrl: string
  maxBodyBytes: number
  routes: SandboxHttpApiRoute[]
  errorStatuses: SandboxHttpApiErrorStatus[]
}

export interface SandboxHttpApiEndpoint {
  enabled: boolean
  path: string
  host: string
  port: number
  tls: boolean
}

/**
 * 把通配监听地址换成能真正拨通的地址。
 *
 * `0.0.0.0` 与 `::` 表示「监听所有网卡」，不是目的地；原样写进示例会给出一个看着像地址、
 * 在部分环境里连不上的基址。在 Koishi 主机上等价的目的地是回环地址，从别的机器访问时要
 * 换成这台机器的实际 IP——那个值只有部署者知道，因此这里只保证本机可用。
 */
export function toHttpApiBaseUrl({ host, port, tls }: Pick<SandboxHttpApiEndpoint, 'host' | 'port' | 'tls'>): string {
  const address = !host || host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  // IPv6 字面量在 URL 里必须加方括号，否则冒号会被当成端口分隔符。
  return `${tls ? 'https' : 'http'}://${address.includes(':') ? `[${address}]` : address}:${port}`
}

/**
 * HTTP 表述的自述，与 `resolveHttpApiRoute` 同处一个模块。
 *
 * 「路径怎么解析」与「端点上有哪些路由」必须由同一份代码回答：分开写的话，下一次改路由会让
 * 控制台上的路由表静默变成过期文档，而没有任何测试会红。请求体上限与错误码映射同理，直接读
 * 本模块的那两个常量，而不是在别处抄一份数值。
 */
export function describeHttpApiCapabilities(endpoint: SandboxHttpApiEndpoint): SandboxHttpApiCapabilityCatalog {
  const base = normalizeBasePath(endpoint.path)
  const prefix = `${base === '/' ? '' : base}/${HTTP_API_VERSION}`
  return {
    enabled: endpoint.enabled,
    basePath: base,
    version: HTTP_API_VERSION,
    baseUrl: toHttpApiBaseUrl(endpoint),
    maxBodyBytes: HTTP_API_MAX_BODY_BYTES,
    routes: [
      { kind: 'list-tools', method: 'GET', target: `${prefix}/tools`, summary: '列出当前凭证权限范围内的工具及其参数 Schema' },
      { kind: 'call-tool', method: 'POST', target: `${prefix}/tools/<工具名>`, summary: '调用一个工具，请求体直接就是工具参数；无参工具可以不带请求体' },
      { kind: 'list-resources', method: 'GET', target: `${prefix}/resources`, summary: '列出全部只读资源' },
      { kind: 'read-resource', method: 'GET', target: `${prefix}/resources?uri=<资源 URI>`, summary: '读取一个只读资源，例如 onebot-sandbox://guide' },
    ],
    errorStatuses: Object.entries(HTTP_API_ERROR_STATUS).map(([code, status]) => ({ code, status })),
  }
}

/**
 * 解析工具参数。
 *
 * 空请求体等价于 `{}`：无参工具用 `curl -X POST` 不带 `-d` 是最自然的写法，逼消费者写 `-d '{}'`
 * 属于把 JSON-RPC 的仪式感原样搬过来。顶层必须是对象——数组或标量在工具侧一定会被判为参数错误，
 * 在这里拦住能给出准确得多的消息。
 */
export function parseHttpApiArguments(body: string): Record<string, unknown> {
  const trimmed = body.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new SandboxMcpError('invalid_arguments', '请求体不是合法 JSON', false, '请检查请求体的 JSON 语法后重试。')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SandboxMcpError('invalid_arguments', '请求体顶层必须是 JSON 对象', false, '请把工具参数放进一个 JSON 对象后重试。')
  }
  return parsed as Record<string, unknown>
}

/**
 * 执行一次 HTTP 测试接口调用。
 *
 * 全程不抛：路由、参数与工具错误统一收敛成带状态码的错误响应，调用方只需把结果写进 ServerResponse。
 * 这一点与 MCP 分支的要求同源——传输层逃出异常会同时造成 unhandled rejection 与请求挂死。
 */
export async function handleHttpApiRequest(
  service: SandboxMcpService,
  token: string,
  request: HttpApiRequest,
  options: { basePath: string; sourceIp?: string },
): Promise<HttpApiResponse> {
  try {
    const route = resolveHttpApiRoute(request, options.basePath)
    if (route.kind === 'list-tools') return { status: 200, body: { testApiVersion: 1, tools: service.listTools(token) } }
    if (route.kind === 'list-resources') return { status: 200, body: { testApiVersion: 1, resources: service.listResources(token) } }
    if (route.kind === 'read-resource') return { status: 200, body: service.readResource(token, route.uri) }
    const args = parseHttpApiArguments(request.body)
    const result = await service.callTool(token, route.tool, args, { sourceIp: options.sourceIp, transport: 'http' })
    // 工具结果原样返回：两种表述给出的是同一份对象，不存在「一种表述有、另一种没有」的字段。
    return { status: 200, body: result === undefined ? null : result }
  } catch (error) {
    return toHttpApiErrorResponse(service, error)
  }
}

export function toHttpApiErrorResponse(service: SandboxMcpService, error: unknown): HttpApiResponse {
  // service.callTool 已经把领域拒绝与未预期异常都收敛成 SandboxMcpError；else 分支覆盖的是
  // 本模块自身的意外，例如结果序列化前的取值失败。它不写日志：service 侧已经记过原始堆栈。
  const normalized = error instanceof SandboxMcpError
    ? error
    : new SandboxMcpError('internal_error', 'HTTP 测试接口处理失败')
  const body: HttpApiErrorBody = {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    recovery: normalized.recovery,
    ...(normalized.details === undefined ? {} : { details: normalized.details }),
    ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
    revision: normalized.revision ?? service.getRevision(),
    ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
  }
  return {
    status: httpStatusForErrorCode(normalized.code),
    body,
    // Retry-After 只在服务端真的给出了等待时长时出现；秒数向上取整，0 秒对客户端没有意义。
    ...(normalized.retryAfterMs === undefined ? {} : { headers: { 'retry-after': String(Math.max(1, Math.ceil(normalized.retryAfterMs / 1000))) } }),
  }
}

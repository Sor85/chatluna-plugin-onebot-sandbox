import type { SandboxSnapshot } from '../types'

export type SandboxMcpScope = 'read' | 'interact' | 'manage' | 'debug'

export interface SandboxMcpToolCapability {
  name: string
  scope: SandboxMcpScope
  description: string
  inputSchema: Record<string, unknown>
  /**
   * 返回值的 JSON Schema，可选。
   *
   * 按 MCP 规范，声明了它的工具必须返回符合它的 `structuredContent`，因此只给结果是对象的工具
   * 声明；返回形状能从工具名与参数推断出来的工具（`get_scene_snapshot` 这类）不声明，也不给一个
   * 空对象——空声明与「没有声明」对消费者是两件事。
   */
  outputSchema?: Record<string, unknown>
}

export interface SandboxMcpResourceCapability {
  uri: string
  name: string
  mimeType: string
  requiredScopes: SandboxMcpScope[]
}

export interface SandboxMcpCapabilityCatalog {
  serverCapabilities: {
    tools: boolean
    resources: boolean
    prompts: boolean
  }
  scopes: SandboxMcpScope[]
  tools: SandboxMcpToolCapability[]
  resources: SandboxMcpResourceCapability[]
}

/**
 * 测试凭证：测试控制端点的具名 Bearer 凭证。
 *
 * 名字里不带 MCP。同一个凭证在 MCP Streamable HTTP 与 HTTP 测试接口两种协议表述下都能用，
 * 权限、配额与调用记录也是同一份；叫「MCP 凭证」会把「只有 MCP 那一种表述用得上」写进领域模型。
 */
export interface SandboxTestCredential {
  id: string
  name: string
  scopes: SandboxMcpScope[]
  enabled: boolean
  token?: string
  tokenDigest: string
  createdAt: string
}

export type SandboxTestPublicCredential = Omit<SandboxTestCredential, 'tokenDigest'>

export interface SandboxTestCreatedCredential extends SandboxTestPublicCredential {
  token: string
}

export interface SandboxMcpEventCursor {
  epoch: string
  sequence: number
}

/**
 * 事件流上可能出现的全部事件类型，也是 `wait_for_event` 的取值集合。
 *
 * 收成封闭词汇而不是自由字符串：写错一个名字此前只能等到超时，而「等到超时也没有事件」与真的
 * 没等到完全一样，消费者据此得出的是错的结论。类型本身就是守卫——追加事件类型必须先登记在这里，
 * 否则 `appendEvent` 那一处过不了类型检查。
 *
 * 顺序按语义分组：场景与消息、ChatLuna 状态、被测插件发起的 OneBot 调用、关系操作、测试空间
 * 生命周期。它是对外声明的顺序（`wait_for_event` 的 enum 与只读资源都按它给出），因此新增类型
 * 要放进它所属的那一组，而不是数组末尾。
 */
export const SANDBOX_MCP_EVENT_TYPES = [
  'scene.changed',
  'message.created',
  'message.recalled',
  'chatluna.state',
  'onebot.action',
  'onebot.event',
  'friend.action',
  'group.action',
  'test-space.created',
  'test-space.completed',
  'test-space.failed',
  'test-space.reactivated',
  'test-space.deleted',
] as const

export type SandboxMcpEventType = typeof SANDBOX_MCP_EVENT_TYPES[number]

export interface SandboxMcpEvent {
  cursor: SandboxMcpEventCursor
  spaceId?: string
  type: SandboxMcpEventType
  createdAt: string
  data: unknown
}

export interface SandboxTestCallRecordError {
  code: string
  message: string
  retryable: boolean
  recovery: string
  details?: unknown
  retryAfterMs?: number
}

/**
 * 测试控制端点上承载这次调用的协议表述。
 *
 * 两种表述共用同一套测试凭证、配额与测试调用记录，因此只看凭证名与来源 IP 分不出调用来路——
 * 同一个凭证既可能被 MCP 客户端使用，也可能被 HTTP 脚本使用。复盘时必须能区分，故单独建模。
 */
export type SandboxTestCallTransport = 'mcp' | 'http'

export interface SandboxTestCallRecordListItem {
  id: string
  createdAt: string
  credentialName: string
  transport: SandboxTestCallTransport
  sourceIp?: string
  tool: string
  testRunId?: string
  spaceId?: string
  durationMs: number
  status: 'success' | 'error'
  affected: readonly string[]
  errorCode?: string
}

export interface SandboxTestCallRecord extends SandboxTestCallRecordListItem {
  arguments: unknown
  result?: unknown
  error?: SandboxTestCallRecordError
}

export interface SandboxMcpExport {
  testApiVersion: 1
  exportedAt: string
  scene: SandboxSnapshot
}

export class SandboxMcpError extends Error {
  /**
   * 失败调用对应的测试调用记录 ID。由 `callTool` 在写入记录后回填，传输层错误信封原样携带，
   * 因此消费者可以拿信封里的 traceId 直接调 `get_test_call_record` 取回这次失败的记录。
   * 凭证校验阶段（尚无记录可写）抛出的错误没有该字段。
   */
  traceId?: string

  /**
   * 失败真正发生的那个场景的版本。与 traceId 同一模式：由 `callTool` 回填，传输层错误信封原样
   * 携带。传输层不能自己从 `arguments.spaceId` 解析——`resolveControl` 的空间三态判定（接管、
   * 不存在、不可用）在那里复现不了。凭证校验阶段（尚无空间可指）抛出的错误没有该字段，信封退回
   * 主场景版本。
   */
  revision?: number

  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public recovery = '请检查调用参数后重试。',
    public details?: unknown,
    public retryAfterMs?: number,
  ) {
    super(message)
  }
}

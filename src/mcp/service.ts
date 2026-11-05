import { errorDetail } from '../error-detail'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import {
  SandboxChatLunaWakeup,
  readSandboxResponderRuntimes,
  type SandboxWakeupReader,
} from '../chatluna/wakeup'
import type { SandboxControlService } from '../control-service'
import type { SandboxModelRequestStore } from '../model-request'
import { createScopeDirectory, type ScopeDirectory } from '../scope-directory'
import type { SandboxTestSpaceService } from '../test-spaces'
import type { SandboxMedia } from '../types'
import { isRecalledMessage, SandboxDomainError, SandboxSpaceNotFoundError } from '../types'
import { argumentsFingerprint, asRecord, readSpaceId, requireNumber, requireString, stableValue } from './arguments'
import {
  matchesTestCallRecordFilter,
  presentTestCallRecord,
  redactTestCallValue,
  resolveTestCallSpaceId,
  summarizeTestCallError,
  toTestCallRecordListItem,
  type ListSandboxTestCallRecordsInput,
  type SandboxTestCallRecordsPage,
} from './call-records'
import {
  findSandboxMcpTool,
  readCapabilityMatrix,
  SANDBOX_MCP_TOOL_DECLARATIONS,
  type SandboxMcpConfirmation,
  type SandboxMcpToolEntry,
  type SandboxMcpToolQuota,
  type SandboxMcpToolRuntime,
  type SandboxMcpWaitResult,
} from './tool-registry'
import {
  SandboxMcpError,
  SANDBOX_MCP_EVENT_TYPES,
  type SandboxTestCallRecord,
  type SandboxTestCallTransport,
  type SandboxTestCreatedCredential,
  type SandboxTestCredential,
  type SandboxMcpCapabilityCatalog,
  type SandboxMcpEvent,
  type SandboxMcpEventCursor,
  type SandboxMcpEventType,
  type SandboxMcpScope,
  type SandboxMcpToolCapability,
} from './types'

/** 一次工具调用的传输层上下文；只用于标注测试调用记录，不参与权限与配额判定。 */
export interface SandboxTestCallContext {
  sourceIp?: string
  /** 承载本次调用的协议表述，默认 `mcp`。 */
  transport?: SandboxTestCallTransport
}

// 测试凭证配额：四档调用频率上限与三档并发上限。执行位置在本服务的额度消耗与
// 并发包装两处，与承载调用的监听器无关；监听器不参与限流判定。因此同一个凭证在
// MCP 与 HTTP 两种协议表述下共用同一份额度，换个表述绕不开限流。
export interface SandboxMcpQuotaConfig {
  readPerMinute: number
  mutationPerMinute: number
  waitPerMinute: number
  uploadPerMinute: number
  maxConcurrentMutations: number
  maxConcurrentWaits: number
  maxConcurrentUploads: number
}

export interface SandboxMcpServiceOptions extends Partial<SandboxMcpQuotaConfig> {
  dataDirectory: string
  eventLimit?: number
  callRecordLimit?: number
  uploadedMediaLimit?: number
  idempotencyLimit?: number
  idempotencyTtlMs?: number
  testSpaces?: SandboxTestSpaceService
  unattributedModelRequests?: SandboxModelRequestStore
  /** 唤醒规则的来源；省略时读本服务所在 Koishi 实例里的被测响应插件运行时。 */
  wakeup?: SandboxWakeupReader
}

const READ_RESOURCES = [
  { uri: 'onebot-sandbox://guide', name: 'MCP 测试指南' },
  { uri: 'onebot-sandbox://scene-schema', name: '场景 JSON Schema' },
  { uri: 'onebot-sandbox://capabilities/napcat', name: 'NapCat 能力基线' },
  { uri: 'onebot-sandbox://capabilities/llbot', name: 'LLBot 能力基线' },
  { uri: 'onebot-sandbox://errors', name: '稳定错误码' },
  // 事件类型与错误码对称：两者都是封闭词汇，消费者都只能从对外声明学到全集。
  { uri: 'onebot-sandbox://events', name: '事件类型' },
  { uri: 'onebot-sandbox://examples', name: '工具调用示例' },
].map((resource) => ({
  ...resource,
  mimeType: 'application/json',
  requiredScopes: ['read' as const],
}))

const ALL_SCOPES: SandboxMcpScope[] = ['read', 'interact', 'manage', 'debug']

// —— 稳定错误码清单 ——
// `onebot-sandbox://errors` 是 AI 消费者唯一的错误码契约文档，它和抛出点分处两地，靠人工同步必然漂移。
// `tests/mcp-error-code-contract.test.ts` 从 src/mcp 源码枚举全部 `new SandboxMcpError('<码>'` 字面量，
// 与本清单双向比较，因此新增未登记的码或删掉在用的码都会让测试变红。
//
// `as const` 不只是收窄字面量：HTTP 测试接口把每个码映射成 HTTP 状态码，那张表声明为
// `Record<SandboxMcpStableErrorCode, number>`，漏掉任何一个码都会在 typecheck 阶段报错，
// 而不是等到某次真实失败才发现它退回了 500。
export const STABLE_ERROR_CODES = [
  // 凭证与权限
  'unauthorized',
  'permission_denied',
  'credential_not_found',
  // 参数与契约
  'invalid_arguments',
  'unsupported_change',
  'unsupported_scene_version',
  'tool_not_found',
  'resource_not_found',
  // 并发与配额
  'idempotency_conflict',
  'revision_conflict',
  'confirmation_required',
  'cursor_expired',
  'rate_limited',
  'concurrency_limited',
  // AI 测试空间
  'space_id_required',
  'space_taken_over',
  'space_not_found',
  'space_unavailable',
  'test_spaces_unavailable',
  // 领域实体
  'participant_not_found',
  'group_not_found',
  'conversation_not_found',
  'request_not_found',
  'record_not_found',
  'robot_request_forbidden',
  // 媒体
  'media_not_found',
  'invalid_media_url',
  'digest_mismatch',
  // HTTP 测试接口的传输层拒绝。MCP 表述不会发出这两个码：JSON-RPC 自己就把方法与请求体
  // 形状固定住了，只有普通 HTTP 才存在「换个动词打同一条路径」和「请求体过大」两种失败。
  'method_not_allowed',
  'payload_too_large',
  // 兜底两类：领域主动拒绝与未预期异常
  'domain_error',
  'internal_error',
] as const

export type SandboxMcpStableErrorCode = typeof STABLE_ERROR_CODES[number]

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isSandboxMcpScope(value: unknown): value is SandboxMcpScope {
  return typeof value === 'string' && ALL_SCOPES.includes(value as SandboxMcpScope)
}

function normalizeScopes(scopes: unknown, fallback?: SandboxMcpScope[]): SandboxMcpScope[] {
  const source = Array.isArray(scopes) ? scopes : []
  const normalized = [...new Set(source.filter(isSandboxMcpScope))]
  if (normalized.length) return normalized
  if (fallback?.length) return [...fallback]
  throw new SandboxMcpError('invalid_arguments', '至少选择一项有效权限')
}

function toPublicCredential(credential: SandboxTestCredential): Omit<SandboxTestCredential, 'tokenDigest'> {
  const { tokenDigest: _tokenDigest, ...publicCredential } = credential
  return structuredClone(publicCredential)
}

function toCreatedCredential(credential: SandboxTestCredential): SandboxTestCreatedCredential {
  if (!credential.token) throw new SandboxMcpError('internal_error', '凭证缺少明文 Token')
  return { ...toPublicCredential(credential), token: credential.token }
}

// sha256 摘要的唯一合法形状。长度不合规的摘要会让 timingSafeEqual 抛
// ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，因此坏摘要必须在进内存之前就被拒绝。
const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/

function isTokenDigest(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_DIGEST_PATTERN.test(value)
}

function normalizeStoredCredential(value: unknown): SandboxTestCredential | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string' || !isTokenDigest(record.tokenDigest) || typeof record.createdAt !== 'string') return undefined
  if (!Array.isArray(record.scopes)) return undefined
  return {
    id: record.id,
    name: record.name,
    scopes: normalizeScopes(record.scopes, ['read']),
    enabled: record.enabled !== false,
    // 旧记录只有摘要，明文无法恢复；新记录必须带 token，供控制台再次查看。
    ...(typeof record.token === 'string' && record.token ? { token: record.token } : {}),
    tokenDigest: record.tokenDigest,
    createdAt: record.createdAt,
  }
}

interface IdempotencyEntry {
  argumentsHash: string
  result: unknown
  expiresAt: number
  /** 写入时所在的作用域；破坏性操作只清掉同一作用域的条目。 */
  scope: string
}

/** 事件、幂等缓存与确认令牌的作用域键：测试空间按空间标识，主场景固定为 `main`。 */
function scopeKey(spaceId: string | undefined): string {
  return spaceId ?? 'main'
}

export class SandboxMcpService {
  private credentials: SandboxTestCredential[] = []
  private events: SandboxMcpEvent[] = []
  private callRecords: SandboxTestCallRecord[] = []
  // 纪元只在进程启动时生成一次：序号在纪元内全局单调，游标跨空间通用。破坏性操作不再轮转纪元，
  // 而是给它所在的作用域（某个测试空间或主场景）画一道失效线，见 `invalidateScope`。
  private epoch = randomUUID()
  private sequence = 0
  /** 各作用域最近一次破坏性操作完成时的序号；早于它的游标只在该作用域内失效。 */
  private scopeBarriers = new Map<string, number>()
  // 只缓存媒体元数据。正文由 SandboxMediaStorage 按内容寻址落盘，发送时从磁盘读取；
  // 在这里保留 dataBase64 既会让每次上传常驻十几 MB 内存，也会让附加字段随
  // send_message 一路写进场景快照与数据库。按插入顺序限量，避免长会话无界增长。
  private uploadedMedia = new Map<string, SandboxMedia>()
  // 幂等缓存同样按插入顺序限量并附带有效期。每条都持有结果的 structuredClone，而
  // apply_environment_changes 的结果里带完整场景快照；只在 invalidateScope 时清空意味着
  // 不做破坏性操作的长跑会话会让它无界增长。上限与有效期见 ADR-0021。
  private idempotency = new Map<string, IdempotencyEntry>()
  private confirmations = new Map<string, SandboxMcpConfirmation & { scope: string }>()
  private credentialFile: string
  private eventLimit: number
  private callRecordLimit: number
  private uploadedMediaLimit: number
  private idempotencyLimit: number
  private idempotencyTtlMs: number
  /** 四档调用频率上限，键与条目上的配额档同名。 */
  private rateLimits: Record<SandboxMcpToolQuota, number>
  private rateWindows = new Map<string, number[]>()
  private activeCalls = new Map<string, number>()
  private activityListeners = new Set<(running: boolean) => void>()
  private activityRunning = false
  /** 三档并发上限。只读档不设上限，因此它不在这张表里。 */
  private concurrentLimits: Record<Exclude<SandboxMcpToolQuota, 'read'>, number>
  private testSpaces?: SandboxTestSpaceService
  private unattributedModelRequests?: SandboxModelRequestStore
  /** 被测机器人当前的唤醒规则；工具声明、测试指南与 `get_wakeup_rules` 都问它。 */
  private wakeup: SandboxWakeupReader
  /**
   * 「谁是全部记录域」的唯一答案，与 Console 注册处各自从同样三个输入包一份。
   *
   * 判空在此吸收一次：`testSpaces` 与 `unattributedModelRequests` 缺席就是目录里少一个成员。
   */
  private scopes: ScopeDirectory

  constructor(private ctx: Context, private control: SandboxControlService, options: SandboxMcpServiceOptions) {
    this.testSpaces = options.testSpaces
    this.unattributedModelRequests = options.unattributedModelRequests
    // 默认读本服务所在实例的被测运行时。每次读取都现取，因此被测插件重载或改配置后无需重启端点。
    this.wakeup = options.wakeup ?? new SandboxChatLunaWakeup(() => readSandboxResponderRuntimes(ctx))
    this.scopes = createScopeDirectory({
      control,
      testSpaces: options.testSpaces,
      unattributedModelRequests: options.unattributedModelRequests,
    })
    mkdirSync(options.dataDirectory, { recursive: true })
    this.credentialFile = join(options.dataDirectory, 'test-credentials.json')
    this.eventLimit = options.eventLimit ?? 1000
    this.callRecordLimit = options.callRecordLimit ?? 500
    this.uploadedMediaLimit = options.uploadedMediaLimit ?? 256
    // 容量取 500，与调用记录同一量级：默认状态修改档上限是 60 次/分钟，500 条覆盖八分钟以上的
    // 满速修改，远超一次正常测试编排的调用数。有效期取 30 分钟：幂等键存在的理由是响应在网络上
    // 丢失后的重试，那是秒级的动作，单次调用最长也只有 120 秒的等待超时。
    // 两项都可覆盖，但覆盖后对外声明会同步改写（见 describeTools），不会与实际配置漂移。
    this.idempotencyLimit = options.idempotencyLimit ?? 500
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 30 * 60_000
    this.rateLimits = {
      read: options.readPerMinute ?? 120,
      mutation: options.mutationPerMinute ?? 60,
      wait: options.waitPerMinute ?? 120,
      upload: options.uploadPerMinute ?? 30,
    }
    this.concurrentLimits = {
      mutation: options.maxConcurrentMutations ?? 4,
      wait: options.maxConcurrentWaits ?? 8,
      upload: options.maxConcurrentUploads ?? 2,
    }
    this.loadCredentials()
    this.observeControl(this.control)
    this.testSpaces?.onSpaceCreated((spaceId, control) => this.observeControl(control, spaceId))
    this.testSpaces?.onOccupationChange(() => this.syncActivity())
    this.syncActivity()
  }

  private observeControl(control: SandboxControlService, spaceId?: string): void {
    // 消息事件统一在此处从场景 diff 产生：被测机器人经 Koishi 适配器主动回复的
    // 消息不会经过 MCP 的 send_message，只有场景变更回调可见；若只发 scene.changed，
    // wait_for_message（匹配 message.created）将永远等不到机器人回复。
    const seenMessageIds = new Set(control.getSnapshot().messages.map(({ id }) => id))
    const recalledMessageIds = new Set(
      control.getSnapshot().messages.filter((message) => isRecalledMessage(message)).map(({ id }) => id),
    )
    // ChatLuna 状态同样从 diff 产生。它是不落场景快照的瞬时状态，但每次变化都会触发场景变更通知，
    // 因此这里能拿到全部变化。只有把状态变更并入事件流，wait_for_chatluna_state 才能真的按
    // cursor.sequence 定位；直接读当前状态会把上一轮已经结束的状态当成本轮结果（getChatLunaStates
    // 保留 thinking=false 的已结束状态，它不是只返回活跃状态）。
    const chatLunaFingerprints = new Map(control.getChatLunaStates().map((state) => [
      `${state.botParticipantId}:${state.conversationId}`,
      stableValue(state),
    ]))
    control.onSceneMutation((snapshot) => {
      this.appendEvent('scene.changed', { revision: snapshot.revision }, spaceId)
      for (const message of snapshot.messages) {
        if (seenMessageIds.has(message.id)) continue
        seenMessageIds.add(message.id)
        // 此处不查投递记录：投递在 middleware 完成后才登记，场景通知时必然拿不到；
        // 带 recipientBotId 的投递事件由 send_message 等待投递完成后单独补发。
        this.appendEvent('message.created', message, spaceId)
      }
      // 撤回是生命周期变化：外部测试控制器可精确等待 message.recalled，并读取权威原文复盘。
      for (const message of snapshot.messages) {
        if (!isRecalledMessage(message) || recalledMessageIds.has(message.id)) continue
        recalledMessageIds.add(message.id)
        this.appendEvent('message.recalled', message, spaceId)
      }
      for (const state of control.getChatLunaStates()) {
        const key = `${state.botParticipantId}:${state.conversationId}`
        const fingerprint = stableValue(state)
        if (chatLunaFingerprints.get(key) === fingerprint) continue
        chatLunaFingerprints.set(key, fingerprint)
        this.appendEvent('chatluna.state', state, spaceId)
      }
    })
    // OneBot 调试记录并入事件流，wait_for_onebot_action 才能等待插件真实发起的调用，
    // 而不必轮询 list_onebot_debug_records。
    control.onOneBotDebugRecord((record) => this.appendEvent(`onebot.${record.direction}`, record, spaceId))
  }

  createCredential(name: string, scopes: SandboxMcpScope[] = ['read']): SandboxTestCreatedCredential {
    const normalizedName = requireString(name, '凭证名称')
    const token = randomBytes(32).toString('base64url')
    const credential: SandboxTestCredential = {
      id: randomUUID(),
      name: normalizedName,
      scopes: normalizeScopes(scopes, ['read']),
      enabled: true,
      token,
      tokenDigest: digestToken(token),
      createdAt: new Date().toISOString(),
    }
    this.credentials.push(credential)
    this.saveCredentials()
    return toCreatedCredential(credential)
  }

  listCredentials(): Array<Omit<SandboxTestCredential, 'tokenDigest'>> {
    return this.credentials.map((credential) => toPublicCredential(credential))
  }

  getCredential(id: string): Omit<SandboxTestCredential, 'tokenDigest'> {
    return toPublicCredential(this.requireStoredCredential(id))
  }

  updateCredential(id: string, input: { name?: string; scopes?: SandboxMcpScope[] }): Omit<SandboxTestCredential, 'tokenDigest'> {
    const credential = this.requireStoredCredential(id)
    if (input.name !== undefined) credential.name = requireString(input.name, '凭证名称')
    if (input.scopes !== undefined) credential.scopes = normalizeScopes(input.scopes)
    this.saveCredentials()
    return toPublicCredential(credential)
  }

  rotateCredentialToken(id: string): SandboxTestCreatedCredential {
    const credential = this.requireStoredCredential(id)
    const token = randomBytes(32).toString('base64url')
    credential.token = token
    credential.tokenDigest = digestToken(token)
    this.saveCredentials()
    return toCreatedCredential(credential)
  }

  setCredentialEnabled(id: string, enabled: boolean): void {
    const credential = this.requireStoredCredential(id)
    credential.enabled = enabled
    this.saveCredentials()
  }

  revokeCredential(id: string): void {
    const index = this.credentials.findIndex((item) => item.id === id)
    if (index < 0) throw new SandboxMcpError('credential_not_found', `凭证不存在：${id}`)
    this.credentials.splice(index, 1)
    // 频率窗口按 `凭证:档位` 建键，吊销后那些键再不会被读到；反复创建与吊销凭证是它唯一的单调增长源。
    for (const key of this.rateWindows.keys()) {
      if (key.startsWith(`${id}:`)) this.rateWindows.delete(key)
    }
    this.saveCredentials()
  }

  authenticate(token: string): SandboxTestCredential | undefined {
    const digest = Buffer.from(digestToken(token), 'hex')
    // 长度不合规的摘要一律视为不匹配。timingSafeEqual 在长度不等时会抛异常，而这里的调用点在
    // 传输层的 try 之外，抛出会变成 unhandled rejection 加请求挂死；存储侧已经拦掉这类条目，
    // 这一层是为绕过存储进到内存的情况兜底。
    return this.credentials.find((credential) => credential.enabled
      && isTokenDigest(credential.tokenDigest)
      && timingSafeEqual(digest, Buffer.from(credential.tokenDigest, 'hex')))
  }

  listTools(token: string): SandboxMcpToolCapability[] {
    const credential = this.requireCredential(token)
    return this.describeTools().filter(({ scope }) => credential.scopes.includes(scope))
  }

  /**
   * 工具清单的对外形态。
   *
   * 注册表是模块级常量，写不进实例配置，也读不到被测插件的运行时；幂等窗口的数值由 `idempotencyLimit`
   * 与 `idempotencyTtlMs` 决定，被测机器人的唤醒方式由当前装着的响应插件决定。所有对外读取工具声明的
   * 路径（`listTools`、`getCapabilityCatalog`、`onebot-sandbox://guide`）都经这里，声明因此不可能与
   * 实际配置漂移。
   */
  private describeTools(): SandboxMcpToolCapability[] {
    const window = this.idempotencyWindowDescription()
    // 唤醒指引整份清单只读一次：一次 tools/list 里的每个工具都问一遍运行时既无必要，也会让同一次
    // 响应里出现两份不同时刻的答案。
    const wakeup = this.wakeup.read().guidance
    return SANDBOX_MCP_TOOL_DECLARATIONS.map((declaration) => {
      const clone = structuredClone(declaration)
      const schema = clone.inputSchema as { description?: string; properties?: Record<string, { description?: string }> }
      if (schema.properties?.idempotencyKey) schema.properties.idempotencyKey.description = window
      // 按 schema 形状选注入点而不是按工具名：带消息正文参数的工具就是「正文要写成什么才能唤醒被测
      // 机器人」的那一个，而工具名不参与任何判定（ADR-0086 的守卫规则）。今后新增带正文的工具会自动
      // 带上指引，这正是期望行为。
      if (schema.properties?.content) schema.description = [schema.description, wakeup].filter(Boolean).join(' ')
      return clone
    })
  }

  private idempotencyWindowDescription(): string {
    const validity = this.idempotencyTtlMs >= 60_000
      ? `${Math.round(this.idempotencyTtlMs / 60_000)} 分钟`
      : `${Math.round(this.idempotencyTtlMs / 1000)} 秒`
    return `幂等键；使用相同键重放时参数必须逐字段一致。首次结果缓存有效期 ${validity}，且全实例最多保留 ${this.idempotencyLimit} 条、超出时淘汰最早写入的一条；超出有效期或被淘汰后，同键重放会重新执行操作而不是返回首次结果`
  }

  getCapabilityCatalog(): SandboxMcpCapabilityCatalog {
    return {
      serverCapabilities: { tools: true, resources: true, prompts: false },
      scopes: [...ALL_SCOPES],
      tools: this.describeTools(),
      resources: structuredClone(READ_RESOURCES),
    }
  }

  listResources(token: string) {
    const credential = this.requireCredential(token)
    return credential.scopes.includes('read') ? structuredClone(READ_RESOURCES) : []
  }

  readResource(token: string, uri: string): unknown {
    this.requireScope(this.requireCredential(token), 'read')
    // 指南带上唤醒规则：工具清单只说「怎么调用工具」，而「消息要写成什么样被测机器人才会回复」是
    // 一次测试能不能开始的前提，两者一起读到才是完整的开工信息。
    if (uri === 'onebot-sandbox://guide') return { testApiVersion: 1, tools: this.describeTools(), wakeup: this.wakeup.read() }
    if (uri === 'onebot-sandbox://scene-schema') return { testApiVersion: { const: 1 }, scene: { type: 'object' } }
    if (uri === 'onebot-sandbox://capabilities/napcat') return readCapabilityMatrix(this.control, 'napcat')
    if (uri === 'onebot-sandbox://capabilities/llbot') return readCapabilityMatrix(this.control, 'llbot')
    if (uri === 'onebot-sandbox://errors') return [...STABLE_ERROR_CODES]
    if (uri === 'onebot-sandbox://events') return [...SANDBOX_MCP_EVENT_TYPES]
    if (uri === 'onebot-sandbox://examples') return {
      create_test_space: {
        name: '退群公告测试',
        idempotencyKey: 'example-space-1',
      },
      apply_environment_changes: {
        spaceId: '<create_test_space.spaceId>',
        expectedRevision: 0,
        idempotencyKey: 'example-environment-1',
        changes: [
          { action: 'create-user', data: { id: '10001', name: '测试用户' } },
          { action: 'create-bot', data: { id: '20002', name: '被测机器人', implementation: 'napcat' } },
          { action: 'set-friendship', data: { firstId: '10001', secondId: '20002' } },
        ],
      },
      唤醒被测机器人: {
        说明: '被测机器人只在唤醒条件成立时回复，条件由 ChatLuna v2 的路由规则（chat.activation、chat.engine、chat.merge）决定，与沙盒无关。先读一次规则，再按它给出的方式写 content：不要假设 @ 一定有效（激活判定器可以关掉它），也不要假设回复一定即时（等待发送完毕的合并方式要等发言者静默，character 引擎还会自主插话）。',
        步骤: [
          { tool: 'get_wakeup_rules', arguments: { spaceId: '<spaceId>', conversationId: 'group:30001' } },
          { tool: 'send_message', arguments: { spaceId: '<spaceId>', operatorId: '10001', conversationId: 'group:30001', content: '<at id="20002"/> 你好', idempotencyKey: 'example-wakeup-1' } },
        ],
      },
      send_message: {
        spaceId: '<create_test_space.spaceId>',
        operatorId: '10001',
        conversationId: 'private:10001:20002',
        content: '你好',
        idempotencyKey: 'example-message-1',
      },
      send_forward_message: {
        spaceId: '<create_test_space.spaceId>',
        operatorId: '10001',
        conversationId: 'private:10001:20002',
        messageIds: ['<send_message.messageId>', '<另一条可见消息 ID>'],
        idempotencyKey: 'example-forward-1',
      },
      get_forward_message: {
        spaceId: '<create_test_space.spaceId>',
        operatorId: '10001',
        forwardId: '<send_forward_message.forwardId>',
      },
      自定义媒体转发节点: {
        说明: '先用 upload_media 上传媒体，再把 mediaId 放进 custom node；嵌套转发使用已有 forwardId。',
        send_forward_message: {
          spaceId: '<spaceId>', operatorId: '10001', conversationId: 'private:10001:20002', idempotencyKey: 'example-forward-2',
          nodes: [{ type: 'custom', userId: '10001', nickname: '测试用户', content: '图片节点', mediaIds: ['<upload_media.mediaId>'], forwardId: '<可选嵌套 forwardId>' }],
        },
      },
      等待机器人回复: {
        说明: '发送与关系操作类工具都会等待被测机器人的同步处理完成才返回，回复可能在返回前已进入事件流。把它们返回的 cursorBefore 传给等待类工具即可，不必自己先取一次游标；用它们返回的 cursor 会错过同步回复。等待结果用 outcome 区分：matched 时带载荷，timeout 时带 reason。',
        步骤: [
          { tool: 'send_message', arguments: { spaceId: '<spaceId>', operatorId: '10001', conversationId: 'private:10001:20002', content: 'help', idempotencyKey: 'example-message-2' }, 得到: 'cursorBefore' },
          { tool: 'wait_for_message', arguments: { spaceId: '<spaceId>', cursor: '<send_message.cursorBefore>', conversationId: 'private:10001:20002', authorId: '20002', timeoutSeconds: 30 }, 得到: 'outcome=matched 时的 event' },
        ],
      },
      等待ChatLuna思考状态: {
        说明: 'thinking=true 是瞬时状态，但状态变更会进入事件流，因此用 send_message 返回的 cursorBefore 就能在它返回后补等到，不必并发启动等待，也不会匹配到上一轮已经结束的状态。outcome=matched 时结果带 state。',
        步骤: [
          { tool: 'send_message', arguments: { spaceId: '<spaceId>', operatorId: '10001', conversationId: 'private:10001:20002', content: 'chatluna.chat 你好', idempotencyKey: 'example-chatluna-1' }, 得到: 'cursorBefore' },
          { tool: 'wait_for_chatluna_state', arguments: { spaceId: '<spaceId>', cursor: '<send_message.cursorBefore>', botParticipantId: '20002', conversationId: 'private:10001:20002', thinking: false, timeoutSeconds: 30 } },
        ],
      },
      等待机器人最终回复: {
        说明: '机器人常先回一条「稍等」再给最终结果。传 settleSeconds 后会持续收集同条件消息，直到静默期内不再出现新消息；outcome=matched 时 event 是最后一条，events 是完整序列。不传 settleSeconds 时结果里没有 events。',
        wait_for_message: { spaceId: '<spaceId>', cursor: '<send_message.cursorBefore>', conversationId: 'private:10001:20002', authorId: '20002', settleSeconds: 5, timeoutSeconds: 60 },
      },
      断言插件发起的_OneBot_action: {
        说明: '机器人回复文本可能与实际执行结果不一致；要确认某次交互是否真的调用了 action 及其成败，用那次操作返回的 cursorBefore 等待 onebot.action 事件。outcome=matched 时结果直接带调试记录 record。',
        wait_for_onebot_action: { spaceId: '<spaceId>', cursor: '<perform_group_action.cursorBefore>', botId: '20002', action: 'set_group_kick', timeoutSeconds: 30 },
      },
      翻页读记录: {
        说明: '四个 list 工具用同一套分页：只有 limit 与 pageCursor，结果给 items 与 nextPageCursor。游标是服务端编码的不透明字符串，原样传回即可续页；结果里没有 nextPageCursor 就是到底了。它带记录种类标记，跨族传递会被判为参数错误。',
        步骤: [
          { tool: 'list_model_request_records', arguments: { scope: 'all', limit: 20 }, 得到: 'nextPageCursor' },
          { tool: 'list_model_request_records', arguments: { scope: 'all', limit: 20, pageCursor: '<上一页的 nextPageCursor>' } },
        ],
      },
      群聊触发命令: {
        说明: '群聊中触发 Koishi 命令通常需要 at 机器人；content 支持 <at id="参与者ID"/> 元素。',
        send_message: { spaceId: '<spaceId>', operatorId: '10001', conversationId: 'group:30001', content: '<at id="20002"/> help', idempotencyKey: 'example-message-3' },
      },
    }
    throw new SandboxMcpError('resource_not_found', `资源不存在：${uri}`)
  }

  currentCursor(): SandboxMcpEventCursor {
    return { epoch: this.epoch, sequence: this.sequence }
  }

  /**
   * 主场景版本。只服务于「尚无空间可指」的场合——传输层在凭证校验阶段抛出的错误信封。
   * 工具调用失败的信封版本由 `callTool` 回填到 SandboxMcpError 上，不走这里。
   */
  getRevision(): number {
    return this.control.getSnapshot().revision
  }

  isActivityRunning(): boolean {
    return this.activityRunning
  }

  onActivity(listener: (running: boolean) => void): () => void {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  /**
   * 执行一次工具调用。这是外部编排的唯一入口，读起来是一条直线。
   *
   * 查注册表、校权限范围、扣配额、过并发闸门、按标记包幂等或确认令牌、执行、写测试调用记录、
   * 归一化错误并回填场景版本。工具名不出现在这条路径的任何判定里：分类与标记都是条目上的字段，
   * 因此想给某个工具开特例的人没有地方可写。
   *
   * 两种协议表述（MCP Streamable HTTP 与 HTTP 测试接口）都只经这里，因此权限、配额、并发、幂等
   * 与测试调用记录不存在第二份实现（ADR-0081）。`context.transport` 只用于标注记录与
   * `get_server_info` 的自述，不参与任何权限或配额判定：同一个凭证在两种表述下拥有完全相同的
   * 能力与额度。
   */
  async callTool(token: string, tool: string, argumentsValue: unknown, context: SandboxTestCallContext = {}): Promise<unknown> {
    const credential = this.requireCredential(token)
    const args = asRecord(argumentsValue)
    const transport = context.transport ?? 'mcp'
    const startedAt = Date.now()
    try {
      const entry = findSandboxMcpTool(tool)
      if (!entry) throw new SandboxMcpError('tool_not_found', `工具不存在：${tool}`)
      this.requireScope(credential, entry.scope)
      this.consumeRateLimit(credential.id, entry.quota, this.rateLimits[entry.quota])
      // 只读档不占并发闸门：四档配额里只有这一档不设并发上限。这是配额档与并发档唯一的差异，
      // 因此它写在这里一行，而不是在每个工具上多写一个字段。
      const result = entry.quota === 'read'
        ? await this.executeTool(credential, entry, args, transport)
        : await this.withConcurrency(credential.id, entry.quota, () => this.executeTool(credential, entry, args, transport))
      this.appendCallRecord(credential, tool, args, context.sourceIp, transport, 'success', result, undefined, Date.now() - startedAt)
      return result
    } catch (error) {
      const normalized = this.normalizeToolError(tool, error)
      // 记录 ID 就是对外的 traceId：消费者拿错误信封里的 traceId 调 get_test_call_record
      // 即可取回这次失败的记录。此前信封里的 traceId 是当场生成的随机值，与任何记录都对不上。
      normalized.traceId = this.appendCallRecord(credential, tool, args, context.sourceIp, transport, 'error', undefined, normalized, Date.now() - startedAt)
      // 场景版本走同一条回填路径：传输层此前无条件读主场景，测试空间里的失败会报错的乐观并发基线。
      normalized.revision = this.revisionForScope(args)
      throw normalized
    }
  }

  /**
   * 按条目上的两个标记包裹执行体。
   *
   * 幂等与确认令牌是两个独立标记：十一个工具要幂等，四个要确认令牌，上传媒体与准备确认令牌两个
   * 都不要。今天没有工具同时命中两者，因此这里的组合顺序不可观察；定死成「确认在外、幂等在内」，
   * 真出现同时命中的工具时改这一处即可。不合成三态枚举去表达一种不存在的状态。
   */
  private async executeTool(
    credential: SandboxTestCredential,
    entry: SandboxMcpToolEntry,
    args: Record<string, unknown>,
    transport: SandboxTestCallTransport,
  ): Promise<unknown> {
    const runtime = this.createToolRuntime(credential, entry, args, transport)
    if (entry.requiresConfirmation) return await this.withConfirmation(runtime, entry, args)
    if (entry.idempotent) return await this.withIdempotency(credential.id, entry.name, args, runtime.spaceId, async () => await entry.run(runtime, args))
    return await entry.run(runtime, args)
  }

  /** 把服务实例的能力收成执行体看得见的那一份窄运行时。 */
  private createToolRuntime(
    credential: SandboxTestCredential,
    entry: SandboxMcpToolEntry,
    args: Record<string, unknown>,
    transport: SandboxTestCallTransport,
  ): SandboxMcpToolRuntime {
    const spaceId = readSpaceId(args)
    const control = entry.spaceResolution === 'none'
      ? this.control
      : this.resolveControl(args, entry.spaceResolution === 'mutation')
    return {
      control,
      transport,
      credentialId: credential.id,
      spaceId,
      scopes: this.scopes,
      currentCursor: () => this.currentCursor(),
      appendEvent: (type, data, eventSpaceId = spaceId) => this.appendEvent(type, data, eventSpaceId),
      waitFor: (waitArgs, predicate) => this.waitFor(waitArgs, predicate),
      readWakeupRules: (targets) => this.wakeup.read(targets),
      requireTestSpaces: () => this.requireTestSpaces(),
      requireUnattributedModelRequests: () => this.requireUnattributedModelRequests(),
      resolveControl: (targetSpaceId, mutation) => this.resolveControl({ spaceId: targetSpaceId }, mutation),
      rememberUploadedMedia: (mediaId, media) => this.rememberUploadedMedia(this.mediaCacheKey(spaceId, mediaId), media),
      findUploadedMedia: (mediaId) => this.uploadedMedia.get(this.mediaCacheKey(spaceId, mediaId)),
      rememberConfirmation: (token, confirmation) => this.rememberConfirmation(token, { ...confirmation, scope: scopeKey(spaceId) }),
      listCallRecords: (input) => this.listCallRecords(input),
      getCallRecord: (recordId) => this.getCallRecord(recordId),
      clearCallRecords: () => this.clearCallRecords(),
    }
  }

  /**
   * 校验版本绑定的一次性确认令牌，执行破坏性操作，随后让该作用域此前的游标失效。
   *
   * 返回的信封由这里统一给出而不是由执行体给出：四个破坏性工具对外都只答「新版本与新游标」，
   * 执行体因此只负责改场景。失效线画在执行之后，因此消费者拿到的游标必然在线上。
   *
   * 令牌只在校验通过时消耗：参数或工具写错的调用不执行任何操作，令牌留给改正后的重试；
   * 每种失败各给一句原因，调用方不必猜是令牌失效还是参数写错。
   */
  private async withConfirmation(
    runtime: SandboxMcpToolRuntime,
    entry: SandboxMcpToolEntry,
    args: Record<string, unknown>,
  ): Promise<{ revision: number; cursor: SandboxMcpEventCursor }> {
    const token = requireString(args.confirmationToken, 'confirmationToken')
    const confirmation = this.confirmations.get(token)
    const reissue = '请重新调用 prepare_destructive_action 获取令牌。'
    if (!confirmation || confirmation.credentialId !== runtime.credentialId) {
      throw new SandboxMcpError('confirmation_required', '破坏性操作需要有效的一次性确认令牌', false, reissue)
    }
    if (confirmation.expiresAt < Date.now()) {
      this.confirmations.delete(token)
      throw new SandboxMcpError('confirmation_required', '确认令牌已过期', false, reissue)
    }
    if (confirmation.tool !== entry.name) {
      throw new SandboxMcpError('confirmation_required', `确认令牌签发给 ${confirmation.tool}，不能用于 ${entry.name}`, false, '令牌仍然有效，请用签发时的工具调用。')
    }
    if (confirmation.revision !== runtime.control.getSnapshot().revision) {
      this.confirmations.delete(token)
      throw new SandboxMcpError('confirmation_required', '签发确认令牌后场景版本已变化，令牌已作废', false, reissue)
    }
    // 参数绑定取业务参数指纹：令牌自身与调用标注参数都不参与，因此签发时的 `arguments` 只需逐字段
    // 写出这次操作要做什么，不必连带复述编排标注（ADR-0097）。
    if (confirmation.argumentsHash !== argumentsFingerprint(args)) {
      throw new SandboxMcpError('confirmation_required', '调用参数与签发确认令牌时的 arguments 不一致', false, '令牌仍然有效，请按签发时的 arguments 逐字段调用。')
    }
    this.confirmations.delete(token)
    await entry.run(runtime, args)
    this.invalidateScope(runtime.spaceId)
    return { revision: runtime.control.getSnapshot().revision, cursor: this.currentCursor() }
  }

  /**
   * 失败调用对应的场景版本。带 spaceId 时取该空间的版本，否则取主场景版本；
   * 空间已不可解析（不存在、已删除）时退回主场景版本，因为此时没有更准确的值可给。
   */
  private revisionForScope(args: Record<string, unknown>): number {
    const spaceId = typeof args.spaceId === 'string' && args.spaceId.trim() ? args.spaceId.trim() : undefined
    if (spaceId && this.testSpaces) {
      try {
        return this.testSpaces.getControl(spaceId).getSnapshot().revision
      } catch {
        return this.control.getSnapshot().revision
      }
    }
    return this.control.getSnapshot().revision
  }

  /**
   * 按 ADR-0027 把抛出的异常分成三类。
   *
   * 结构化的 `SandboxMcpError` 原样透出；领域主动作出的业务拒绝（`SandboxDomainError`）保留
   * `domain_error` 与原始消息，因为「只有群主可以踢人」这类判定对外部测试控制器有用；其余一切
   * 都是未预期异常，只返回 `internal_error` 且不携带原始 message——`TypeError` 的文案对消费者
   * 没有意义，还可能泄漏实现细节，堆栈改为写进 Koishi Logger 供维护者定位。
   */
  private normalizeToolError(tool: string, error: unknown): SandboxMcpError {
    if (error instanceof SandboxMcpError) return error
    if (error instanceof SandboxSpaceNotFoundError) return new SandboxMcpError('space_not_found', error.message, false, '请调用 list_test_spaces 确认空间标识。')
    if (error instanceof SandboxDomainError) return new SandboxMcpError('domain_error', error.message)
    this.ctx.logger('onebot-sandbox').error('%s\n%s', `MCP 工具 ${tool} 抛出未预期异常。`, errorDetail(error))
    return new SandboxMcpError('internal_error', '工具调用发生未预期异常，详情见 Koishi 日志。', false, '请携带错误信封里的 traceId 反馈该缺陷。')
  }

  listCallRecords(input: ListSandboxTestCallRecordsInput = {}): SandboxTestCallRecordsPage {
    const records = this.callRecords
      .filter((record) => matchesTestCallRecordFilter(record, input))
      .map(toTestCallRecordListItem)
    return { records: input.order === 'asc' ? records : records.reverse() }
  }

  getCallRecord(recordId: string): SandboxTestCallRecord {
    const record = this.callRecords.find(({ id }) => id === recordId)
    if (!record) throw new SandboxMcpError('record_not_found', `测试调用记录不存在：${recordId}`)
    return presentTestCallRecord(record)
  }

  clearCallRecords(): { cleared: number } {
    const cleared = this.callRecords.length
    this.callRecords = []
    return { cleared }
  }

  private rememberUploadedMedia(key: string, media: SandboxMedia): void {
    // 先删后加，让 Map 的插入顺序反映最近使用，淘汰的总是最旧的上传。
    this.uploadedMedia.delete(key)
    this.uploadedMedia.set(key, media)
    while (this.uploadedMedia.size > this.uploadedMediaLimit) {
      const oldest = this.uploadedMedia.keys().next()
      if (oldest.done) break
      this.uploadedMedia.delete(oldest.value)
    }
  }

  /** 上传媒体的缓存键：同一个媒体标识在不同空间里各自成条，避免跨空间引用。 */
  private mediaCacheKey(spaceId: string | undefined, mediaId: string): string {
    return `${spaceId ?? 'main'}:${mediaId}`
  }

  private async waitFor(args: Record<string, unknown>, predicate: (event: SandboxMcpEvent) => boolean): Promise<SandboxMcpWaitResult> {
    const cursor = asRecord(args.cursor)
    if (cursor.epoch !== this.epoch) throw new SandboxMcpError('cursor_expired', '事件游标已过期', false, '请重新读取当前游标。')
    // 游标序号与超时秒数都必须先判类型：非数值经 `Number(...)` 会变成 NaN，而 NaN 参与的比较全为
    // false，于是坏序号让每个事件都匹配不上、坏超时让 setTimeout 立刻触发。两者都表现为「等到超时
    // 也没有事件」，与真的没等到完全一样，消费者据此得出的是错的结论而不是一次可重试的失败。
    const sequence = requireNumber(cursor.sequence, 'cursor.sequence')
    if (this.events.length && sequence < this.events[0].cursor.sequence - 1) throw new SandboxMcpError('cursor_expired', '事件游标已离开缓冲区')
    const spaceId = readSpaceId(args)
    const barrier = this.scopeBarriers.get(scopeKey(spaceId))
    if (barrier !== undefined && sequence < barrier) {
      throw new SandboxMcpError('cursor_expired', '事件游标早于该作用域最近一次破坏性操作', false, '请改用破坏性操作返回的 cursor，或调用 get_server_info 取当前游标。')
    }
    const timeoutMs = requireNumber(args.timeoutSeconds, 'timeoutSeconds', { fallback: 30, min: 1, max: 120 }) * 1000
    const matches = () => this.events.find((event) => event.cursor.sequence > sequence && event.spaceId === spaceId && predicate(event))
    const existing = matches()
    if (existing) return { outcome: 'matched', event: existing, cursor: existing.cursor }
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const event = matches()
        if (!event) return
        clearInterval(timer)
        clearTimeout(timeout)
        resolve({ outcome: 'matched', event, cursor: event.cursor })
      }, 20)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        resolve({ outcome: 'timeout', reason: 'timeout', cursor: this.currentCursor() })
      }, timeoutMs)
    })
  }

  private async withIdempotency(credentialId: string, tool: string, args: Record<string, unknown>, spaceId: string | undefined, action: () => Promise<unknown>) {
    const key = requireString(args.idempotencyKey, 'idempotencyKey')
    const cacheKey = `${credentialId}:${this.epoch}:${tool}:${key}`
    const argumentsHash = argumentsFingerprint(args)
    const cached = this.idempotency.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.argumentsHash !== argumentsHash) throw new SandboxMcpError('idempotency_conflict', '幂等 Key 已被不同参数使用')
      return structuredClone(cached.result)
    }
    // 过期的条目按 ADR-0021 视为不存在：重放会重新执行操作，因此这里先丢弃再往下走。
    if (cached) this.idempotency.delete(cacheKey)
    const result = await action()
    this.rememberIdempotentResult(cacheKey, { argumentsHash, result: structuredClone(result), expiresAt: Date.now() + this.idempotencyTtlMs, scope: scopeKey(spaceId) })
    return result
  }

  private rememberIdempotentResult(cacheKey: string, entry: IdempotencyEntry): void {
    const now = Date.now()
    for (const [key, cached] of this.idempotency) {
      if (cached.expiresAt <= now) this.idempotency.delete(key)
    }
    // 按写入顺序淘汰，不按最近使用：TTL 从首次写入起算，命中重放不延长留存期，因此刷新顺序反而
    // 会让一条记录活得比它承诺的窗口更久。先删后加只是为了让重写的键回到队尾。
    this.idempotency.delete(cacheKey)
    this.idempotency.set(cacheKey, entry)
    while (this.idempotency.size > this.idempotencyLimit) {
      const oldest = this.idempotency.keys().next()
      if (oldest.done) break
      this.idempotency.delete(oldest.value)
    }
  }

  /**
   * 登记确认令牌，并顺手清掉已过期的条目。
   *
   * 令牌本来就 60 秒过期，过期后必然被 `withConfirmation` 判为无效，只是签发后不使用的令牌此前会
   * 永久留存。惰性清理纯属实现内务，行为零变化；不加条数上限，因为淘汰仍在有效期内的令牌会让
   * 已签发的确认凭空失效，那才是行为变更。留存量本身有界：签发要经状态修改档的频率上限。
   */
  private rememberConfirmation(token: string, entry: SandboxMcpConfirmation & { scope: string }): void {
    const now = Date.now()
    for (const [key, confirmation] of this.confirmations) {
      if (confirmation.expiresAt < now) this.confirmations.delete(key)
    }
    this.confirmations.set(token, entry)
  }

  private requireTestSpaces(): SandboxTestSpaceService {
    if (!this.testSpaces) throw new SandboxMcpError('test_spaces_unavailable', 'AI 测试空间服务不可用')
    return this.testSpaces
  }

  private requireUnattributedModelRequests(): SandboxModelRequestStore {
    if (!this.unattributedModelRequests) throw new SandboxMcpError('internal_error', '未归属模型请求库不可用')
    return this.unattributedModelRequests
  }

  private resolveControl(args: Record<string, unknown>, mutation: boolean): SandboxControlService {
    if (typeof args.spaceId !== 'string' || !args.spaceId.trim()) {
      if (mutation && this.testSpaces) throw new SandboxMcpError('space_id_required', 'MCP 修改操作必须显式指定 AI 测试空间', false, '请先调用 create_test_space，再携带返回的 spaceId。')
      return this.control
    }
    try {
      return mutation
        ? this.requireTestSpaces().requireAiControl(args.spaceId)
        : this.requireTestSpaces().requireReadable(args.spaceId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 测试空间不可用'
      // 三个空间态各自写成字面量抛出点，而不是先算出码再交给一个共用的 throw：
      // tests/mcp-error-code-contract.test.ts 的守卫靠扫描 `new SandboxMcpError('<码>'` 枚举实现
      // 可能发出的全部错误码，动态构造的码扫不到，只能靠测试侧白名单补，而白名单外新增的码会静默漏检。
      const recovery = '请重新读取空间状态后重试。'
      if (message.includes('用户接管')) throw new SandboxMcpError('space_taken_over', message, false, recovery)
      if (message.includes('不存在')) throw new SandboxMcpError('space_not_found', message, false, recovery)
      throw new SandboxMcpError('space_unavailable', message, false, recovery)
    }
  }

  private appendEvent(type: SandboxMcpEventType, data: unknown, spaceId?: string): SandboxMcpEventCursor {
    const cursor = { epoch: this.epoch, sequence: ++this.sequence }
    this.events.push({ cursor, spaceId, type, data: structuredClone(data), createdAt: new Date().toISOString() })
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit)
    return cursor
  }

  /**
   * 破坏性操作后让该作用域此前的游标、事件、幂等结果与确认令牌失效，其他空间与主场景不受影响。
   *
   * 此前这里轮转全局纪元，一个测试空间里的 `clear_scene` 会让所有并行空间手里的游标同时过期。
   * 序号继续全局递增，失效线就是当前序号：破坏性操作返回的游标恰好落在线上，仍然有效。
   */
  private invalidateScope(spaceId: string | undefined) {
    const scope = scopeKey(spaceId)
    this.scopeBarriers.set(scope, this.sequence)
    this.events = this.events.filter((event) => scopeKey(event.spaceId) !== scope)
    for (const [key, entry] of this.idempotency) {
      if (entry.scope === scope) this.idempotency.delete(key)
    }
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.scope === scope) this.confirmations.delete(token)
    }
  }

  private requireStoredCredential(id: string): SandboxTestCredential {
    const credential = this.credentials.find((item) => item.id === id)
    if (!credential) throw new SandboxMcpError('credential_not_found', `凭证不存在：${id}`)
    return credential
  }

  private requireCredential(token: string) {
    const credential = this.authenticate(token)
    if (!credential) throw new SandboxMcpError('unauthorized', 'Bearer 凭证无效或已禁用')
    return credential
  }

  private requireScope(credential: SandboxTestCredential, scope: SandboxMcpScope) {
    if (!credential.scopes.includes(scope)) throw new SandboxMcpError('permission_denied', `凭证缺少 ${scope} 权限`)
  }

  private appendCallRecord(
    credential: SandboxTestCredential,
    tool: string,
    args: Record<string, unknown>,
    sourceIp: string | undefined,
    transport: SandboxTestCallTransport,
    status: 'success' | 'error',
    result: unknown,
    error: SandboxMcpError | undefined,
    durationMs = 0,
  ): string {
    const affected = result && typeof result === 'object' && Array.isArray(Reflect.get(result, 'affected'))
      ? Reflect.get(result, 'affected').map(String)
      : []
    const spaceId = resolveTestCallSpaceId(args, result)
    const id = randomUUID()
    this.callRecords.push({
      id,
      createdAt: new Date().toISOString(),
      credentialName: credential.name,
      transport,
      sourceIp,
      tool,
      testRunId: typeof args.testRunId === 'string' ? args.testRunId : undefined,
      spaceId,
      durationMs,
      status,
      affected,
      errorCode: error?.code,
      arguments: redactTestCallValue(args),
      result: result === undefined ? undefined : redactTestCallValue(result),
      error: error ? summarizeTestCallError(error) : undefined,
    })
    if (this.callRecords.length > this.callRecordLimit) this.callRecords.splice(0, this.callRecords.length - this.callRecordLimit)
    return id
  }

  private consumeRateLimit(credentialId: string, category: SandboxMcpToolQuota, limit: number) {
    const key = `${credentialId}:${category}`
    const now = Date.now()
    const window = (this.rateWindows.get(key) ?? []).filter((timestamp) => timestamp > now - 60_000)
    if (window.length >= limit) {
      const retryAfterMs = Math.max(1, 60_000 - (now - window[0]))
      throw new SandboxMcpError('rate_limited', '调用频率超过凭证限制', true, '请在 retryAfterMs 后重试。', undefined, retryAfterMs)
    }
    window.push(now)
    this.rateWindows.set(key, window)
  }

  private hasOccupiedSpace() {
    return this.testSpaces?.isOccupied() ?? false
  }

  private syncActivity() {
    // 顶栏特效跟 AI 测试空间占用走：status=running 期间持续转，不随单次工具调用闪断。
    const running = this.hasOccupiedSpace()
    if (running === this.activityRunning) return
    this.activityRunning = running
    for (const listener of this.activityListeners) listener(running)
  }

  private async withConcurrency<T>(credentialId: string, category: Exclude<SandboxMcpToolQuota, 'read'>, action: () => Promise<T>): Promise<T> {
    const key = `${credentialId}:${category}`
    const active = this.activeCalls.get(key) ?? 0
    if (active >= this.concurrentLimits[category]) throw new SandboxMcpError('concurrency_limited', '并发调用超过凭证限制', true, '请等待现有调用结束后重试。', undefined, 100)
    this.activeCalls.set(key, active + 1)
    try {
      return await action()
    } finally {
      const remaining = (this.activeCalls.get(key) ?? 1) - 1
      if (remaining > 0) this.activeCalls.set(key, remaining)
      else this.activeCalls.delete(key)
    }
  }

  private loadCredentials() {
    try {
      const credentials = JSON.parse(readFileSync(this.credentialFile, 'utf8'))
      this.credentials = Array.isArray(credentials)
        ? credentials.flatMap((item) => {
          const credential = normalizeStoredCredential(item)
          return credential ? [credential] : []
        })
        : []
    } catch (error) {
      // 凭证存储损坏时必须安全地回到“无有效凭证”，不能让可选 MCP 能力阻断 WebQQ。
      // 但这条路径必须留下线索：否则管理员只看到 WebQQ 里凭证列表凭空空了。
      // 只记文件路径与失败原因，不记文件内容——内容里带明文 Token（ADR-0058）。
      this.credentials = []
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.ctx.logger('onebot-sandbox').warn('%s\n%s', `测试凭证文件读取失败，已回到无有效凭证：${this.credentialFile}`, errorDetail(error))
      }
    }
  }

  private saveCredentials() {
    // 直接覆盖原文件时写到一半崩溃就是坏文件，配合「读取失败回到无有效凭证」等于一次崩溃丢光全部凭证。
    // 写临时文件再 rename：同一文件系统内 rename 是原子的，读到的永远是完整的旧版或完整的新版。
    const temporaryFile = `${this.credentialFile}.tmp`
    writeFileSync(temporaryFile, `${JSON.stringify(this.credentials, null, 2)}\n`, { mode: 0o600 })
    // writeFileSync 的 mode 只在创建文件时生效，上次崩溃留下的临时文件会带着自己的权限被沿用；
    // 显式 chmod 保证搬过去的永远是 0o600。
    chmodSync(temporaryFile, 0o600)
    renameSync(temporaryFile, this.credentialFile)
  }
}

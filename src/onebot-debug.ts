import { Random } from './random'
import { createHash } from 'node:crypto'
import type {
  GetSandboxOneBotDebugRecordsInput,
  SandboxImplementationProfile,
  SandboxOneBotConversationObservation,
  SandboxOneBotDebugCapacity,
  SandboxOneBotDebugDirection,
  SandboxOneBotDebugError,
  SandboxOneBotDebugLargeValueSummary,
  SandboxOneBotDebugRecord,
  SandboxOneBotDebugRecordsPage,
  SandboxOneBotDebugStatus,
} from './types'
import { SandboxDomainError, SandboxOneBotDebugCursorExpiredError } from './types'
import { getOneBotProfileBaseline, listOneBotImplementationProfiles } from './onebot-profiles'
import {
  InMemoryRecordRows,
  SerialWriteQueue,
  type SandboxRecordScopeSummary,
} from './record-store'

export const DEFAULT_DEBUG_RECORD_LIMIT = 5000
export const DEFAULT_DEBUG_RECORD_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_DEBUG_PAGE_SIZE = 50
export const MAX_DEBUG_PAGE_SIZE = 200
/** 超过该字符数的 Base64 类内容在投影层折叠；持久化仍保留完整值。 */
export const LARGE_BASE64_CHAR_THRESHOLD = 8 * 1024

const SENSITIVE_KEY_PATTERN = /authorization|access[_-]?token|secret|password|cookie|private[_-]?key/i
const BASE64_BODY_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * 只脱敏凭证类键。消息正文（content/message/raw_message/text）原样保留：调试页面要能逐字
 * 核对插件实际发出与收到的报文，替换成长度摘要会让「发了什么」这个最常见的排查问题无法回答。
 */
function redactSensitive(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[已脱敏]'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactSensitive(entryValue, entryKey),
  ]))
}

function isBase64Body(value: string): boolean {
  if (value.length < 16 || value.length % 4 !== 0) return false
  return BASE64_BODY_PATTERN.test(value)
}

function inferMimeFromBase64(body: string): string | undefined {
  try {
    const bytes = Buffer.from(body.slice(0, 64), 'base64')
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
    if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  } catch {
    return undefined
  }
}

function createLargeValueSummary(encoding: 'base64' | 'data-url', body: string, mimeType?: string): SandboxOneBotDebugLargeValueSummary {
  const byteLength = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
  return {
    kind: 'large-value',
    encoding,
    ...(mimeType ? { mimeType } : {}),
    charCount: body.length,
    byteLength: Math.max(0, byteLength),
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

function foldLargeValues(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const dataUrl = trimmed.match(/^data:([^;,]+);base64,(.+)$/s)
    if (dataUrl && dataUrl[2].length > LARGE_BASE64_CHAR_THRESHOLD && isBase64Body(dataUrl[2])) {
      return createLargeValueSummary('data-url', dataUrl[2], dataUrl[1].trim().toLowerCase() || undefined)
    }
    if (trimmed.startsWith('base64://')) {
      const body = trimmed.slice('base64://'.length)
      if (body.length > LARGE_BASE64_CHAR_THRESHOLD && isBase64Body(body)) {
        return createLargeValueSummary('base64', body, inferMimeFromBase64(body))
      }
      return value
    }
    if (trimmed.length > LARGE_BASE64_CHAR_THRESHOLD && isBase64Body(trimmed)) {
      return createLargeValueSummary('base64', trimmed, inferMimeFromBase64(trimmed))
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => foldLargeValues(item))
  if (!value || typeof value !== 'object') return value
  if (Reflect.get(value, 'kind') === 'large-value') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    foldLargeValues(entryValue),
  ]))
}

export function presentOneBotDebugRecord(
  record: SandboxOneBotDebugRecord,
  includeLargeValues = false,
): SandboxOneBotDebugRecord {
  if (includeLargeValues) return structuredClone(record)
  return {
    ...structuredClone(record),
    payload: foldLargeValues(record.payload),
    result: foldLargeValues(record.result),
    error: record.error
      ? {
        ...record.error,
        // error.message 保持可读；不把错误消息当 Base64 折叠。
        message: record.error.message,
      }
      : undefined,
  }
}

function readEntityId(payload: unknown, ...keys: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') return
  for (const key of keys) {
    const value = Reflect.get(payload, key)
    if (typeof value === 'string' || typeof value === 'number') return String(value)
  }
}

/**
 * 按实现展开 action 别名。`action` 过滤要覆盖能力矩阵声明的全部别名，而别名归属取决于
 * 记录自身的 implementation，无法写成一条等值条件；这里预先摊平成「精确名 + 每个实现下
 * 的规范 action 集合」，让内存与数据库适配器基于同一份事实各自实现。
 */
export function resolveOneBotDebugActionFilter(action: string): SandboxOneBotDebugActionFilter {
  const aliasTargets: SandboxOneBotDebugActionFilter['aliasTargets'] = []
  for (const implementation of listOneBotImplementationProfiles()) {
    const actions = getOneBotProfileBaseline(implementation).capabilities
      .filter((capability) => capability.aliases?.includes(action) === true)
      .map((capability) => capability.action)
    if (actions.length) aliasTargets.push({ implementation, actions })
  }
  return { action, aliasTargets }
}

function matchesResolvedActionFilter(record: SandboxOneBotDebugRecord, filter: SandboxOneBotDebugActionFilter): boolean {
  if (record.action === filter.action || record.requestedAction === filter.action || record.matchedAlias === filter.action) return true
  return filter.aliasTargets.some(({ implementation, actions }) => (
    record.implementation === implementation && actions.includes(record.action)
  ))
}

/** 内存适配器与数据库适配器必须给出等价结果；内存侧直接复用这个谓词。 */
export function matchesOneBotDebugQuery(record: SandboxOneBotDebugRecord, query: SandboxOneBotDebugPersistenceQuery): boolean {
  if (query.botId && record.botId !== query.botId) return false
  if (query.direction && record.direction !== query.direction) return false
  if (query.action && !matchesResolvedActionFilter(record, query.action)) return false
  if (query.requestedAction && record.requestedAction !== query.requestedAction) return false
  if (query.status && record.status !== query.status) return false
  if (query.beforeSequence !== undefined) {
    return query.order === 'asc' ? record.sequence > query.beforeSequence : record.sequence < query.beforeSequence
  }
  return true
}

export function resolveOneBotDebugOrder(input: Pick<GetSandboxOneBotDebugRecordsInput, 'order'>): 'asc' | 'desc' {
  return input.order === 'asc' ? 'asc' : 'desc'
}

export function estimateOneBotDebugRecordBytes(record: SandboxOneBotDebugRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

export function createOneBotDebugError(error: unknown, traceId = Random.id()): SandboxOneBotDebugError {
  const message = error instanceof Error ? error.message : String(error ?? 'OneBot 调用失败')
  const lower = message.toLowerCase()
  const retryable = lower.includes('timeout')
    || lower.includes('超时')
    || lower.includes('temporarily')
    || lower.includes('busy')
    || lower.includes('rate limit')
    || lower.includes('econnreset')
    || lower.includes('econnrefused')
  let code = 'onebot_error'
  if (message.includes('能力已被禁用')) code = 'capability_disabled'
  else if (message.includes('不支持 OneBot action') || message.includes('暂不支持')) code = 'action_unsupported'
  else if (message.includes('已撤回')) code = 'message_recalled'
  else if (retryable) code = 'transient_error'
  return { code, message, retryable, traceId }
}

export interface SandboxOneBotDebugActionFilter {
  /** 精确匹配 action、requestedAction 或 matchedAlias 的名字。 */
  action: string
  /** 每个实现下「别名包含该名字」的规范 action 集合。 */
  aliasTargets: Array<{ implementation: SandboxImplementationProfile, actions: string[] }>
}

export interface SandboxOneBotDebugPersistenceQuery {
  botId?: string
  direction?: SandboxOneBotDebugDirection
  action?: SandboxOneBotDebugActionFilter
  requestedAction?: string
  status?: SandboxOneBotDebugStatus
  order: 'asc' | 'desc'
  beforeSequence?: number
  /** 调用方会多取一条用于判断 hasMore。 */
  limit: number
}

export type SandboxOneBotDebugScopeSummary = SandboxRecordScopeSummary

/**
 * 调试记录按行持久化：追加是单行写入，回收是按序号区间删除，读取由适配器完成过滤、
 * 排序与分页。整个记录数组不再作为单行 JSON 整体重写。
 */
export interface SandboxOneBotDebugPersistence {
  /** 读取作用域摘要，不加载任何记录正文。 */
  summarize(): Promise<SandboxOneBotDebugScopeSummary>
  /** 追加单行；nextSequence 是作用域的最新高水位。 */
  append(record: SandboxOneBotDebugRecord, bytes: number, nextSequence: number): Promise<SandboxOneBotDebugScopeSummary>
  find(recordId: string): Promise<SandboxOneBotDebugRecord | undefined>
  query(query: SandboxOneBotDebugPersistenceQuery): Promise<SandboxOneBotDebugRecord[]>
  /** 从最旧开始按序号区间删除，直到同时满足条数与字节上限。 */
  reclaim(limits: { maxRecords: number, maxBytes: number }): Promise<SandboxOneBotDebugScopeSummary>
  /** 清空作用域记录，但保留 nextSequence 高水位。 */
  clear(nextSequence: number): Promise<SandboxOneBotDebugScopeSummary>
}

/** 进程内调试记录行库；行库机制来自共享实现，这里只注入调试记录的过滤谓词。 */
export class InMemoryOneBotDebugRecords
  extends InMemoryRecordRows<SandboxOneBotDebugRecord, SandboxOneBotDebugPersistenceQuery>
  implements SandboxOneBotDebugPersistence {
  constructor() {
    super(matchesOneBotDebugQuery)
  }
}

export interface AppendOneBotDebugRecordInput {
  botId: string
  implementation: SandboxImplementationProfile
  direction: SandboxOneBotDebugDirection
  requestedAction: string
  action: string
  matchedAlias?: string
  status: SandboxOneBotDebugStatus
  durationMs: number
  payload?: unknown
  result?: unknown
  error?: SandboxOneBotDebugError
  conversationObservation?: SandboxOneBotConversationObservation
}

export interface SandboxOneBotDebugStoreOptions {
  maxRecords?: number
  maxBytes?: number
  persistence?: SandboxOneBotDebugPersistence
}

export class SandboxOneBotDebugStore {
  private nextSequence = 1
  private summary: SandboxOneBotDebugScopeSummary = { nextSequence: 1, recordCount: 0, totalBytes: 0 }
  private readonly maxRecords: number
  private readonly maxBytes: number
  private persistence: SandboxOneBotDebugPersistence
  private readonly ready: Promise<void>
  private readonly writes: SerialWriteQueue
  /** 已分配序号但尚未落盘的记录；恢复完成时按持久化高水位重新编号。 */
  private staged: SandboxOneBotDebugRecord[] = []

  constructor(options: SandboxOneBotDebugStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_DEBUG_RECORD_LIMIT
    this.maxBytes = options.maxBytes ?? DEFAULT_DEBUG_RECORD_MAX_BYTES
    this.persistence = options.persistence ?? new InMemoryOneBotDebugRecords()
    this.ready = this.persistence.summarize().then((summary) => {
      // 数据库恢复是异步的，启动期可能已经收到 OneBot 记录。它们先用临时序号占位，
      // 这里按持久化高水位重新编号，避免恢复瞬间与历史记录撞号。
      let nextSequence = Math.max(1, summary.nextSequence)
      for (const record of this.staged) record.sequence = nextSequence++
      this.nextSequence = nextSequence
      this.summary = { ...summary, nextSequence }
    }).catch(() => {
      // 记录库不可读时不能把当前内存状态当成权威数据回写，否则会清空数据库历史。
      // 降级为进程内记录库：调试证据仍然可见，只是本次运行不再落盘。
      this.persistence = new InMemoryOneBotDebugRecords()
    })
    this.writes = new SerialWriteQueue(this.ready)
  }

  waitForReady(): Promise<void> {
    return this.ready
  }

  waitForPersistence(): Promise<void> {
    return this.settle()
  }

  /** 等到已入队的写入全部提交。 */
  private settle(): Promise<void> {
    return this.writes.settle()
  }

  async getCapacity(): Promise<SandboxOneBotDebugCapacity> {
    await this.settle()
    return this.readCapacity()
  }

  append(input: AppendOneBotDebugRecordInput): SandboxOneBotDebugRecord {
    // 持久化保留完整原始大型值；仅脱敏凭证类键。
    const payload = redactSensitive(input.payload)
    const result = redactSensitive(input.result)
    const record: SandboxOneBotDebugRecord = {
      id: Random.id(),
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
      botId: input.botId,
      implementation: input.implementation,
      direction: input.direction,
      requestedAction: input.requestedAction,
      action: input.action,
      ...(input.matchedAlias ? { matchedAlias: input.matchedAlias } : {}),
      status: input.status,
      durationMs: input.durationMs,
      payload,
      result,
      entities: {
        userId: readEntityId(input.payload, 'user_id', 'target_id'),
        groupId: readEntityId(input.payload, 'group_id'),
        conversationId: readEntityId(input.payload, 'conversation_id', 'channel_id'),
        messageId: readEntityId(input.payload, 'message_id'),
      },
      error: input.error,
      ...(input.conversationObservation ? { conversationObservation: input.conversationObservation } : {}),
    }
    this.nextSequence += 1
    this.staged.push(record)
    this.writes.push(async () => {
      // record.sequence 可能已被恢复流程重新编号，这里读到的是最终值。
      this.summary = await this.persistence.append(record, estimateOneBotDebugRecordBytes(record), this.nextSequence)
      await this.reclaimOverflow()
      const index = this.staged.indexOf(record)
      if (index >= 0) this.staged.splice(index, 1)
    })
    // 广播与即时返回使用折叠投影，避免 MCP 事件流被超大 Base64 淹没。
    return presentOneBotDebugRecord(record, false)
  }

  async getRecords(input: GetSandboxOneBotDebugRecordsInput = {}): Promise<SandboxOneBotDebugRecordsPage> {
    const limit = Math.min(Math.max(Number(input.limit ?? DEFAULT_DEBUG_PAGE_SIZE) || DEFAULT_DEBUG_PAGE_SIZE, 1), MAX_DEBUG_PAGE_SIZE)
    await this.settle()
    const earliestCursor = this.summary.earliestSequence
    if (input.beforeSequence !== undefined) {
      if (!Number.isInteger(input.beforeSequence) || input.beforeSequence < 1) {
        throw new SandboxDomainError('beforeSequence 必须是正整数')
      }
      // 游标指向已回收历史：比当前最早 sequence 还旧。
      if (earliestCursor !== undefined && input.beforeSequence < earliestCursor) {
        throw new SandboxOneBotDebugCursorExpiredError(
          `调试记录游标已过期：${input.beforeSequence}`,
          earliestCursor,
        )
      }
    }

    // 多取一条用于判断 hasMore，避免为了计数再查一次全表。
    const rows = await this.persistence.query({
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.action ? { action: resolveOneBotDebugActionFilter(input.action) } : {}),
      ...(input.requestedAction ? { requestedAction: input.requestedAction } : {}),
      ...(input.status ? { status: input.status } : {}),
      order: resolveOneBotDebugOrder(input),
      ...(input.beforeSequence !== undefined ? { beforeSequence: input.beforeSequence } : {}),
      limit: limit + 1,
    })
    const page = rows.slice(0, limit)
    const hasMore = rows.length > page.length
    return {
      records: page.map((record) => presentOneBotDebugRecord(record, false)),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.sequence : undefined,
      earliestCursor,
      capacity: this.readCapacity(),
    }
  }

  async getRecord(recordId: string, includeLargeValues = false): Promise<SandboxOneBotDebugRecord | undefined> {
    await this.settle()
    const record = await this.persistence.find(recordId)
    return record ? presentOneBotDebugRecord(record, includeLargeValues) : undefined
  }

  /**
   * 「这条调试记录在不在」由本记录库判定，取不到就抛。
   *
   * 与 `getRecord` 并存而不是替代它：本成员服务于「调用方就是要这条记录」，`getRecord` 服务于
   * 跨记录域遍历——遍历必须能区分「这个记录域里没有」与「这个记录域的持久化坏了」，用异常表达
   * 未命中会让一次真实故障被当成「这里没有」静默跳过。
   */
  async requireRecord(recordId: string, includeLargeValues = false): Promise<SandboxOneBotDebugRecord> {
    const record = await this.getRecord(recordId, includeLargeValues)
    if (!record) throw new SandboxDomainError(`调试记录不存在：${recordId}`)
    return record
  }

  clear(): Promise<number> {
    // sequence 不因清理而回退，避免跨清理复用。
    return this.writes.run(async () => {
      const cleared = this.summary.recordCount
      this.summary = await this.persistence.clear(this.nextSequence)
      return cleared
    }).catch(() => 0)
  }

  private readCapacity(): SandboxOneBotDebugCapacity {
    return {
      recordCount: this.summary.recordCount,
      totalBytes: this.summary.totalBytes,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
    }
  }

  private async reclaimOverflow(): Promise<void> {
    if (this.summary.recordCount <= this.maxRecords && this.summary.totalBytes <= this.maxBytes) return
    this.summary = await this.persistence.reclaim({ maxRecords: this.maxRecords, maxBytes: this.maxBytes })
  }
}

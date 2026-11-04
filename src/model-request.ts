import { Random } from './random'
import { projectModelEvidence } from './model-evidence'
import { deriveModelRequestVariables } from './model-request-variables'
import {
  InMemoryRecordRows,
  SerialWriteQueue,
  type SandboxRecordScopeSummary,
} from './record-store'
import type {
  GetSandboxModelRequestRecordsInput,
  SandboxChatLunaRequestError,
  SandboxModelRequestCapacity,
  SandboxModelRequestDetail,
  SandboxModelRequestEntities,
  SandboxModelRequestError,
  SandboxModelRequestListItem,
  SandboxModelRequestRecord,
  SandboxModelRequestRecordsPage,
  SandboxModelRequestStatus,
  SandboxModelResponseBodyFormat,
  SandboxPresetRuntimeSnapshot,
  SandboxPresetRuntimeSnapshotSummary,
  SandboxModelResponseBodyStatus,
} from './types'
import { SandboxDomainError, SandboxModelRequestCursorExpiredError } from './types'

export const MAIN_MODEL_REQUEST_SCOPE_ID = 'main'
export const UNATTRIBUTED_MODEL_REQUEST_SCOPE_ID = 'unattributed'

export const DEFAULT_MODEL_REQUEST_RECORD_LIMIT = 500
export const DEFAULT_MODEL_REQUEST_RECORD_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_MODEL_REQUEST_PAGE_SIZE = 50
export const MAX_MODEL_REQUEST_PAGE_SIZE = 200

export interface SandboxModelRequestPersistenceQuery {
  botId?: string
  conversationId?: string
  interactionId?: string
  model?: string
  status?: SandboxModelRequestStatus
  order: 'asc' | 'desc'
  beforeSequence?: number
  beforeCreatedAt?: string
  beforeId?: string
  /** 调用方会多取一条用于判断 hasMore。 */
  limit: number
}

export type SandboxModelRequestScopeSummary = SandboxRecordScopeSummary

/**
 * 列表读取真正需要的记录切片。
 *
 * 请求体与响应原文是记录里唯一没有上限的两个字段，而列表投影从来不读它们；把这个切片
 * 提升成一个具名类型，读取路径就能在适配器一侧把它们留在存储里，而不是先取出整条记录再丢掉。
 */
export type SandboxModelRequestRecordHeader = Omit<SandboxModelRequestRecord, 'requestBody' | 'responseBodyRaw'>

/** 从完整记录取出列表读取需要的切片。适配器与内存行库共用同一份口径。 */
export function toModelRequestRecordHeader(record: SandboxModelRequestRecord): SandboxModelRequestRecordHeader {
  const { requestBody: _requestBody, responseBodyRaw: _responseBodyRaw, ...header } = record
  return header
}

/**
 * 模型请求记录按行持久化：追加是单行 insert，补充响应体或错误是单行 update，容量回收是
 * 按序号区间 delete，读取由适配器完成过滤、排序与分页。
 */
export interface SandboxModelRequestPersistence {
  /** 读取作用域摘要，不加载任何记录正文。 */
  summarize(): Promise<SandboxModelRequestScopeSummary>
  append(record: SandboxModelRequestRecord, bytes: number, nextSequence: number): Promise<SandboxModelRequestScopeSummary>
  find(recordId: string): Promise<SandboxModelRequestRecord | undefined>
  /** 覆盖单行，按 sequence 定位；不触碰其他行。 */
  replace(record: SandboxModelRequestRecord, bytes: number): Promise<SandboxModelRequestScopeSummary>
  query(query: SandboxModelRequestPersistenceQuery): Promise<SandboxModelRequestRecord[]>
  /** 与 query 同一套过滤、排序与分页，但不取出请求体与响应原文。 */
  queryHeaders(query: SandboxModelRequestPersistenceQuery): Promise<SandboxModelRequestRecordHeader[]>
  /** 从最旧开始按序号区间删除，直到同时满足条数与字节上限。 */
  reclaim(limits: { maxRecords: number, maxBytes: number }): Promise<SandboxModelRequestScopeSummary>
  /** 清空作用域记录，但保留 nextSequence 高水位。 */
  clear(nextSequence: number): Promise<SandboxModelRequestScopeSummary>
}

/** 内存适配器与数据库适配器必须给出等价结果；内存侧直接复用这个谓词。 */
export function matchesModelRequestQuery(
  record: SandboxModelRequestRecord,
  query: SandboxModelRequestPersistenceQuery,
): boolean {
  if (query.botId && record.entities.botId !== query.botId) return false
  if (query.conversationId && record.entities.conversationId !== query.conversationId) return false
  if (query.interactionId && record.interactionId !== query.interactionId) return false
  if (query.model && record.model !== query.model) return false
  if (query.status && record.status !== query.status) return false
  if (query.beforeSequence !== undefined) {
    return query.order === 'asc' ? record.sequence > query.beforeSequence : record.sequence < query.beforeSequence
  }
  if (!query.beforeCreatedAt) return true
  const created = record.createdAt.localeCompare(query.beforeCreatedAt)
  if (created !== 0) return query.order === 'asc' ? created > 0 : created < 0
  if (!query.beforeId) return true
  const id = record.id.localeCompare(query.beforeId)
  return query.order === 'asc' ? id > 0 : id < 0
}

/** 进程内模型请求行库；行库机制来自共享实现，这里只注入模型请求的过滤谓词与列表切片。 */
export class InMemoryModelRequestRecords
  extends InMemoryRecordRows<SandboxModelRequestRecord, SandboxModelRequestPersistenceQuery>
  implements SandboxModelRequestPersistence {
  constructor() {
    super(matchesModelRequestQuery)
  }

  queryHeaders(query: SandboxModelRequestPersistenceQuery): Promise<SandboxModelRequestRecordHeader[]> {
    return this.queryProjected(query, toModelRequestRecordHeader)
  }
}

export interface AppendModelRequestRecordInput {
  status: SandboxModelRequestStatus
  durationMs: number
  method?: string
  url?: string
  provider?: string
  model?: string
  headers?: Record<string, string>
  attribution: 'attributed' | 'unattributed'
  entities: SandboxModelRequestEntities
  requestBody?: unknown
  requestBodyAvailable: boolean
  responseBodyStatus?: SandboxModelResponseBodyStatus
  responseBodyFormat?: SandboxModelResponseBodyFormat
  responseStatus?: number
  responseBodyRaw?: string
  responseBodyError?: string
  interactionId?: string
  chatlunaRequestId?: string
  presetSnapshots?: SandboxPresetRuntimeSnapshot[]
  error?: SandboxModelRequestError
  chatlunaError?: SandboxChatLunaRequestError
}

export interface UpdateModelRequestRecordInput {
  status?: SandboxModelRequestStatus
  durationMs?: number
  headers?: Record<string, string>
  responseBodyStatus?: SandboxModelResponseBodyStatus
  responseBodyFormat?: SandboxModelResponseBodyFormat
  responseStatus?: number
  responseBodyRaw?: string
  responseBodyError?: string
  chatlunaRequestId?: string
  error?: SandboxModelRequestError
  chatlunaError?: SandboxChatLunaRequestError
}

export interface SandboxModelRequestStoreOptions {
  maxRecords?: number
  maxBytes?: number
  persistence?: SandboxModelRequestPersistence
}

export function estimateModelRequestRecordBytes(record: SandboxModelRequestRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

export function createModelRequestError(error: unknown, traceId = Random.id()): SandboxModelRequestError {
  const message = error instanceof Error ? error.message : String(error ?? '模型请求失败')
  const lower = message.toLowerCase()
  const retryable = lower.includes('timeout') || lower.includes('超时') || lower.includes('rate limit') || lower.includes('econnreset')
  return { code: retryable ? 'transient_error' : 'model_request_error', message, retryable, traceId }
}

function summarizePresetSnapshots(snapshots: readonly SandboxPresetRuntimeSnapshot[] | undefined): SandboxPresetRuntimeSnapshotSummary[] | undefined {
  if (!snapshots?.length) return
  return snapshots.map((snapshot) => ({
    kind: snapshot.kind,
    presetName: snapshot.presetName,
    capturedAt: snapshot.capturedAt,
    templateCount: snapshot.templates.length,
  }))
}

/**
 * 列表投影。入参允许带请求体与响应原文（轨迹从完整记录派生同会话列表项），但它们既不参与
 * 投影也不参与拷贝：列表路径深拷贝整条记录再丢掉这两个字段，是列表读取里最大的一次无用功。
 */
export function presentModelRequestListItem(
  record: SandboxModelRequestRecordHeader & Partial<Pick<SandboxModelRequestRecord, 'requestBody' | 'responseBodyRaw'>>,
): SandboxModelRequestListItem {
  const {
    requestBody: _requestBody,
    responseBodyRaw: _responseBodyRaw,
    presetSnapshots,
    ...listItem
  } = record
  const presetSnapshotSummaries = summarizePresetSnapshots(presetSnapshots)
  return {
    ...structuredClone(listItem),
    ...(presetSnapshotSummaries ? { presetSnapshotSummaries } : {}),
  }
}

export function presentModelRequestDetail(record: SandboxModelRequestRecord): SandboxModelRequestDetail {
  // 请求体未采集时不运行投影：详情读取路径是唯一决定是否运行共享模型证据投影的地方，
  // 也是唯一从请求体读取协议结构的入口。只传入请求体——详情路径上没有消费者需要响应侧投影，
  // 不为无人使用的响应事件解析流式原文。
  const evidence = record.requestBody === undefined
    ? undefined
    : projectModelEvidence({ requestBody: record.requestBody })
  return {
    ...structuredClone(record),
    // 字段数是原始 JSON 事实，只有请求体确实是对象时才存在；非对象请求体不暗示它有 0 个字段。
    ...(isRequestBodyObject(record.requestBody) ? { requestBodyKeyCount: Object.keys(record.requestBody).length } : {}),
    ...(evidence
      ? {
          evidenceCounts: {
            requestMessageCount: evidence.requestMessages.length,
            toolDefinitionCount: evidence.toolDefinitions.length,
          },
        }
      : {}),
    variables: evidence && record.presetSnapshots?.length
      ? deriveModelRequestVariables(record.presetSnapshots, evidence)
      : [],
  }
}

/** 与共享模型证据投影同一个对象边界：数组不算对象，它在投影里就是不支持的请求体形状。 */
function isRequestBodyObject(body: unknown): body is Record<string, unknown> {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body))
}

export class SandboxModelRequestStore {
  private nextSequence = 1
  private summary: SandboxModelRequestScopeSummary = { nextSequence: 1, recordCount: 0, totalBytes: 0 }
  private readonly maxRecords: number
  private readonly maxBytes: number
  private persistence: SandboxModelRequestPersistence
  private readonly ready: Promise<void>
  private readonly writes: SerialWriteQueue
  /** 已分配序号但尚未落盘的记录；恢复完成时按持久化高水位重新编号。 */
  private staged: SandboxModelRequestRecord[] = []
  private readonly pendingUpdates = new Set<Promise<void>>()

  constructor(options: SandboxModelRequestStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MODEL_REQUEST_RECORD_LIMIT
    this.maxBytes = options.maxBytes ?? DEFAULT_MODEL_REQUEST_RECORD_MAX_BYTES
    this.persistence = options.persistence ?? new InMemoryModelRequestRecords()
    this.ready = this.persistence.summarize().then((summary) => {
      // 数据库恢复是异步的，ChatLuna 可能在恢复完成前就发起请求。这些记录先用临时序号
      // 占位，这里按持久化高水位重新编号，避免恢复瞬间与历史记录撞号。
      let nextSequence = Math.max(1, summary.nextSequence)
      for (const record of this.staged) record.sequence = nextSequence++
      this.nextSequence = nextSequence
      this.summary = { ...summary, nextSequence }
    }).catch(() => {
      // 记录库不可读时不能把当前内存状态当成权威数据回写，否则会覆盖数据库历史。
      // 降级为进程内记录库：模型请求证据仍然可见，只是本次运行不再落盘。
      this.persistence = new InMemoryModelRequestRecords()
    })
    this.writes = new SerialWriteQueue(this.ready)
  }

  waitForReady(): Promise<void> { return this.ready }

  async waitForPersistence(): Promise<void> {
    // 收尾等待还要覆盖旁路采集：响应体 clone 完成后才会入队 update。
    for (let guard = 0; guard < 1000; guard += 1) {
      await this.settle()
      if (!this.pendingUpdates.size) return
      await Promise.all([...this.pendingUpdates])
    }
  }

  /**
   * 等到已入队的写入全部提交。读取只需要这一层：pendingUpdates 里是尚未产生写入的
   * 外部 Promise（例如仍在流式传输的响应体），读取等待它们会与写入方互相死锁。
   */
  private settle(): Promise<void> {
    return this.writes.settle()
  }

  /** 登记会在稍后触发 update 的外部 Promise（响应体旁路采集），让收尾等待能覆盖它。 */
  trackUpdate(task: Promise<void>): void {
    const tracked = task.finally(() => this.pendingUpdates.delete(tracked))
    this.pendingUpdates.add(tracked)
  }

  async getCapacity(): Promise<SandboxModelRequestCapacity> {
    await this.settle()
    return this.readCapacity()
  }

  append(input: AppendModelRequestRecordInput): SandboxModelRequestRecord {
    const record: SandboxModelRequestRecord = {
      id: Random.id(),
      sequence: this.nextSequence++,
      createdAt: new Date().toISOString(),
      status: input.status,
      durationMs: input.durationMs,
      ...(input.method ? { method: input.method } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.headers ? { headers: structuredClone(input.headers) } : {}),
      attribution: input.attribution,
      entities: structuredClone(input.entities),
      requestBodyAvailable: input.requestBodyAvailable,
      ...(input.requestBody !== undefined ? { requestBody: structuredClone(input.requestBody) } : {}),
      responseBodyStatus: input.responseBodyStatus ?? 'unavailable',
      ...(input.responseBodyFormat ? { responseBodyFormat: input.responseBodyFormat } : {}),
      ...(input.responseStatus !== undefined ? { responseStatus: input.responseStatus } : {}),
      ...(input.responseBodyRaw !== undefined ? { responseBodyRaw: input.responseBodyRaw } : {}),
      ...(input.responseBodyError ? { responseBodyError: input.responseBodyError } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      ...(input.chatlunaRequestId ? { chatlunaRequestId: input.chatlunaRequestId } : {}),
      ...(input.presetSnapshots?.length ? { presetSnapshots: structuredClone(input.presetSnapshots) } : {}),
      ...(input.error ? { error: structuredClone(input.error) } : {}),
      ...(input.chatlunaError ? { chatlunaError: structuredClone(input.chatlunaError) } : {}),
    }
    this.staged.push(record)
    this.writes.push(async () => {
      // record.sequence 可能已被恢复流程重新编号，这里读到的是最终值。
      this.summary = await this.persistence.append(record, estimateModelRequestRecordBytes(record), this.nextSequence)
      await this.reclaimOverflow()
      const index = this.staged.indexOf(record)
      if (index >= 0) this.staged.splice(index, 1)
    })
    return structuredClone(record)
  }

  update(recordId: string, input: UpdateModelRequestRecordInput): Promise<SandboxModelRequestRecord | undefined> {
    // 补充响应体或错误只重写这一行；队列保证它排在同一条记录的 append 之后。
    // 落盘失败与改造前一致地静默降级为 undefined：调用方是旁路采集器，不能因证据写入失败中断模型请求。
    return this.writes.run(async () => {
      const previous = await this.persistence.find(recordId)
      if (!previous) return
      const next: SandboxModelRequestRecord = {
        ...previous,
        ...(input.status ? { status: input.status } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.headers ? { headers: structuredClone(input.headers) } : {}),
        ...(input.responseBodyStatus ? { responseBodyStatus: input.responseBodyStatus } : {}),
        ...(input.responseBodyFormat ? { responseBodyFormat: input.responseBodyFormat } : {}),
        ...(input.responseStatus !== undefined ? { responseStatus: input.responseStatus } : {}),
        ...(input.responseBodyRaw !== undefined ? { responseBodyRaw: input.responseBodyRaw } : {}),
        ...(input.responseBodyError ? { responseBodyError: input.responseBodyError } : {}),
        ...(input.chatlunaRequestId ? { chatlunaRequestId: input.chatlunaRequestId } : {}),
      }
      if (input.status === 'success') delete next.error
      else if (input.error) next.error = structuredClone(input.error)
      if (input.chatlunaError) next.chatlunaError = structuredClone(input.chatlunaError)
      if (input.responseBodyStatus === 'complete') delete next.responseBodyError
      this.summary = await this.persistence.replace(next, estimateModelRequestRecordBytes(next))
      await this.reclaimOverflow()
      return structuredClone(next)
    }).catch(() => undefined)
  }

  async getRecords(input: GetSandboxModelRequestRecordsInput = {}): Promise<SandboxModelRequestRecordsPage> {
    const limit = Math.min(Math.max(Number(input.limit ?? DEFAULT_MODEL_REQUEST_PAGE_SIZE) || DEFAULT_MODEL_REQUEST_PAGE_SIZE, 1), MAX_MODEL_REQUEST_PAGE_SIZE)
    await this.settle()
    const earliestCursor = this.summary.earliestSequence
    if (input.beforeSequence !== undefined) {
      if (!Number.isInteger(input.beforeSequence) || input.beforeSequence < 1) {
        throw new SandboxDomainError('beforeSequence 必须是正整数')
      }
      if (earliestCursor !== undefined && input.beforeSequence < earliestCursor) {
        throw new SandboxModelRequestCursorExpiredError(
          `模型请求记录游标已过期：${input.beforeSequence}`,
          earliestCursor,
        )
      }
    }
    // 多取一条用于判断 hasMore，避免为了计数再查一次全表。
    // 列表读取只要记录头：请求体与响应原文不参与列表投影，也就不必从存储里取出来。
    const rows = await this.persistence.queryHeaders({
      ...this.toFilter(input),
      order: resolveModelRequestOrder(input),
      ...(input.beforeSequence !== undefined ? { beforeSequence: input.beforeSequence } : {}),
      ...(input.beforeCreatedAt ? { beforeCreatedAt: input.beforeCreatedAt } : {}),
      ...(input.beforeId ? { beforeId: input.beforeId } : {}),
      limit: limit + 1,
    })
    const records = rows.slice(0, limit)
    const hasMore = rows.length > records.length
    const last = records[records.length - 1]
    return {
      records: records.map((record) => presentModelRequestListItem(record)),
      hasMore,
      nextCursor: hasMore ? last?.sequence : undefined,
      nextCreatedAt: hasMore ? last?.createdAt : undefined,
      nextId: hasMore ? last?.id : undefined,
      earliestCursor,
      capacity: this.readCapacity(),
    }
  }

  async getRecord(recordId: string): Promise<SandboxModelRequestDetail | undefined> {
    await this.settle()
    const record = await this.persistence.find(recordId)
    return record ? presentModelRequestDetail(record) : undefined
  }

  /**
   * 「这条模型请求记录在不在」由本记录库判定，取不到就抛。
   *
   * 与 `getRecord` 并存而不是替代它：本成员服务于「调用方就是要这条记录」，`getRecord` 服务于
   * 跨记录域遍历——遍历必须能区分「这个记录域里没有」与「这个记录域的持久化坏了」，用异常表达
   * 未命中会让一次真实故障被当成「这里没有」静默跳过。
   */
  async requireRecord(recordId: string): Promise<SandboxModelRequestDetail> {
    const record = await this.getRecord(recordId)
    if (!record) throw new SandboxDomainError(`模型请求记录不存在：${recordId}`)
    return record
  }

  async getRawRecords(input: GetSandboxModelRequestRecordsInput = {}): Promise<SandboxModelRequestRecord[]> {
    const limit = Math.min(Math.max(Number(input.limit ?? MAX_MODEL_REQUEST_PAGE_SIZE) || MAX_MODEL_REQUEST_PAGE_SIZE, 1), MAX_MODEL_REQUEST_PAGE_SIZE)
    await this.settle()
    return this.persistence.query({
      ...this.toFilter(input),
      order: resolveModelRequestOrder(input),
      limit,
    })
  }

  clear(): Promise<number> {
    // sequence 不因清理而回退，避免跨清理复用。
    return this.writes.run(async () => {
      const cleared = this.summary.recordCount
      this.summary = await this.persistence.clear(this.nextSequence)
      return cleared
    }).catch(() => 0)
  }

  private toFilter(input: GetSandboxModelRequestRecordsInput) {
    return {
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.status ? { status: input.status } : {}),
    }
  }

  private readCapacity(): SandboxModelRequestCapacity {
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

export function resolveModelRequestOrder(input: Pick<GetSandboxModelRequestRecordsInput, 'order'>): 'asc' | 'desc' {
  return input.order === 'asc' ? 'asc' : 'desc'
}

function compareModelRequestSequence(left: number, right: number, order: 'asc' | 'desc'): number {
  return order === 'asc' ? left - right : right - left
}

function isBeforeModelRequestPageCursor(
  record: Pick<SandboxModelRequestRecord, 'id' | 'sequence' | 'createdAt'>,
  input: GetSandboxModelRequestRecordsInput,
): boolean {
  const order = resolveModelRequestOrder(input)
  if (input.beforeSequence !== undefined) {
    return order === 'asc' ? record.sequence > input.beforeSequence : record.sequence < input.beforeSequence
  }
  if (!input.beforeCreatedAt) return true
  const created = record.createdAt.localeCompare(input.beforeCreatedAt)
  if (created !== 0) return order === 'asc' ? created > 0 : created < 0
  if (!input.beforeId) return true
  const id = record.id.localeCompare(input.beforeId)
  return order === 'asc' ? id > 0 : id < 0
}

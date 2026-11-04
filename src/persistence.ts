import type { Context } from 'cordis'
import type {
  SandboxImplementationProfile,
  SandboxModelRequestRecord,
  SandboxModelRequestStatus,
  SandboxOneBotDebugDirection,
  SandboxOneBotDebugRecord,
  SandboxOneBotDebugStatus,
  SandboxPersistenceStatus,
  SandboxSnapshot,
} from './types'
import {
  InMemoryOneBotDebugRecords,
  type SandboxOneBotDebugPersistence,
  type SandboxOneBotDebugPersistenceQuery,
  type SandboxOneBotDebugScopeSummary,
} from './onebot-debug'
import {
  InMemoryModelRequestRecords,
  toModelRequestRecordHeader,
  type SandboxModelRequestPersistence,
  type SandboxModelRequestPersistenceQuery,
  type SandboxModelRequestRecordHeader,
  type SandboxModelRequestScopeSummary,
} from './model-request'
import { ScopeRowIndex } from './record-store'

/** 记录里唯一没有上限的两个字段；列表读取从不投影它们。 */
export interface SandboxModelRequestRecordBodies {
  requestBody?: unknown
  responseBodyRaw?: string
}

export type SandboxSceneLoadResult =
  | { kind: 'loaded', scene: SandboxSnapshot }
  | { kind: 'missing' }
  | { kind: 'unavailable', reason: 'missing-service' | 'query-failed', error?: unknown }

export interface SandboxScenePersistence {
  getStatus(): SandboxPersistenceStatus
  load(): Promise<SandboxSceneLoadResult>
  save(scene: SandboxSnapshot): Promise<void>
}

export interface SandboxSceneRecord {
  id: string
  scene: SandboxSnapshot
  updatedAt: Date
}

export interface SandboxTestSpacePersistenceRecord {
  id: string
  name: string
  status: 'running' | 'taken-over' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  completedAt?: string
  scene: SandboxSnapshot
}

export interface SandboxTestSpacePersistence {
  loadAll(): Promise<SandboxTestSpacePersistenceRecord[]>
  save(record: SandboxTestSpacePersistenceRecord): Promise<void>
  delete(id: string): Promise<void>
}

/**
 * 作用域摘要行：只保存 nextSequence 高水位。记录条数与字节数由记录行的 bytes 列现算，
 * 避免计数漂移；序号必须独立保存，否则清空作用域后 max(sequence)+1 会回退并复用旧序号。
 */
export interface SandboxRecordScopeRow {
  scopeId: string
  nextSequence: number
  updatedAt: Date
}

/** 一条 OneBot 调试记录一行。过滤用的字段单独成列，读取路径才能落到数据库侧。 */
export interface SandboxOneBotDebugRecordRow {
  scopeId: string
  sequence: number
  id: string
  createdAt: string
  botId: string
  implementation: SandboxImplementationProfile
  direction: SandboxOneBotDebugDirection
  action: string
  requestedAction: string
  matchedAlias: string
  status: SandboxOneBotDebugStatus
  /** 完整持久化内容的字节数，容量统计按这一列求和。 */
  bytes: number
  record: SandboxOneBotDebugRecord
}

/**
 * 一条模型请求记录一行。
 *
 * 记录被拆成两列：`header` 是列表读取需要的全部字段，`bodies` 只装请求体与响应原文。
 * 这两个字段是记录里唯一没有上限的部分，单列存放时列表读取会连它们一起取出并反序列化；
 * 拆列之后列表查询只投影 `header`，翻页与自动刷新不再按请求体体积付代价。
 */
export interface SandboxModelRequestRecordRow {
  scopeId: string
  sequence: number
  id: string
  createdAt: string
  botId: string
  conversationId: string
  interactionId: string
  model: string
  status: SandboxModelRequestStatus
  bytes: number
  header: SandboxModelRequestRecordHeader
  bodies: SandboxModelRequestRecordBodies
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    'onebot_sandbox_scene': SandboxSceneRecord
    'onebot_sandbox_test_space': SandboxTestSpacePersistenceRecord
    'onebot_sandbox_debug_record': SandboxOneBotDebugRecordRow
    'onebot_sandbox_debug_scope': SandboxRecordScopeRow
    'onebot_sandbox_model_request': SandboxModelRequestRecordRow
    'onebot_sandbox_model_request_scope': SandboxRecordScopeRow
  }
}

// 表名使用 onebot_sandbox_ 前缀，与 ChatLuna 的下划线表名约定一致；
// ctx.inject 回调里的 model.extend 拿不到插件运行时名称，仅靠上下文会被归为未知来源。
const SCENE_TABLE = 'onebot_sandbox_scene'
const SCENE_ID = 'main'
const TEST_SPACE_TABLE = 'onebot_sandbox_test_space'
const DEBUG_RECORD_TABLE = 'onebot_sandbox_debug_record'
const DEBUG_SCOPE_TABLE = 'onebot_sandbox_debug_scope'
const MODEL_REQUEST_RECORD_TABLE = 'onebot_sandbox_model_request'
const MODEL_REQUEST_SCOPE_TABLE = 'onebot_sandbox_model_request_scope'

type SandboxRecordRowQuery = Record<string, unknown>

interface SandboxRecordRowCursor {
  limit?: number
  offset?: number
  fields?: string[]
  sort?: Record<string, 'asc' | 'desc'>
}

interface SandboxSceneDatabase {
  get(table: 'onebot_sandbox_scene', query: { id: string }): Promise<SandboxSceneRecord[]>
  upsert(table: 'onebot_sandbox_scene', rows: SandboxSceneRecord[]): Promise<unknown>
}

interface SandboxTestSpaceDatabase {
  get(table: 'onebot_sandbox_test_space', query: { id?: string }): Promise<SandboxTestSpacePersistenceRecord[]>
  upsert(table: 'onebot_sandbox_test_space', rows: SandboxTestSpacePersistenceRecord[]): Promise<unknown>
  remove(table: 'onebot_sandbox_test_space', query: { id: string }): Promise<unknown>
}

export interface SandboxOneBotDebugDatabase {
  get(table: 'onebot_sandbox_debug_record', query: SandboxRecordRowQuery, cursor?: SandboxRecordRowCursor): Promise<SandboxOneBotDebugRecordRow[]>
  get(table: 'onebot_sandbox_debug_scope', query: { scopeId: string }): Promise<SandboxRecordScopeRow[]>
  upsert(table: 'onebot_sandbox_debug_record', rows: SandboxOneBotDebugRecordRow[]): Promise<unknown>
  upsert(table: 'onebot_sandbox_debug_scope', rows: SandboxRecordScopeRow[]): Promise<unknown>
  remove(table: 'onebot_sandbox_debug_record' | 'onebot_sandbox_debug_scope', query: SandboxRecordRowQuery): Promise<unknown>
}

export interface SandboxModelRequestDatabase {
  get(table: 'onebot_sandbox_model_request', query: SandboxRecordRowQuery, cursor?: SandboxRecordRowCursor): Promise<SandboxModelRequestRecordRow[]>
  get(table: 'onebot_sandbox_model_request_scope', query: { scopeId: string }): Promise<SandboxRecordScopeRow[]>
  upsert(table: 'onebot_sandbox_model_request', rows: SandboxModelRequestRecordRow[]): Promise<unknown>
  upsert(table: 'onebot_sandbox_model_request_scope', rows: SandboxRecordScopeRow[]): Promise<unknown>
  remove(table: 'onebot_sandbox_model_request' | 'onebot_sandbox_model_request_scope', query: SandboxRecordRowQuery): Promise<unknown>
}

/** database 是可选服务，且 Minato 的注册晚于 ready；所有首次读取都要给它这段等待窗口。 */
const DATABASE_READY_TIMEOUT_MS = 10_000

async function waitForDatabase<T>(resolveDatabase: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  let database = resolveDatabase()
  while (!database && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
    database = resolveDatabase()
  }
  return database
}

export function registerSandboxSceneModel(ctx: Context): void {
  ctx.model.extend(SCENE_TABLE, {
    id: 'string(64)',
    scene: 'json',
    updatedAt: 'timestamp',
  }, { primary: 'id' })
}

export function registerSandboxTestSpaceModel(ctx: Context): void {
  ctx.model.extend(TEST_SPACE_TABLE, {
    id: 'string(64)',
    name: 'string(255)',
    status: 'string(32)',
    createdAt: 'string(64)',
    updatedAt: 'string(64)',
    completedAt: 'string(64)',
    scene: 'json',
  }, { primary: 'id' })
}

export function registerSandboxModelRequestModel(ctx: Context): void {
  // 主键是作用域 + 单调序号：追加、单行更新与按区间回收都只命中自己那一行。
  ctx.model.extend(MODEL_REQUEST_RECORD_TABLE, {
    scopeId: 'string(64)',
    sequence: 'unsigned',
    id: 'string(64)',
    createdAt: 'string(64)',
    botId: 'string(64)',
    conversationId: 'string(255)',
    interactionId: 'string(64)',
    model: 'string(255)',
    status: 'string(32)',
    bytes: 'unsigned',
    header: 'json',
    bodies: 'json',
  }, { primary: ['scopeId', 'sequence'] })
  ctx.model.extend(MODEL_REQUEST_SCOPE_TABLE, {
    scopeId: 'string(64)',
    nextSequence: 'unsigned',
    updatedAt: 'timestamp',
  }, { primary: 'scopeId' })
}

export function registerSandboxOneBotDebugModel(ctx: Context): void {
  ctx.model.extend(DEBUG_RECORD_TABLE, {
    scopeId: 'string(64)',
    sequence: 'unsigned',
    id: 'string(64)',
    createdAt: 'string(64)',
    botId: 'string(64)',
    implementation: 'string(32)',
    direction: 'string(16)',
    action: 'string(128)',
    requestedAction: 'string(128)',
    matchedAlias: 'string(128)',
    status: 'string(32)',
    bytes: 'unsigned',
    record: 'json',
  }, { primary: ['scopeId', 'sequence'] })
  ctx.model.extend(DEBUG_SCOPE_TABLE, {
    scopeId: 'string(64)',
    nextSequence: 'unsigned',
    updatedAt: 'timestamp',
  }, { primary: 'scopeId' })
}

// 内存 Adapter 与数据库 Adapter 共用同一 Interface：进程内跨控制服务实例可恢复，进程退出后不保留。
export class MemoryOneBotDebugPersistence extends InMemoryOneBotDebugRecords {
  constructor(readonly scopeId: string) {
    super()
  }
}

export class MemoryModelRequestPersistence extends InMemoryModelRequestRecords {
  constructor(readonly scopeId: string) {
    super()
  }
}

/** 倒序向更早翻页、正序向更晚翻页；两个适配器的序号游标语义必须一致。 */
function sequenceCursorCondition(order: 'asc' | 'desc', beforeSequence: number) {
  return order === 'asc' ? { $gt: beforeSequence } : { $lt: beforeSequence }
}

/** 把拆列存放的记录头与正文合回一条完整记录。缺省的正文字段不会变成显式 undefined。 */
function fromModelRequestRow(row: SandboxModelRequestRecordRow): SandboxModelRequestRecord {
  return structuredClone({ ...row.header, ...row.bodies ?? {} })
}

/**
 * 行是否可读。
 *
 * 记录头与正文拆列之前，整条记录存在单独一列里；那些行在新结构下读不出记录身份。
 * 这里直接丢弃它们，而不是重建旧列：模型请求记录是本地验证证据，不承担跨结构迁移。
 */
function isReadableModelRequestRow(row: Pick<SandboxModelRequestRecordRow, 'header'>): boolean {
  return Boolean(row.header && typeof row.header === 'object' && typeof row.header.id === 'string')
}

export class KoishiDatabaseOneBotDebugPersistence implements SandboxOneBotDebugPersistence {
  private index = new ScopeRowIndex()

  constructor(
    private scopeId: string,
    private getDatabase: () => SandboxOneBotDebugDatabase | undefined,
    private readyTimeoutMs = DATABASE_READY_TIMEOUT_MS,
  ) {}

  async summarize(): Promise<SandboxOneBotDebugScopeSummary> {
    // Database 是可选服务，可能在 Store 构造后才注册；不能把服务未就绪伪装成空库，
    // 否则重启后的首次调试记录写入会与数据库中的历史记录撞号。
    const database = await waitForDatabase(this.getDatabase, this.readyTimeoutMs)
    if (!database) throw new Error(`等待 Koishi Database 服务 ${this.readyTimeoutMs}ms 后仍不可用`)
    const [scope] = await database.get(DEBUG_SCOPE_TABLE, { scopeId: this.scopeId })
    // 只取序号与体积两列：恢复容量统计不需要记录正文。
    const rows = await database.get(DEBUG_RECORD_TABLE, { scopeId: this.scopeId }, {
      fields: ['sequence', 'bytes'],
      sort: { sequence: 'asc' },
    })
    this.index.reset(rows, Number(scope?.nextSequence) || 1)
    return this.index.summary()
  }

  async append(record: SandboxOneBotDebugRecord, bytes: number, nextSequence: number) {
    const database = this.requireDatabase()
    await database.upsert(DEBUG_RECORD_TABLE, [{
      scopeId: this.scopeId,
      sequence: record.sequence,
      id: record.id,
      createdAt: record.createdAt,
      botId: record.botId,
      implementation: record.implementation,
      direction: record.direction,
      action: record.action,
      requestedAction: record.requestedAction,
      // 缺省值写空串而不是 undefined：Minato 会丢弃 undefined 字段，过滤条件也就无法判定"未设置"。
      matchedAlias: record.matchedAlias ?? '',
      status: record.status,
      bytes,
      record: structuredClone(record),
    }])
    this.index.put(record.sequence, bytes, nextSequence)
    await this.saveScope(database)
    return this.index.summary()
  }

  async find(recordId: string) {
    const database = this.requireDatabase()
    const [row] = await database.get(DEBUG_RECORD_TABLE, { scopeId: this.scopeId, id: recordId }, { limit: 1 })
    return row ? structuredClone(row.record) : undefined
  }

  async query(query: SandboxOneBotDebugPersistenceQuery) {
    const database = this.requireDatabase()
    const rows = await database.get(DEBUG_RECORD_TABLE, this.toRowQuery(query), {
      sort: { sequence: query.order },
      limit: Math.max(0, query.limit),
    })
    return rows.map((row) => structuredClone(row.record))
  }

  async reclaim(limits: { maxRecords: number, maxBytes: number }) {
    const database = this.requireDatabase()
    const cutoff = this.index.resolveCutoff(limits)
    // 按序号区间删除，不整表重写；索引在删除成功后才收敛，删除失败时下一轮会重新试算。
    if (cutoff !== undefined) {
      await database.remove(DEBUG_RECORD_TABLE, { scopeId: this.scopeId, sequence: { $lte: cutoff } })
      this.index.dropThrough(cutoff)
    }
    return this.index.summary()
  }

  async clear(nextSequence: number) {
    const database = this.requireDatabase()
    await database.remove(DEBUG_RECORD_TABLE, { scopeId: this.scopeId })
    this.index.clear(nextSequence)
    await this.saveScope(database)
    return this.index.summary()
  }

  private toRowQuery(query: SandboxOneBotDebugPersistenceQuery): SandboxRecordRowQuery {
    const rowQuery: SandboxRecordRowQuery = { scopeId: this.scopeId }
    if (query.botId) rowQuery.botId = query.botId
    if (query.direction) rowQuery.direction = query.direction
    if (query.requestedAction) rowQuery.requestedAction = query.requestedAction
    if (query.status) rowQuery.status = query.status
    if (query.beforeSequence !== undefined) rowQuery.sequence = sequenceCursorCondition(query.order, query.beforeSequence)
    if (query.action) {
      rowQuery.$or = [
        { action: query.action.action },
        { requestedAction: query.action.action },
        { matchedAlias: query.action.action },
        ...query.action.aliasTargets.map(({ implementation, actions }) => ({ implementation, action: { $in: actions } })),
      ]
    }
    return rowQuery
  }

  private async saveScope(database: SandboxOneBotDebugDatabase) {
    await database.upsert(DEBUG_SCOPE_TABLE, [{
      scopeId: this.scopeId,
      nextSequence: this.index.readNextSequence(),
      updatedAt: new Date(),
    }])
  }

  private requireDatabase(): SandboxOneBotDebugDatabase {
    const database = this.getDatabase()
    if (!database) throw new Error('Koishi Database 服务不可用，OneBot 调试记录未能落盘')
    return database
  }
}

export class KoishiDatabaseModelRequestPersistence implements SandboxModelRequestPersistence {
  private index = new ScopeRowIndex()

  constructor(
    private scopeId: string,
    private getDatabase: () => SandboxModelRequestDatabase | undefined,
    private readyTimeoutMs = DATABASE_READY_TIMEOUT_MS,
  ) {}

  async summarize(): Promise<SandboxModelRequestScopeSummary> {
    // database 是可选服务，Minato 可能在本插件构造 Store 后才完成注册。这里等待服务，
    // 不能把"尚未可用"伪装成空库，否则重启后的首次请求会与全部历史记录撞号。
    const database = await waitForDatabase(this.getDatabase, this.readyTimeoutMs)
    if (!database) throw new Error(`等待 Koishi Database 服务 ${this.readyTimeoutMs}ms 后仍不可用`)
    const [scope] = await database.get(MODEL_REQUEST_SCOPE_TABLE, { scopeId: this.scopeId })
    const rows = await database.get(MODEL_REQUEST_RECORD_TABLE, { scopeId: this.scopeId }, {
      fields: ['sequence', 'bytes'],
      sort: { sequence: 'asc' },
    })
    this.index.reset(rows, Number(scope?.nextSequence) || 1)
    return this.index.summary()
  }

  async append(record: SandboxModelRequestRecord, bytes: number, nextSequence: number) {
    const database = this.requireDatabase()
    await database.upsert(MODEL_REQUEST_RECORD_TABLE, [this.toRow(record, bytes)])
    this.index.put(record.sequence, bytes, nextSequence)
    await this.saveScope(database)
    return this.index.summary()
  }

  async find(recordId: string) {
    const database = this.requireDatabase()
    const [row] = await database.get(MODEL_REQUEST_RECORD_TABLE, { scopeId: this.scopeId, id: recordId }, { limit: 1 })
    return row && isReadableModelRequestRow(row) ? fromModelRequestRow(row) : undefined
  }

  async replace(record: SandboxModelRequestRecord, bytes: number) {
    const database = this.requireDatabase()
    // 只有仍然存在的行才回写；否则容量回收删掉的记录会被 update 复活。
    if (this.index.has(record.sequence)) {
      await database.upsert(MODEL_REQUEST_RECORD_TABLE, [this.toRow(record, bytes)])
      this.index.put(record.sequence, bytes)
    }
    return this.index.summary()
  }

  async query(query: SandboxModelRequestPersistenceQuery) {
    const database = this.requireDatabase()
    const rows = await database.get(MODEL_REQUEST_RECORD_TABLE, this.toRowQuery(query), {
      sort: { sequence: query.order },
      limit: Math.max(0, query.limit),
    })
    return rows.filter(isReadableModelRequestRow).map((row) => fromModelRequestRow(row))
  }

  async queryHeaders(query: SandboxModelRequestPersistenceQuery) {
    const database = this.requireDatabase()
    // 只投影记录头：请求体与响应原文留在存储里，驱动不必反序列化它们，也不必跨进程搬运。
    // sequence 一并选出，排序列必须在投影里。
    const rows = await database.get(MODEL_REQUEST_RECORD_TABLE, this.toRowQuery(query), {
      fields: ['sequence', 'header'],
      sort: { sequence: query.order },
      limit: Math.max(0, query.limit),
    })
    return rows.filter(isReadableModelRequestRow).map((row) => structuredClone(row.header))
  }

  async reclaim(limits: { maxRecords: number, maxBytes: number }) {
    const database = this.requireDatabase()
    const cutoff = this.index.resolveCutoff(limits)
    if (cutoff !== undefined) {
      await database.remove(MODEL_REQUEST_RECORD_TABLE, { scopeId: this.scopeId, sequence: { $lte: cutoff } })
      this.index.dropThrough(cutoff)
    }
    return this.index.summary()
  }

  async clear(nextSequence: number) {
    const database = this.requireDatabase()
    await database.remove(MODEL_REQUEST_RECORD_TABLE, { scopeId: this.scopeId })
    this.index.clear(nextSequence)
    await this.saveScope(database)
    return this.index.summary()
  }

  private toRow(record: SandboxModelRequestRecord, bytes: number): SandboxModelRequestRecordRow {
    return {
      scopeId: this.scopeId,
      sequence: record.sequence,
      id: record.id,
      createdAt: record.createdAt,
      // 缺省值写空串而不是 undefined：Minato 会丢弃 undefined 字段，过滤条件也就无法判定"未设置"。
      botId: record.entities.botId ?? '',
      conversationId: record.entities.conversationId ?? '',
      interactionId: record.interactionId ?? '',
      model: record.model ?? '',
      status: record.status,
      bytes,
      header: structuredClone(toModelRequestRecordHeader(record)),
      bodies: structuredClone({
        ...(record.requestBody !== undefined ? { requestBody: record.requestBody } : {}),
        ...(record.responseBodyRaw !== undefined ? { responseBodyRaw: record.responseBodyRaw } : {}),
      }),
    }
  }

  private toRowQuery(query: SandboxModelRequestPersistenceQuery): SandboxRecordRowQuery {
    const rowQuery: SandboxRecordRowQuery = { scopeId: this.scopeId }
    if (query.botId) rowQuery.botId = query.botId
    if (query.conversationId) rowQuery.conversationId = query.conversationId
    if (query.interactionId) rowQuery.interactionId = query.interactionId
    if (query.model) rowQuery.model = query.model
    if (query.status) rowQuery.status = query.status
    if (query.beforeSequence !== undefined) {
      rowQuery.sequence = sequenceCursorCondition(query.order, query.beforeSequence)
    } else if (query.beforeCreatedAt) {
      // createdAt 是 ISO 8601，字节序等于时间序；同刻并列时才用 id 决胜，
      // 此时的字符串比较由驱动排序规则决定，与内存侧的 localeCompare 只在同刻同前缀时可能不同。
      const strict = query.order === 'asc' ? { $gt: query.beforeCreatedAt } : { $lt: query.beforeCreatedAt }
      if (query.beforeId) {
        rowQuery.$or = [
          { createdAt: strict },
          { createdAt: query.beforeCreatedAt, id: query.order === 'asc' ? { $gt: query.beforeId } : { $lt: query.beforeId } },
        ]
      } else {
        rowQuery.createdAt = query.order === 'asc'
          ? { $gte: query.beforeCreatedAt }
          : { $lte: query.beforeCreatedAt }
      }
    }
    return rowQuery
  }

  private async saveScope(database: SandboxModelRequestDatabase) {
    await database.upsert(MODEL_REQUEST_SCOPE_TABLE, [{
      scopeId: this.scopeId,
      nextSequence: this.index.readNextSequence(),
      updatedAt: new Date(),
    }])
  }

  private requireDatabase(): SandboxModelRequestDatabase {
    const database = this.getDatabase()
    if (!database) throw new Error('Koishi Database 服务不可用，模型请求记录未能落盘')
    return database
  }
}

// database 是可选服务，可能在本插件之后才加载；构造时缓存服务实例会让持久化永远不可用，
// 必须通过 getter 在每次调用时解析当前服务。
export class KoishiDatabaseTestSpacePersistence implements SandboxTestSpacePersistence {
  constructor(
    private getDatabase: () => SandboxTestSpaceDatabase | undefined,
    private readyTimeoutMs = DATABASE_READY_TIMEOUT_MS,
  ) {}

  async loadAll(): Promise<SandboxTestSpacePersistenceRecord[]> {
    // ready 事件早于 Minato 注册 database 服务。这里必须等待服务出现，不能把
    // "尚未就绪"当成空库返回：那会让每次重启都丢掉全部 AI 测试空间，而且未恢复的
    // 空间再也不会被 delete，数据库行与磁盘媒体目录会无限累积。
    const database = await waitForDatabase(this.getDatabase, this.readyTimeoutMs)
    if (!database) throw new Error(`等待 Koishi Database 服务 ${this.readyTimeoutMs}ms 后仍不可用`)
    const records = await database.get(TEST_SPACE_TABLE, {})
    return records.map((record) => structuredClone(record))
  }

  async save(record: SandboxTestSpacePersistenceRecord): Promise<void> {
    const database = this.getDatabase()
    if (!database) throw new Error('Koishi Database 服务不可用，AI 测试空间未能落盘')
    await database.upsert(TEST_SPACE_TABLE, [structuredClone(record)])
  }

  async delete(id: string): Promise<void> {
    const database = this.getDatabase()
    if (!database) throw new Error('Koishi Database 服务不可用，AI 测试空间未能删除')
    await database.remove(TEST_SPACE_TABLE, { id })
  }
}

export class KoishiDatabaseScenePersistence implements SandboxScenePersistence {
  private persisted = false
  private lastError?: unknown

  constructor(private getDatabase: () => SandboxSceneDatabase | undefined) {}

  getStatus(): SandboxPersistenceStatus {
    if (!this.getDatabase()) return this.createUnavailableStatus()
    if (this.lastError !== undefined) return this.createUnavailableStatus(this.lastError)
    return { mode: 'database', available: true, persisted: this.persisted }
  }

  async load(): Promise<SandboxSceneLoadResult> {
    const database = this.getDatabase()
    if (!database) return { kind: 'unavailable', reason: 'missing-service' }
    try {
      const [record] = await database.get(SCENE_TABLE, { id: SCENE_ID })
      this.lastError = undefined
      if (!record) return { kind: 'missing' }
      this.persisted = true
      return { kind: 'loaded', scene: structuredClone(record.scene) }
    } catch (error) {
      this.lastError = error
      // 查询失败不能伪装成首次启动，否则控制服务会用默认场景覆盖仍在数据库中的旧记录。
      return { kind: 'unavailable', reason: 'query-failed', error }
    }
  }

  async save(scene: SandboxSnapshot): Promise<void> {
    const database = this.getDatabase()
    if (!database) return
    try {
      await database.upsert(SCENE_TABLE, [{
        id: SCENE_ID,
        scene: structuredClone(scene),
        updatedAt: new Date(),
      }])
      this.lastError = undefined
      this.persisted = true
    } catch (error) {
      this.lastError = error
    }
  }

  private createUnavailableStatus(error?: unknown): SandboxPersistenceStatus {
    const detail = error instanceof Error && error.message ? `：${error.message}` : ''
    return {
      mode: 'database',
      available: false,
      persisted: false,
      message: `Koishi Database 服务未安装或不可用${detail}`,
    }
  }
}

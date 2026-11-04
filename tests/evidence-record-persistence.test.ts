import { beforeEach, describe, expect, it } from 'vitest'
import {
  SandboxModelRequestStore,
  estimateModelRequestRecordBytes,
  type AppendModelRequestRecordInput,
  type SandboxModelRequestPersistence,
} from '../src/model-request'
import {
  SandboxOneBotDebugStore,
  estimateOneBotDebugRecordBytes,
  type SandboxOneBotDebugPersistence,
} from '../src/onebot-debug'
import {
  KoishiDatabaseModelRequestPersistence,
  KoishiDatabaseOneBotDebugPersistence,
  MemoryModelRequestPersistence,
  MemoryOneBotDebugPersistence,
  type SandboxModelRequestDatabase,
  type SandboxOneBotDebugDatabase,
} from '../src/persistence'
import { SandboxModelRequestCursorExpiredError, SandboxOneBotDebugCursorExpiredError } from '../src/types'
import { createEvidenceRecordDatabase, type FakeDatabase } from './helpers/fake-database'

/**
 * 内存适配器与数据库适配器必须给出等价的读取语义，因此这两组断言用同一份用例驱动。
 * `database` 只在数据库适配器下有值，写形态探针据此断言单行写入。
 */
interface AdapterCase<Persistence> {
  name: string
  create(): { persistence: Persistence, database?: FakeDatabase }
}

const modelRequestAdapters: AdapterCase<SandboxModelRequestPersistence>[] = [
  { name: '内存适配器', create: () => ({ persistence: new MemoryModelRequestPersistence('main') }) },
  {
    name: '数据库适配器',
    create: () => {
      const database = createEvidenceRecordDatabase()
      return {
        database,
        persistence: new KoishiDatabaseModelRequestPersistence(
          'main',
          () => database as unknown as SandboxModelRequestDatabase,
        ),
      }
    },
  },
]

const debugAdapters: AdapterCase<SandboxOneBotDebugPersistence>[] = [
  { name: '内存适配器', create: () => ({ persistence: new MemoryOneBotDebugPersistence('main') }) },
  {
    name: '数据库适配器',
    create: () => {
      const database = createEvidenceRecordDatabase()
      return {
        database,
        persistence: new KoishiDatabaseOneBotDebugPersistence(
          'main',
          () => database as unknown as SandboxOneBotDebugDatabase,
        ),
      }
    },
  },
]

function modelRequestInput(overrides: Partial<AppendModelRequestRecordInput> = {}): AppendModelRequestRecordInput {
  return {
    status: 'success',
    durationMs: 10,
    attribution: 'attributed',
    entities: { scopeId: 'main' },
    requestBodyAvailable: false,
    responseBodyStatus: 'unavailable',
    ...overrides,
  }
}

describe.each(modelRequestAdapters)('模型请求记录库按行持久化（$name）', ({ create }) => {
  let store: SandboxModelRequestStore
  let database: FakeDatabase | undefined

  beforeEach(async () => {
    const adapter = create()
    database = adapter.database
    store = new SandboxModelRequestStore({ persistence: adapter.persistence })
    await store.waitForReady()
  })

  it('追加与单行更新都不重写其他行，容量按完整持久化内容统计', async () => {
    const first = store.append(modelRequestInput({ model: 'first' }))
    const second = store.append(modelRequestInput({ model: 'second', status: 'pending', responseBodyStatus: 'pending' }))
    await store.waitForPersistence()
    const updated = await store.update(second.id, {
      status: 'success',
      durationMs: 42,
      responseBodyStatus: 'complete',
      responseBodyFormat: 'text',
      responseBodyRaw: 'done',
    })

    expect(updated).toMatchObject({ id: second.id, sequence: second.sequence, status: 'success', responseBodyRaw: 'done' })
    // 第一条记录不受单行更新影响。
    expect(await store.getRecord(first.id)).toMatchObject({ model: 'first', status: 'success' })
    const capacity = await store.getCapacity()
    const raw = await store.getRawRecords({ order: 'asc' })
    expect(capacity.recordCount).toBe(2)
    expect(capacity.totalBytes).toBe(raw.reduce((sum, record) => sum + estimateModelRequestRecordBytes(record), 0))
  })

  it('按 botId、conversationId、interactionId、model 与 status 过滤', async () => {
    store.append(modelRequestInput({
      model: 'alpha',
      interactionId: 'interaction-a',
      entities: { scopeId: 'main', botId: '20001', conversationId: 'private:10001:20001' },
    }))
    store.append(modelRequestInput({
      model: 'beta',
      status: 'error',
      interactionId: 'interaction-b',
      entities: { scopeId: 'main', botId: '20002', conversationId: 'group:30001' },
      error: { code: 'model_request_error', message: 'HTTP 500', retryable: false, traceId: 'trace' },
    }))
    await store.waitForPersistence()

    expect((await store.getRecords({ botId: '20001' })).records.map(({ model }) => model)).toEqual(['alpha'])
    expect((await store.getRecords({ conversationId: 'group:30001' })).records.map(({ model }) => model)).toEqual(['beta'])
    expect((await store.getRecords({ interactionId: 'interaction-a' })).records.map(({ model }) => model)).toEqual(['alpha'])
    expect((await store.getRecords({ model: 'beta' })).records.map(({ model }) => model)).toEqual(['beta'])
    expect((await store.getRecords({ status: 'error' })).records.map(({ model }) => model)).toEqual(['beta'])
    // 过滤字段缺省的记录不应被显式条件命中。
    expect((await store.getRecords({ botId: '29999' })).records).toEqual([])
  })

  it('保持稳定序号游标语义，读取已回收位置返回 cursor_expired 与当前最早游标', async () => {
    const capped = new SandboxModelRequestStore({ persistence: create().persistence, maxRecords: 2 })
    await capped.waitForReady()
    capped.append(modelRequestInput({ model: 'one' }))
    capped.append(modelRequestInput({ model: 'two' }))
    capped.append(modelRequestInput({ model: 'three' }))

    const page = await capped.getRecords({ limit: 1 })
    expect(page.records.map(({ model }) => model)).toEqual(['three'])
    expect(page.hasMore).toBe(true)
    expect(page.earliestCursor).toBe(2)
    expect((await capped.getRecords({ limit: 1, beforeSequence: page.nextCursor })).records.map(({ model }) => model)).toEqual(['two'])
    expect((await capped.getRecords({ order: 'asc' })).records.map(({ model }) => model)).toEqual(['two', 'three'])
    await expect(capped.getRecords({ beforeSequence: 1 })).rejects.toBeInstanceOf(SandboxModelRequestCursorExpiredError)
  })

  it('支持按创建时间与记录 ID 的跨库游标', async () => {
    const created = store.append(modelRequestInput({ model: 'only' }))
    await store.waitForPersistence()

    expect((await store.getRecords({ beforeCreatedAt: '1970-01-01T00:00:00.000Z' })).records).toEqual([])
    expect((await store.getRecords({ beforeCreatedAt: created.createdAt, beforeId: created.id })).records).toEqual([])
    expect((await store.getRecords({ beforeCreatedAt: created.createdAt })).records.map(({ id }) => id)).toEqual([created.id])
    expect((await store.getRecords({ beforeCreatedAt: '2999-01-01T00:00:00.000Z' })).records.map(({ id }) => id)).toEqual([created.id])
  })

  it('字节上限同样从最旧开始回收，容量统计随之收敛', async () => {
    const single = store.append(modelRequestInput({ model: 'sizing' }))
    await store.waitForPersistence()
    const bytes = estimateModelRequestRecordBytes(single)
    const bounded = new SandboxModelRequestStore({ persistence: create().persistence, maxBytes: bytes * 2 })
    await bounded.waitForReady()
    bounded.append(modelRequestInput({ model: 'sizing' }))
    bounded.append(modelRequestInput({ model: 'sizing' }))
    bounded.append(modelRequestInput({ model: 'sizing' }))

    const capacity = await bounded.getCapacity()
    expect(capacity.recordCount).toBe(2)
    expect(capacity.totalBytes).toBeLessThanOrEqual(bytes * 2)
    expect((await bounded.getRecords({ order: 'asc' })).records.map(({ sequence }) => sequence)).toEqual([2, 3])
  })

  it('清空作用域后序号不回退', async () => {
    store.append(modelRequestInput({ model: 'first' }))
    store.append(modelRequestInput({ model: 'second' }))
    expect(await store.clear()).toBe(2)
    const next = store.append(modelRequestInput({ model: 'third' }))
    await store.waitForPersistence()

    expect((await store.getRecords()).records.map(({ model, sequence }) => ({ model, sequence })))
      .toEqual([{ model: 'third', sequence: next.sequence }])
    expect(next.sequence).toBe(3)
  })

  it('单次写入体积不随记录总数增长', async () => {
    if (!database) return
    const payload = 'x'.repeat(2048)
    for (let index = 0; index < 40; index += 1) {
      const record = store.append(modelRequestInput({
        model: `probe-${index}`,
        requestBodyAvailable: true,
        requestBody: { model: `probe-${index}`, prompt: payload },
        status: 'pending',
        responseBodyStatus: 'pending',
      }))
      await store.waitForPersistence()
      await store.update(record.id, { status: 'success', responseBodyStatus: 'complete', responseBodyFormat: 'text', responseBodyRaw: payload })
    }
    await store.waitForPersistence()

    const recordWrites = database.writes.filter(({ table, operation }) => (
      table === 'onebot_sandbox_model_request' && operation === 'upsert'
    ))
    // 每次 append 与每次 update 都只写一行。
    expect(recordWrites).toHaveLength(80)
    expect(recordWrites.every(({ rows }) => rows === 1)).toBe(true)
    const early = recordWrites.slice(0, 4).reduce((max, { bytes }) => Math.max(max, bytes), 0)
    const late = recordWrites.slice(-4).reduce((max, { bytes }) => Math.max(max, bytes), 0)
    expect(late).toBeLessThanOrEqual(early * 1.2)
  })
})

describe.each(debugAdapters)('OneBot 调试记录库按行持久化（$name）', ({ create }) => {
  let store: SandboxOneBotDebugStore
  let database: FakeDatabase | undefined

  beforeEach(async () => {
    const adapter = create()
    database = adapter.database
    store = new SandboxOneBotDebugStore({ persistence: adapter.persistence })
    await store.waitForReady()
  })

  it('按 botId、direction、requestedAction 与 status 过滤', async () => {
    store.append({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'get_status', action: 'get_status', status: 'success', durationMs: 1,
    })
    store.append({
      botId: '20002', implementation: 'napcat', direction: 'event',
      requestedAction: 'message', action: 'message', status: 'error', durationMs: 2,
      error: { code: 'onebot_error', message: 'boom', retryable: false, traceId: 'trace' },
    })
    await store.waitForPersistence()

    expect((await store.getRecords({ botId: '20001' })).records.map(({ action }) => action)).toEqual(['get_status'])
    expect((await store.getRecords({ direction: 'event' })).records.map(({ action }) => action)).toEqual(['message'])
    expect((await store.getRecords({ requestedAction: 'get_status' })).records.map(({ action }) => action)).toEqual(['get_status'])
    expect((await store.getRecords({ status: 'error' })).records.map(({ action }) => action)).toEqual(['message'])
  })

  it('action 过滤覆盖能力矩阵声明的别名', async () => {
    store.append({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'send_poke', action: 'send_poke', status: 'success', durationMs: 1,
    })
    store.append({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'get_status', action: 'get_status', status: 'success', durationMs: 1,
    })
    await store.waitForPersistence()

    // friend_poke 是 send_poke 的矩阵别名，规范名记录也必须命中。
    expect((await store.getRecords({ action: 'friend_poke' })).records.map(({ action }) => action)).toEqual(['send_poke'])
    expect((await store.getRecords({ action: 'send_poke' })).records.map(({ action }) => action)).toEqual(['send_poke'])
    expect((await store.getRecords({ action: 'get_status' })).records.map(({ action }) => action)).toEqual(['get_status'])
  })

  it('容量回收后过期游标返回 earliestCursor，且容量按完整内容统计', async () => {
    const capped = new SandboxOneBotDebugStore({ persistence: create().persistence, maxRecords: 2 })
    await capped.waitForReady()
    for (const action of ['get_status', 'get_login_info', 'get_version_info']) {
      capped.append({
        botId: '20001', implementation: 'napcat', direction: 'action',
        requestedAction: action, action, status: 'success', durationMs: 1,
      })
    }

    const page = await capped.getRecords({ limit: 10 })
    expect(page.records.map(({ sequence }) => sequence)).toEqual([3, 2])
    expect(page.earliestCursor).toBe(2)
    expect(page.capacity.recordCount).toBe(2)
    expect(page.capacity.totalBytes).toBeGreaterThan(0)
    await expect(capped.getRecords({ beforeSequence: 1 })).rejects.toBeInstanceOf(SandboxOneBotDebugCursorExpiredError)
  })

  it('清空作用域后序号不回退', async () => {
    store.append({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'get_status', action: 'get_status', status: 'success', durationMs: 1,
    })
    expect(await store.clear()).toBe(1)
    store.append({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'get_login_info', action: 'get_login_info', status: 'success', durationMs: 1,
    })
    await store.waitForPersistence()

    expect((await store.getRecords()).records.map(({ sequence }) => sequence)).toEqual([2])
  })

  it('单次写入体积不随记录总数增长，回收按序号区间删除', async () => {
    if (!database) return
    const capped = new SandboxOneBotDebugStore({
      persistence: new KoishiDatabaseOneBotDebugPersistence('main', () => database as unknown as SandboxOneBotDebugDatabase),
      maxRecords: 5,
    })
    await capped.waitForReady()
    const payload = { blob: 'y'.repeat(4096) }
    for (let index = 0; index < 30; index += 1) {
      capped.append({
        botId: '20001', implementation: 'napcat', direction: 'action',
        requestedAction: 'get_status', action: 'get_status', status: 'success', durationMs: 1,
        payload,
      })
      await capped.waitForPersistence()
    }

    const recordWrites = database.writes.filter(({ table, operation }) => (
      table === 'onebot_sandbox_debug_record' && operation === 'upsert'
    ))
    expect(recordWrites).toHaveLength(30)
    expect(recordWrites.every(({ rows }) => rows === 1)).toBe(true)
    const early = recordWrites.slice(0, 3).reduce((max, { bytes }) => Math.max(max, bytes), 0)
    const late = recordWrites.slice(-3).reduce((max, { bytes }) => Math.max(max, bytes), 0)
    expect(late).toBeLessThanOrEqual(early * 1.2)
    // 超限部分按区间删除，表里只剩窗口内的行。
    expect(database.countRows('onebot_sandbox_debug_record')).toBe(5)
    const kept = await capped.getRecords({ limit: 10 })
    expect(kept.records.map(({ sequence }) => sequence)).toEqual([30, 29, 28, 27, 26])
    expect(kept.capacity.totalBytes).toBe(
      (await Promise.all(kept.records.map(async ({ id }) => (await capped.getRecord(id, true))!)))
        .reduce((sum, record) => sum + estimateOneBotDebugRecordBytes(record), 0),
    )
  })
})

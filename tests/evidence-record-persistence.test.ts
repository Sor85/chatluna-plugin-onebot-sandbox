import { beforeEach, describe, expect, it } from 'vitest'
import {
  SandboxOneBotDebugStore,
  estimateOneBotDebugRecordBytes,
  type SandboxOneBotDebugPersistence,
} from '../src/onebot-debug'
import {
  KoishiDatabaseOneBotDebugPersistence,
  MemoryOneBotDebugPersistence,
  type SandboxOneBotDebugDatabase,
} from '../src/persistence'
import { SandboxOneBotDebugCursorExpiredError } from '../src/types'
import { createEvidenceRecordDatabase, type FakeDatabase } from './helpers/fake-database'

/**
 * 内存适配器与数据库适配器必须给出等价的读取语义，因此断言用同一份用例驱动。
 * `database` 只在数据库适配器下有值，写形态探针据此断言单行写入。
 */
interface AdapterCase<Persistence> {
  name: string
  create(): { persistence: Persistence, database?: FakeDatabase }
}

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

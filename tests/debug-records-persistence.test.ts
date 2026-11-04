import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import {
  MemoryOneBotDebugPersistence,
  KoishiDatabaseOneBotDebugPersistence,
  type SandboxOneBotDebugDatabase,
} from '../src/persistence'
import type { SandboxOneBotDebugRecord } from '../src/types'
import { SandboxTestSpaceService } from '../src/test-spaces'
import { createEvidenceRecordDatabase, type FakeDatabase } from './helpers/fake-database'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

describe('OneBot 调试记录持久化与分页', () => {
  it('Database 服务晚到时合并历史与启动期记录，且不会用空状态覆盖历史', async () => {
    const historical: SandboxOneBotDebugRecord = {
      id: 'historical',
      sequence: 7,
      createdAt: '2026-08-13T00:00:00.000Z',
      botId: '20001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'historical_action',
      action: 'historical_action',
      status: 'success',
      durationMs: 1,
      payload: {},
      result: {},
      entities: {},
    }
    const stored = createEvidenceRecordDatabase()
    await stored.upsert('onebot_sandbox_debug_record', [{
      scopeId: 'main',
      sequence: historical.sequence,
      id: historical.id,
      createdAt: historical.createdAt,
      botId: historical.botId,
      implementation: historical.implementation,
      direction: historical.direction,
      action: historical.action,
      requestedAction: historical.requestedAction,
      matchedAlias: '',
      status: historical.status,
      bytes: Buffer.byteLength(JSON.stringify(historical), 'utf8'),
      record: historical,
    }])
    await stored.upsert('onebot_sandbox_debug_scope', [{ scopeId: 'main', nextSequence: 8, updatedAt: new Date() }])
    let database: FakeDatabase | undefined
    const persistence = new KoishiDatabaseOneBotDebugPersistence(
      'main',
      () => database as unknown as SandboxOneBotDebugDatabase | undefined,
    )
    const app = new App()
    runningApps.push(app)
    const control = new SandboxControlService(app, { debugPersistence: persistence })

    control.recordOneBotDebug({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'startup_action', action: 'startup_action', status: 'success', durationMs: 1,
    })
    setTimeout(() => {
      database = stored
    }, 30)

    await control.waitForPersistence()
    expect((await control.getOneBotDebugStore().getRecords({ limit: 10 })).records.map(({ requestedAction, sequence }) => ({ requestedAction, sequence }))).toEqual([
      { requestedAction: 'startup_action', sequence: 8 },
      { requestedAction: 'historical_action', sequence: 7 },
    ])
    const rows = await stored.get('onebot_sandbox_debug_record', { scopeId: 'main' }, { sort: { sequence: 'asc' } })
    expect(rows.map((row) => (row as { sequence: number }).sequence)).toEqual([7, 8])
    // 启动期记录只插入自己那一行，历史行不被重写。
    expect(stored.writes.filter(({ table, operation }) => (
      table === 'onebot_sandbox_debug_record' && operation === 'upsert'
    )).every(({ rows: written }) => written === 1)).toBe(true)
    const [scope] = await stored.get('onebot_sandbox_debug_scope', { scopeId: 'main' })
    expect((scope as unknown as { nextSequence: number }).nextSequence).toBe(9)
  })

  it('共享内存 Adapter 后跨控制服务实例恢复记录，且 sequence 不回退', async () => {
    const app = new App()
    runningApps.push(app)
    const persistence = new MemoryOneBotDebugPersistence('main')
    const first = new SandboxControlService(app, { debugPersistence: persistence })
    await first.waitForPersistence()
    await first.bot.internal._request('get_status', {})
    await first.bot.internal._request('get_login_info', {})
    await first.waitForPersistence()

    const second = new SandboxControlService(app, { debugPersistence: persistence })
    await second.waitForPersistence()
    const restored = (await second.getOneBotDebugStore().getRecords({ limit: 10 }))
    expect(restored.records.map(({ requestedAction, sequence }) => ({ requestedAction, sequence }))).toEqual([
      { requestedAction: 'get_login_info', sequence: 2 },
      { requestedAction: 'get_status', sequence: 1 },
    ])

    await second.bot.internal._request('get_version_info', {})
    const afterAppend = (await second.getOneBotDebugStore().getRecords({ limit: 10 }))
    expect(afterAppend.records[0]).toMatchObject({ requestedAction: 'get_version_info', sequence: 3 })
  })

  it('删除测试空间时清理其独立调试记录', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const stores = new Map<string, MemoryOneBotDebugPersistence>()
    const spaces = new SandboxTestSpaceService(app, runtimeBots, undefined, (scopeId) => {
      const existing = stores.get(scopeId)
      if (existing) return existing
      const created = new MemoryOneBotDebugPersistence(scopeId)
      stores.set(scopeId, created)
      return created
    })
    const space = spaces.createSpace({ name: '调试空间' })
    const control = spaces.getControl(space.id)
    control.recordOneBotDebug({
      botId: '21001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'get_status',
      action: 'get_status',
      status: 'success',
      durationMs: 1,
    })
    expect((await control.getOneBotDebugStore().getRecords()).records).toHaveLength(1)
    await control.waitForPersistence()

    spaces.deleteSpace(space.id)
    await control.waitForPersistence()
    const recreated = new SandboxControlService(app, {
      debugPersistence: stores.get(space.id),
      runtimeActive: false,
    })
    await recreated.waitForPersistence()
    expect((await recreated.getOneBotDebugStore().getRecords()).records).toEqual([])
  })
})

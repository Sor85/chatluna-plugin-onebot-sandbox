import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import {
  MemoryModelRequestPersistence,
  KoishiDatabaseModelRequestPersistence,
  type SandboxModelRequestDatabase,
} from '../src/persistence'
import type { SandboxModelRequestRecord } from '../src/types'
import { SandboxTestSpaceService } from '../src/test-spaces'
import { createEvidenceRecordDatabase, type FakeDatabase } from './helpers/fake-database'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

describe('模型请求记录持久化与生命周期', () => {
  it('Database 服务晚到时合并历史与启动期请求，且不会用空状态覆盖历史', async () => {
    const historical: SandboxModelRequestRecord = {
      id: 'historical',
      sequence: 7,
      createdAt: '2026-08-13T00:00:00.000Z',
      status: 'success',
      durationMs: 5,
      model: 'historical-model',
      attribution: 'attributed',
      entities: { scopeId: 'main' },
      requestBodyAvailable: false,
      responseBodyStatus: 'unavailable',
    }
    const stored = createEvidenceRecordDatabase()
    await stored.upsert('onebot_sandbox_model_request', [{
      scopeId: 'main',
      sequence: historical.sequence,
      id: historical.id,
      createdAt: historical.createdAt,
      botId: '',
      conversationId: '',
      interactionId: '',
      model: historical.model,
      status: historical.status,
      bytes: Buffer.byteLength(JSON.stringify(historical), 'utf8'),
      header: historical,
      bodies: {},
    }])
    await stored.upsert('onebot_sandbox_model_request_scope', [{ scopeId: 'main', nextSequence: 8, updatedAt: new Date() }])
    let database: FakeDatabase | undefined
    const persistence = new KoishiDatabaseModelRequestPersistence(
      'main',
      () => database as unknown as SandboxModelRequestDatabase | undefined,
    )
    const app = new App()
    runningApps.push(app)
    const control = new SandboxControlService(app, { modelRequestPersistence: persistence })

    control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'startup-model',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    setTimeout(() => {
      database = stored
    }, 30)

    await control.waitForPersistence()
    expect((await control.getModelRequestStore().getRecords()).records.map(({ id, model, sequence }) => ({ id, model, sequence }))).toEqual([
      expect.objectContaining({ model: 'startup-model', sequence: 8 }),
      { id: 'historical', model: 'historical-model', sequence: 7 },
    ])
    // 启动期请求只插入自己那一行，历史行不被重写。
    const rows = await stored.get('onebot_sandbox_model_request', { scopeId: 'main' }, { sort: { sequence: 'asc' } })
    expect(rows.map((row) => (row as { sequence: number }).sequence)).toEqual([7, 8])
    expect(stored.writes.filter(({ table, operation }) => (
      table === 'onebot_sandbox_model_request' && operation === 'upsert'
    )).every(({ rows: written }) => written === 1)).toBe(true)
    const [scope] = await stored.get('onebot_sandbox_model_request_scope', { scopeId: 'main' })
    expect((scope as unknown as { nextSequence: number }).nextSequence).toBe(9)
  })

  it('丢弃记录头与正文拆列之前写入的行，不让它们变成没有身份的记录', async () => {
    const stored = createEvidenceRecordDatabase()
    // 旧结构把整条记录放在单独一列里；新结构读不出身份，这一行应当被跳过。
    await stored.upsert('onebot_sandbox_model_request', [{
      scopeId: 'main',
      sequence: 3,
      id: 'legacy',
      createdAt: '2026-08-13T00:00:00.000Z',
      botId: '',
      conversationId: '',
      interactionId: '',
      model: 'legacy-model',
      status: 'success',
      bytes: 10,
      record: { id: 'legacy', sequence: 3 },
    }])
    const persistence = new KoishiDatabaseModelRequestPersistence(
      'main',
      () => stored as unknown as SandboxModelRequestDatabase,
    )
    const app = new App()
    runningApps.push(app)
    const control = new SandboxControlService(app, { modelRequestPersistence: persistence })
    await control.waitForPersistence()

    control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'current-model',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    await control.waitForPersistence()

    expect((await control.getModelRequestStore().getRecords()).records.map(({ model }) => model)).toEqual(['current-model'])
    expect(await control.getModelRequestStore().requireRecord('legacy').catch(() => 'missing')).toBe('missing')
  })

  it('共享内存 Adapter 后跨控制服务实例恢复记录，且 sequence 不回退', async () => {
    const app = new App()
    runningApps.push(app)
    const persistence = new MemoryModelRequestPersistence('main')
    const first = new SandboxControlService(app, { modelRequestPersistence: persistence })
    await first.waitForPersistence()
    first.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'first',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    first.getModelRequestStore().append({
      status: 'success', durationMs: 2, model: 'second',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    await first.waitForPersistence()

    const second = new SandboxControlService(app, { modelRequestPersistence: persistence })
    await second.waitForPersistence()
    expect((await second.getModelRequestStore().getRecords()).records.map(({ model, sequence }) => ({ model, sequence }))).toEqual([
      { model: 'second', sequence: 2 },
      { model: 'first', sequence: 1 },
    ])
    second.getModelRequestStore().append({
      status: 'success', durationMs: 3, model: 'third',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    expect((await second.getModelRequestStore().getRecords()).records[0]).toMatchObject({ model: 'third', sequence: 3 })
  })

  it('重置场景只清理对应空间记录，完成空间仍保留记录', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const stores = new Map<string, MemoryModelRequestPersistence>()
    const main = new SandboxControlService(app, { runtimeBots, modelRequestPersistence: new MemoryModelRequestPersistence('main') })
    const spaces = new SandboxTestSpaceService(app, runtimeBots, undefined, undefined, (scopeId) => {
      const existing = stores.get(scopeId)
      if (existing) return existing
      const created = new MemoryModelRequestPersistence(scopeId)
      stores.set(scopeId, created)
      return created
    })
    const space = spaces.createSpace({ name: '请求空间' })
    main.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'main-model',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    space.control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'space-model',
      attribution: 'attributed', entities: { scopeId: space.id }, requestBodyAvailable: false,
    })

    space.control.resetScene()
    expect((await space.control.getModelRequestStore().getRecords()).records).toEqual([])
    expect((await main.getModelRequestStore().getRecords()).records).toHaveLength(1)

    space.control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'kept-after-complete',
      attribution: 'attributed', entities: { scopeId: space.id }, requestBodyAvailable: false,
    })
    spaces.completeSpace(space.id)
    expect((await space.control.getModelRequestStore().getRecords()).records).toHaveLength(1)
  })

  it('删除测试空间时清理其独立模型请求记录', async () => {
    const app = new App()
    runningApps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const stores = new Map<string, MemoryModelRequestPersistence>()
    const spaces = new SandboxTestSpaceService(app, runtimeBots, undefined, undefined, (scopeId) => {
      const existing = stores.get(scopeId)
      if (existing) return existing
      const created = new MemoryModelRequestPersistence(scopeId)
      stores.set(scopeId, created)
      return created
    })
    const space = spaces.createSpace({ name: '待删空间' })
    const control = spaces.getControl(space.id)
    control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'doomed',
      attribution: 'attributed', entities: { scopeId: space.id }, requestBodyAvailable: false,
    })
    await control.waitForPersistence()
    spaces.deleteSpace(space.id)
    await control.waitForPersistence()

    const recreated = new SandboxControlService(app, {
      modelRequestPersistence: stores.get(space.id),
      runtimeActive: false,
    })
    await recreated.waitForPersistence()
    expect((await recreated.getModelRequestStore().getRecords()).records).toEqual([])
  })
})

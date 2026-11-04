import { App } from './helpers/app'
import { describe, expect, it, vi } from 'vitest'
import {
  KoishiDatabaseScenePersistence,
  KoishiDatabaseTestSpacePersistence,
  registerSandboxSceneModel,
  registerSandboxTestSpaceModel,
} from '../src/persistence'
import type { SandboxSnapshot } from '../src/types'

const snapshot: SandboxSnapshot = {
  revision: 7,
  participants: [{ kind: 'user', id: '10001', name: '测试用户' }],
  groups: [],
  conversations: [{
    id: 'private:10001:20001',
    type: 'direct',
    participantIds: ['10001', '20001'],
    messageIds: ['message-1'],
  }],
  messages: [{
    id: 'message-1',
    authorId: '10001',
    conversationId: 'private:10001:20001',
    content: '[图片]',
    createdAt: '2026-07-25T00:00:00.000Z',
    media: [{
      id: '0123456789abcdef0123456789abcdef',
      type: 'image',
      name: 'image.png',
      mimeType: 'image/png',
      size: 4,
      reference: 'sandbox-media://0123456789abcdef0123456789abcdef',
    }],
  }],
  forwards: [],
  friendships: [],
  requests: [],
}

function createDatabaseContext() {
  const records = new Map<string, { id: string, scene: SandboxSnapshot, updatedAt: Date }>()
  const database = {
    get: vi.fn(async (_table: string, query: { id: string }) => {
      const record = records.get(query.id)
      return record ? [structuredClone(record)] : []
    }),
    upsert: vi.fn(async (_table: string, rows: Array<{ id: string, scene: SandboxSnapshot, updatedAt: Date }>) => {
      for (const row of rows) records.set(row.id, structuredClone(row))
      return {}
    }),
  }
  return { database, records }
}

function createTestSpaceDatabaseContext() {
  type Record = Parameters<KoishiDatabaseTestSpacePersistence['save']>[0]
  const records = new Map<string, Record>()
  const database = {
    get: vi.fn(async (_table: string, query: { id?: string }) => {
      const values = query.id ? [records.get(query.id)].filter((record): record is Record => !!record) : [...records.values()]
      return values.map((record) => structuredClone(record))
    }),
    upsert: vi.fn(async (_table: string, rows: Record[]) => {
      for (const row of rows) records.set(row.id, structuredClone(row))
      return {}
    }),
    remove: vi.fn(async (_table: string, query: { id: string }) => {
      records.delete(query.id)
      return {}
    }),
  }
  return { database, records }
}

describe('Koishi Database 场景仓库', () => {
  it('注册场景表并只用 JSON 场景读写业务状态和媒体元数据', async () => {
    const context = createDatabaseContext()
    const app = new App()
    const extend = vi.spyOn(app.model, 'extend')
    registerSandboxSceneModel(app)
    const persistence = new KoishiDatabaseScenePersistence(() => context.database)

    expect(extend).toHaveBeenCalledWith('onebot_sandbox_scene', expect.objectContaining({
      id: expect.anything(),
      scene: 'json',
      updatedAt: 'timestamp',
    }), { primary: 'id' })
    expect(await persistence.load()).toEqual({ kind: 'missing' })

    await persistence.save(snapshot)
    expect(await persistence.load()).toEqual({ kind: 'loaded', scene: snapshot })
    expect(context.database.upsert).toHaveBeenCalledWith('onebot_sandbox_scene', [expect.objectContaining({
      id: 'main',
      scene: snapshot,
    })])
    expect(JSON.stringify(context.records.get('main'))).not.toContain('dataBase64')
    expect(persistence.getStatus()).toEqual({
      mode: 'database',
      available: true,
      persisted: true,
    })
  })

  it('数据库服务缺失时明确报告不可用且不误报已持久化', async () => {
    const persistence = new KoishiDatabaseScenePersistence(() => undefined)

    expect(await persistence.load()).toEqual({
      kind: 'unavailable',
      reason: 'missing-service',
    })
    await persistence.save(snapshot)
    expect(persistence.getStatus()).toEqual({
      mode: 'database',
      available: false,
      persisted: false,
      message: 'Koishi Database 服务未安装或不可用',
    })
  })

  it('查询失败与空表严格区分，避免调用方把故障当成首次启动', async () => {
    const error = new Error('SQLITE_BUSY')
    const database = {
      get: vi.fn(async () => { throw error }),
      upsert: vi.fn(async () => ({})),
    }
    const persistence = new KoishiDatabaseScenePersistence(() => database)

    expect(await persistence.load()).toEqual({
      kind: 'unavailable',
      reason: 'query-failed',
      error,
    })
    expect(persistence.getStatus()).toEqual({
      mode: 'database',
      available: false,
      persisted: false,
      message: 'Koishi Database 服务未安装或不可用：SQLITE_BUSY',
    })
    expect(database.upsert).not.toHaveBeenCalled()
  })

  it('持久化 AI 测试空间元数据和独立场景', async () => {
    const context = createTestSpaceDatabaseContext()
    const app = new App()
    const extend = vi.spyOn(app.model, 'extend')
    registerSandboxTestSpaceModel(app)
    const persistence = new KoishiDatabaseTestSpacePersistence(() => context.database)
    const record = {
      id: 'space-1',
      name: '退群公告测试',
      status: 'completed' as const,
      createdAt: '2026-07-25T01:00:00.000Z',
      updatedAt: '2026-07-25T02:00:00.000Z',
      completedAt: '2026-07-25T02:00:00.000Z',
      scene: snapshot,
    }

    expect(extend).toHaveBeenCalledWith('onebot_sandbox_test_space', expect.objectContaining({
      id: expect.anything(),
      scene: 'json',
    }), { primary: 'id' })
    await persistence.save(record)
    expect(await persistence.loadAll()).toEqual([record])
    await persistence.delete(record.id)
    expect(await persistence.loadAll()).toEqual([])
  })
})

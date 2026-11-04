import { App } from './helpers/app'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmptyScene, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxTestSpaceService } from '../src/test-spaces'
import { KoishiDatabaseTestSpacePersistence } from '../src/persistence'
import type { SandboxTestSpacePersistence, SandboxTestSpacePersistenceRecord } from '../src/persistence'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** 复刻 Minato Model.format() 的行为：值为 undefined 的字段不会进入 upsert。 */
class MinatoLikeTestSpacePersistence implements SandboxTestSpacePersistence {
  private rows = new Map<string, SandboxTestSpacePersistenceRecord>()

  async loadAll(): Promise<SandboxTestSpacePersistenceRecord[]> {
    return [...this.rows.values()].map((row) => structuredClone(row))
  }

  async save(record: SandboxTestSpacePersistenceRecord): Promise<void> {
    const existing = this.rows.get(record.id)
    const patch = Object.fromEntries(
      Object.entries(record).filter(([, value]) => value !== undefined),
    ) as SandboxTestSpacePersistenceRecord
    this.rows.set(record.id, structuredClone({ ...(existing ?? {}), ...patch }))
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createService(persistence?: SandboxTestSpacePersistence) {
  const app = new App()
  const baseDir = await makeTemporaryDirectory('sandbox-spaces-')
  app.baseDir = baseDir
  let service: SandboxTestSpaceService | undefined
  app.plugin((ctx) => {
    service = new SandboxTestSpaceService(ctx, new SandboxRuntimeBotRegistry(), persistence)
  })
  runningApps.push(app)
  await app.start()
  if (!service) throw new Error('service 未创建')
  return { app, service, baseDir }
}

describe('重新激活的空间不会带着过期 completedAt 恢复', () => {
  it('reactivateSpace 之后落盘的 completedAt 被清空', async () => {
    const persistence = new MinatoLikeTestSpacePersistence()
    const first = await createService(persistence)
    const created = first.service.createSpace({ name: '空间' })
    first.service.completeSpace(created.id)
    await first.service.waitForPersistence()
    expect((await persistence.loadAll())[0]!.completedAt).toBeTruthy()

    first.service.reactivateSpace(created.id, 'taken-over')
    await first.service.waitForPersistence()
    expect((await persistence.loadAll())[0]!.completedAt).toBe('')

    // 重启恢复：taken-over 的空间不应带着上一次结束时间
    await first.app.stop()
    runningApps.splice(runningApps.indexOf(first.app), 1)
    const second = await createService(persistence)
    const restored = second.service.getSpace(created.id)
    expect(restored.status).toBe('taken-over')
    expect(restored.completedAt).toBeUndefined()
  })

  it('已结束的空间恢复后仍保留 completedAt', async () => {
    const persistence = new MinatoLikeTestSpacePersistence()
    const first = await createService(persistence)
    const created = first.service.createSpace({ name: '空间' })
    const completed = first.service.completeSpace(created.id)
    await first.service.waitForPersistence()
    await first.app.stop()
    runningApps.splice(runningApps.indexOf(first.app), 1)

    const second = await createService(persistence)
    const restored = second.service.getSpace(created.id)
    expect(restored.status).toBe('completed')
    expect(restored.completedAt).toBe(completed.completedAt)
  })
})

describe('空间媒体目录随空间回收', () => {
  it('deleteSpace 删除该空间的媒体目录', async () => {
    const { service } = await createService()
    const created = service.createSpace({ name: '空间' })
    const directory = created.control.getMediaDirectory()
    expect(existsSync(directory)).toBe(true)

    service.deleteSpace(created.id)
    await created.control.waitForPersistence()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 整棵 spaces/<id>/ 被回收，不只是内部的 media
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(dirname(directory))).toBe(false)
  })

  it('内存模式下关机会清理仍存活空间的媒体目录', async () => {
    const { app, service } = await createService()
    const created = service.createSpace({ name: '空间' })
    const directory = created.control.getMediaDirectory()
    expect(existsSync(directory)).toBe(true)

    await app.stop()
    runningApps.splice(runningApps.indexOf(app), 1)
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(dirname(directory))).toBe(false)
  })

  it('数据库模式下关机不删除仍可恢复空间的媒体目录', async () => {
    const persistence = new MinatoLikeTestSpacePersistence()
    const { app, service } = await createService(persistence)
    const created = service.createSpace({ name: '空间' })
    const directory = created.control.getMediaDirectory()

    await app.stop()
    runningApps.splice(runningApps.indexOf(app), 1)
    expect(existsSync(directory)).toBe(true)
  })
})

describe('数据库晚于 ready 注册时空间仍能恢复', () => {
  it('loadAll 等待 database 服务出现，而不是把未就绪当成空库', async () => {
    const rows: SandboxTestSpacePersistenceRecord[] = [{
      id: 'late-space',
      name: '晚到数据库',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: '',
      scene: createEmptyScene(),
    }]
    let database: unknown
    // Minato 的注册晚于 ready；这里用 60ms 模拟同一时序
    setTimeout(() => {
      database = {
        get: async () => rows.map((row) => structuredClone(row)),
        upsert: async () => {},
        remove: async () => {},
      }
    }, 60)

    const persistence = new KoishiDatabaseTestSpacePersistence(() => database as never, 2000)
    const app = new App()
    const baseDir = await makeTemporaryDirectory('sandbox-late-db-')
    app.baseDir = baseDir
    let service: SandboxTestSpaceService | undefined
    app.plugin((ctx) => {
      service = new SandboxTestSpaceService(ctx, new SandboxRuntimeBotRegistry(), persistence)
    })
    runningApps.push(app)
    await app.start()
    await service!.waitForPersistence()
    // ready 里的恢复是异步的，等待其完成
    for (let attempt = 0; attempt < 50 && !service!.listSpaces().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(service!.listSpaces().map(({ id }) => id)).toEqual(['late-space'])
    expect(service!.getSpace('late-space').completedAt).toBeUndefined()
  })

  it('database 始终不可用时抛出可见错误，不静默丢失空间', async () => {
    const persistence = new KoishiDatabaseTestSpacePersistence(() => undefined, 50)
    await expect(persistence.loadAll()).rejects.toThrow('等待 Koishi Database 服务 50ms 后仍不可用')
  })
})

describe('恢复时的机器人 ID 冲突不会吞掉其他空间', () => {
  function spaceRecordWithBot(id: string, botId: string): SandboxTestSpacePersistenceRecord {
    const scene = createEmptyScene()
    scene.participants.push({ id: botId, kind: 'bot', name: '冲突机器人', implementation: 'napcat', enabled: true } as never)
    return {
      id,
      name: id,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: '',
      scene,
    }
  }

  it('两个空间共用同一机器人 ID 时都会被恢复', async () => {
    const rows = [
      spaceRecordWithBot('space-a', '22001'),
      spaceRecordWithBot('space-b', '22001'),
      spaceRecordWithBot('space-c', '22002'),
    ]
    const persistence: SandboxTestSpacePersistence = {
      loadAll: async () => rows.map((row) => structuredClone(row)),
      save: async () => {},
      delete: async () => {},
    }
    const { service } = await createService(persistence)
    for (let attempt = 0; attempt < 50 && service.listSpaces().length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // 修复前：space-b 抛出后整个循环中断，space-c 一并丢失
    expect(service.listSpaces().map(({ id }) => id).sort()).toEqual(['space-a', 'space-b', 'space-c'])
  })
})

import { App } from './helpers/app'
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { KoishiDatabaseScenePersistence, type SandboxScenePersistence } from '../src/persistence'
import type { SandboxPersistenceStatus, SandboxSnapshot } from '../src/types'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class TestScenePersistence implements SandboxScenePersistence {
  private scene?: SandboxSnapshot
  private status: SandboxPersistenceStatus = {
    mode: 'database',
    available: true,
    persisted: false,
  }

  getStatus() {
    return { ...this.status }
  }

  async load() {
    return this.scene
      ? { kind: 'loaded' as const, scene: structuredClone(this.scene) }
      : { kind: 'missing' as const }
  }

  async save(scene: SandboxSnapshot) {
    this.scene = structuredClone(scene)
    this.status.persisted = true
  }
}

async function createControl(
  persistence?: SandboxScenePersistence,
  mediaDirectory?: string,
  options: { databaseReadyTimeoutMs?: number } = {},
) {
  const app = new App()
  // 数据库模式下未显式指定 mediaDirectory 时，控制服务会落到 <baseDir>/data/chatluna/onebot-sandbox/media；
  // 不隔离 baseDir 会把媒体写进仓库工作区。
  if (!mediaDirectory) {
    const baseDir = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-persistence-base-'))
    temporaryDirectories.push(baseDir)
    app.baseDir = baseDir
  }
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, { persistence, mediaDirectory, ...options })
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  // Cordis 4 没有 ready 事件，场景恢复是启动后的异步任务；等它结束再交给用例。
  await control.waitForSceneReady()
  return { app, control }
}

describe('沙盒场景持久化', () => {
  it('默认使用服务端内存且重启后恢复默认场景', async () => {
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-memory-media-'))
    temporaryDirectories.push(mediaDirectory)
    const { app: firstApp, control: first } = await createControl(undefined, mediaDirectory)
    first.createUser({ id: '10099', name: '临时用户' })
    await first.sendMediaMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      media: [{ fileName: 'memory.png', mimeType: 'image/png', dataBase64: Buffer.from('memory').toString('base64') }],
    })
    // 默认 5 个头像 + 新建用户默认头像 + 消息图片，各带 .meta.json。
    expect(await readdir(mediaDirectory)).toHaveLength(14)
    expect(first.getSnapshot().participants.some(({ id }) => id === '10099')).toBe(true)
    expect(first.getPersistenceStatus()).toEqual({
      mode: 'memory',
      available: true,
      persisted: false,
    })

    await firstApp.stop()
    const { control: second } = await createControl(undefined, mediaDirectory)
    expect(second.getSnapshot().participants.some(({ id }) => id === '10099')).toBe(false)
    expect(second.getSnapshot().participants.map(({ id }) => id)).toEqual(['10001', '10002', '10003', '20001'])
    // 内存模式重启后会重新生成默认头像，不再清空整个目录。
    expect(await readdir(mediaDirectory)).toHaveLength(10)
  })

  it('Database 服务在 ready 后晚到时仍恢复旧场景并继续持久化', async () => {
    const stored = new TestScenePersistence()
    const { app: seedApp, control: seed } = await createControl(stored)
    const avatar = seed.getSnapshot().participants.find(({ id }) => id === '10001')!.avatar
    seed.createUser({ id: '10099', name: '晚到数据库用户' })
    await seed.sendMessage({
      operatorId: '10099',
      conversationId: 'private:10099:20001',
      content: '数据库晚到前的历史消息',
    })
    await seed.waitForPersistence()
    await seedApp.stop()

    let available = false
    let saveCalls = 0
    const delayedPersistence: SandboxScenePersistence = {
      getStatus: () => stored.getStatus(),
      load: async () => available
        ? stored.load()
        : { kind: 'unavailable', reason: 'missing-service' },
      save: async (scene) => {
        saveCalls += 1
        await stored.save(scene)
      },
    }
    const app = new App()
    // 未指定 mediaDirectory 时媒体目录派生自 baseDir，必须隔离到临时目录。
    const baseDir = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-late-database-base-'))
    temporaryDirectories.push(baseDir)
    app.baseDir = baseDir
    let control: SandboxControlService | undefined
    app.plugin((ctx) => {
      control = new SandboxControlService(ctx, {
        persistence: delayedPersistence,
        databaseReadyTimeoutMs: 500,
      })
      // 模拟数据库插件晚于 control 的恢复任务就绪。
      setTimeout(() => {
        available = true
      }, 30)
    })
    runningApps.push(app)
    await app.start()
    if (!control) throw new Error('沙盒控制服务未注册')
    await control.waitForSceneReady()

    expect(control.getSnapshot().messages).toContainEqual(expect.objectContaining({ content: '数据库晚到前的历史消息' }))
    expect(control.getSnapshot().participants.find(({ id }) => id === '10001')?.avatar).toBe(avatar)
    control.createUser({ id: '10100', name: '恢复后写入用户' })
    await control.waitForPersistence()
    expect(saveCalls).toBeGreaterThan(0)
    expect((await stored.load()).kind).toBe('loaded')
    const restored = await stored.load()
    expect(restored.kind === 'loaded' && restored.scene.participants.some(({ id }) => id === '10100')).toBe(true)
  })

  it('Database 服务永不出现时有界结束且不覆盖旧场景或清理媒体', async () => {
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-database-timeout-media-'))
    temporaryDirectories.push(mediaDirectory)
    await writeFile(join(mediaDirectory, 'preserved'), 'preserved')
    let saveCalls = 0
    const persistence: SandboxScenePersistence = {
      getStatus: () => ({ mode: 'database', available: false, persisted: false }),
      load: async () => ({ kind: 'unavailable', reason: 'missing-service' }),
      save: async () => { saveCalls += 1 },
    }

    const startedAt = Date.now()
    const { control } = await createControl(persistence, mediaDirectory, { databaseReadyTimeoutMs: 50 })
    expect(Date.now() - startedAt).toBeLessThan(1000)
    control.createUser({ id: '10998', name: '超时期间用户' })
    await control.waitForPersistence()

    expect(saveCalls).toBe(0)
    expect(await readdir(mediaDirectory)).toContain('preserved')
  })

  it('Database 模式在控制服务重启后恢复场景', async () => {
    const persistence = new TestScenePersistence()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-database-media-'))
    temporaryDirectories.push(mediaDirectory)
    const { app: firstApp, control: first } = await createControl(persistence, mediaDirectory)
    const persistedDefaultAvatars = first.getSnapshot().participants.map(({ avatar }) => avatar)
    const persistedGroupAvatar = first.getSnapshot().groups[0].avatar
    first.createUser({ id: '10099', name: '持久用户', avatar: `data:image/png;base64,${Buffer.from('persistent-avatar').toString('base64')}` })
    first.createBot({
      id: '20099',
      name: '持久机器人',
      implementation: 'llbot',
      enabled: true,
      disabledCapabilities: ['set_group_kick'],
    })
    first.createGroup({
      id: '30099',
      name: '持久群组',
      members: [
        { participantId: '10099', role: 'owner' },
        { participantId: '20099', role: 'admin' },
      ],
    })
    await first.sendMessage({
      operatorId: '10099',
      conversationId: 'group:30099',
      content: '跨重启消息',
    })
    await first.sendMediaMessage({
      operatorId: '10099',
      conversationId: 'group:30099',
      media: [{ fileName: 'database.png', mimeType: 'image/png', dataBase64: Buffer.from('database').toString('base64') }],
    })
    await first.bot.internal._request('get_status', {})
    expect((await first.getOneBotDebugStore().getRecords()).records).not.toEqual([])
    await first.waitForPersistence()
    expect(first.getBotDeliveries()).not.toEqual([])
    await firstApp.stop()

    const { control: second } = await createControl(persistence, mediaDirectory)
    expect(second.getSnapshot().participants.slice(0, persistedDefaultAvatars.length).map(({ avatar }) => avatar)).toEqual(persistedDefaultAvatars)
    expect(second.getSnapshot().groups.find(({ id }) => id === '30001')?.avatar).toBe(persistedGroupAvatar)
    expect(second.getSnapshot().participants).toContainEqual(expect.objectContaining({ kind: 'user', id: '10099', name: '持久用户', avatar: expect.stringMatching(/^sandbox-media:\/\//) }))
    const restoredAvatar = second.getSnapshot().participants.find(({ id }) => id === '10099')!.avatar!
    expect(second.getMediaContent({ operatorId: '10099', mediaId: restoredAvatar.slice('sandbox-media://'.length) }).dataBase64)
      .toBe(Buffer.from('persistent-avatar').toString('base64'))
    expect(second.getSnapshot().participants).toContainEqual(expect.objectContaining({
      kind: 'bot',
      id: '20099',
      name: '持久机器人',
      implementation: 'llbot',
      enabled: true,
      disabledCapabilities: ['set_group_kick'],
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))
    expect(second.getSnapshot().groups).toContainEqual(expect.objectContaining({
      id: '30099',
      name: '持久群组',
      members: [
        expect.objectContaining({ participantId: '10099', role: 'owner' }),
        expect.objectContaining({ participantId: '20099', role: 'admin' }),
      ],
    }))
    expect(second.getSnapshot().friendships.some(({ participantIds }) => participantIds.includes('10099') && participantIds.includes('20099'))).toBe(true)
    expect(second.getSnapshot().messages).toContainEqual(expect.objectContaining({
      authorId: '10099',
      conversationId: 'group:30099',
      content: '跨重启消息',
    }))
    const mediaMessage = second.getSnapshot().messages.find(({ media }) => media?.length)
    expect(mediaMessage?.media?.[0]).toEqual(expect.objectContaining({
      name: 'database.png',
      reference: expect.stringMatching(/^sandbox-media:\/\//),
    }))
    expect(second.getMediaContent({
      operatorId: '10099',
      mediaId: mediaMessage!.media![0].id,
    }).dataBase64).toBe(Buffer.from('database').toString('base64'))
    expect(second.getRuntimeBot('20099').selfId).toBe('20099')
    expect(second.getBotDeliveries()).toEqual([])
    expect(second.getChatLunaStates()).toEqual([])
    expect((await second.getOneBotDebugStore().getRecords()).records).toEqual([])
    expect(second.getPersistenceStatus()).toEqual({
      mode: 'database',
      available: true,
      persisted: true,
    })
  })

  it('Database 模式重置后持久化新的默认场景', async () => {
    const persistence = new TestScenePersistence()
    const { app: firstApp, control: first } = await createControl(persistence)
    first.createUser({ id: '10099', name: '待重置用户' })
    await first.waitForPersistence()

    first.resetScene()
    await first.waitForPersistence()
    await firstApp.stop()

    const { control: second } = await createControl(persistence)
    expect(second.getSnapshot().participants.map(({ id }) => id)).toEqual(['10001', '10002', '10003', '20001'])
    // 重置不让版本号回退，否则重置前读到的同版本快照能重新通过乐观锁。
    expect(second.getSnapshot().revision).toBe(2)
  })

  it('切换到内存模式时忽略数据库场景，再切回 Database 模式后继续恢复', async () => {
    const persistence = new TestScenePersistence()
    const { app: databaseApp, control: databaseControl } = await createControl(persistence)
    databaseControl.createUser({ id: '10099', name: '数据库用户' })
    await databaseControl.waitForPersistence()
    await databaseApp.stop()

    const { app: memoryApp, control: memoryControl } = await createControl()
    expect(memoryControl.getSnapshot().participants.some(({ id }) => id === '10099')).toBe(false)
    memoryControl.createUser({ id: '10098', name: '内存用户' })
    await memoryApp.stop()

    const { control: restoredControl } = await createControl(persistence)
    expect(restoredControl.getSnapshot().participants.some(({ id }) => id === '10099')).toBe(true)
    expect(restoredControl.getSnapshot().participants.some(({ id }) => id === '10098')).toBe(false)
  })

  it('内置头像文件丢失后按原引用重新物化，不随机换脸', async () => {
    const persistence = new TestScenePersistence()
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-avatar-restore-media-'))
    temporaryDirectories.push(mediaDirectory)
    const { app: firstApp, control: first } = await createControl(persistence, mediaDirectory)
    const reference = first.getSnapshot().participants.find(({ id }) => id === '10001')!.avatar!
    const mediaId = reference.slice('sandbox-media://'.length)
    await first.waitForPersistence()
    await firstApp.stop()
    await unlink(join(mediaDirectory, mediaId))
    await unlink(join(mediaDirectory, `${mediaId}.meta.json`))

    const { control: second } = await createControl(persistence, mediaDirectory)

    expect(second.getSnapshot().participants.find(({ id }) => id === '10001')!.avatar).toBe(reference)
    expect(second.getMediaContent({ operatorId: '10001', mediaId }).mimeType).toBe('image/png')
  })

  it('查询失败时不保存默认场景也不清理共享媒体', async () => {
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-failed-load-media-'))
    temporaryDirectories.push(mediaDirectory)
    await writeFile(join(mediaDirectory, 'preserved'), 'preserved')
    let saveCalls = 0
    const persistence: SandboxScenePersistence = {
      getStatus: () => ({
        mode: 'database',
        available: false,
        persisted: false,
        message: 'Koishi Database 服务未安装或不可用：SQLITE_BUSY',
      }),
      load: async () => ({ kind: 'unavailable', reason: 'query-failed', error: new Error('SQLITE_BUSY') }),
      save: async () => { saveCalls += 1 },
    }

    const { control } = await createControl(persistence, mediaDirectory)
    control.createUser({ id: '10999', name: '故障期间用户' })
    await control.waitForPersistence()

    expect(saveCalls).toBe(0)
    expect(await readdir(mediaDirectory)).toContain('preserved')
    expect(control.getSnapshot().messages).toEqual([])
  })

  it('Database 服务不可用时明确报告状态且不清理可能仍被旧场景引用的媒体', async () => {
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-unavailable-media-'))
    temporaryDirectories.push(mediaDirectory)
    await writeFile(join(mediaDirectory, 'orphan'), 'orphan')

    const persistence = new KoishiDatabaseScenePersistence(() => undefined)
    const { control } = await createControl(persistence, mediaDirectory, { databaseReadyTimeoutMs: 50 })

    expect(control.getPersistenceStatus()).toEqual({
      mode: 'database',
      available: false,
      persisted: false,
      message: 'Koishi Database 服务未安装或不可用',
    })
    // 数据库不可读时无法证明 orphan 没有被旧场景引用，必须保留；默认头像仍各带一个 sidecar。
    expect(await readdir(mediaDirectory)).toHaveLength(11)
  })
})

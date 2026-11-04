import { App } from './helpers/app'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SCENE_MESSAGE_LIMIT,
  DEFAULT_SCENE_MESSAGE_MAX_BYTES,
  SandboxControlService,
  SandboxRuntimeBotRegistry,
  createDefaultScene,
  type SandboxControlServiceOptions,
} from '../src/control-service'
import { SandboxTestSpaceService } from '../src/test-spaces'
import type { SandboxScenePersistence, SandboxSceneLoadResult } from '../src/persistence'
import type { SandboxSnapshot } from '../src/types'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/** 记录每次整块落盘的字节数，用来断言单次写入规模有恒定上界。 */
class RecordingScenePersistence implements SandboxScenePersistence {
  readonly writtenBytes: number[] = []
  private scene?: SandboxSnapshot

  getStatus() {
    return { mode: 'database' as const, available: true, persisted: !!this.scene }
  }

  async load(): Promise<SandboxSceneLoadResult> {
    return this.scene ? { kind: 'loaded', scene: structuredClone(this.scene) } : { kind: 'missing' }
  }

  async save(scene: SandboxSnapshot) {
    this.scene = structuredClone(scene)
    this.writtenBytes.push(Buffer.byteLength(JSON.stringify(scene), 'utf8'))
  }
}

async function createControl(options: SandboxControlServiceOptions = {}) {
  const app = new App()
  app.baseDir = await makeTemporaryDirectory('sandbox-retention-base-')
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, options)
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  const snapshot = control.getSnapshot()
  return {
    app,
    control,
    conversation: snapshot.conversations.find(({ type }) => type === 'direct')!,
    groupConversation: snapshot.conversations.find(({ type }) => type === 'group')!,
    user: snapshot.participants.find(({ kind }) => kind === 'user')!,
  }
}

describe('场景消息保留上限', () => {
  it('默认上限暴露为具名常量，便于配置项与文档共享同一事实', () => {
    expect(DEFAULT_SCENE_MESSAGE_LIMIT).toBeGreaterThan(0)
    expect(DEFAULT_SCENE_MESSAGE_MAX_BYTES).toBeGreaterThan(0)
  })

  it('超过条数上限后淘汰最旧消息，且会话实体保留但不残留已删消息 ID', async () => {
    const { control, conversation, user } = await createControl({ sceneMessageLimit: 3 })
    for (let index = 0; index < 6; index += 1) {
      await control.sendMessage({ operatorId: user.id, conversationId: conversation.id, content: `第 ${index} 条` })
    }

    const snapshot = control.getSnapshot()
    expect(snapshot.messages.map(({ content }) => content)).toEqual(['第 3 条', '第 4 条', '第 5 条'])
    const kept = new Set(snapshot.messages.map(({ id }) => id))
    const target = snapshot.conversations.find(({ id }) => id === conversation.id)!
    expect(target.messageIds).toHaveLength(3)
    expect(target.messageIds.every((id) => kept.has(id))).toBe(true)
    // 会话实体本身不因消息淘汰而消失：默认场景的 3 个私聊 + 1 个群聊全部保留。
    expect(snapshot.conversations).toHaveLength(4)
  })

  it('跨会话淘汰只按全局时间顺序丢弃最旧消息', async () => {
    const { control, conversation, groupConversation, user } = await createControl({ sceneMessageLimit: 2 })
    await control.sendMessage({ operatorId: user.id, conversationId: conversation.id, content: '私聊最旧' })
    await control.sendMessage({ operatorId: user.id, conversationId: groupConversation.id, content: '群聊较新' })
    await control.sendMessage({ operatorId: user.id, conversationId: conversation.id, content: '私聊最新' })

    const snapshot = control.getSnapshot()
    expect(snapshot.messages.map(({ content }) => content)).toEqual(['群聊较新', '私聊最新'])
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)!.messageIds).toHaveLength(1)
    expect(snapshot.conversations.find(({ id }) => id === groupConversation.id)!.messageIds).toHaveLength(1)
  })

  it('超过场景 JSON 字节上限后继续淘汰，直到两个上限都满足', async () => {
    const { control, conversation, user } = await createControl({
      sceneMessageLimit: 1000,
      sceneMessageMaxBytes: 6 * 1024,
    })
    for (let index = 0; index < 40; index += 1) {
      await control.sendMessage({
        operatorId: user.id,
        conversationId: conversation.id,
        content: `${index}:${'填充'.repeat(64)}`,
      })
    }

    const snapshot = control.getSnapshot()
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(6 * 1024)
    expect(snapshot.messages.length).toBeGreaterThan(0)
    expect(snapshot.messages.length).toBeLessThan(40)
    // 保留的必须是最新的一段。
    expect(snapshot.messages.at(-1)!.content.startsWith('39:')).toBe(true)
  })

  it('单次场景写入规模有恒定上界，不随累计消息数增长', async () => {
    const persistence = new RecordingScenePersistence()
    const { control, conversation, user } = await createControl({
      persistence,
      sceneMessageLimit: 10,
      mediaDirectory: await makeTemporaryDirectory('sandbox-retention-media-'),
    })
    await control.waitForSceneReady()
    for (let index = 0; index < 80; index += 1) {
      await control.sendMessage({
        operatorId: user.id,
        conversationId: conversation.id,
        content: `探针消息 ${index}:${'x'.repeat(200)}`,
      })
    }
    await control.waitForPersistence()

    const writes = persistence.writtenBytes
    expect(writes.length).toBeGreaterThan(40)
    // 前 10 条填满窗口，之后每次写入都应稳定在同一量级；对比首个满窗口写入不得增长超过 1.5 倍。
    const steady = writes.slice(20)
    const baseline = writes[15]!
    expect(Math.max(...steady)).toBeLessThanOrEqual(baseline * 1.5)
  })

  it('构造时传入的超限初始场景先收敛，重置后也不会恢复出超限场景', async () => {
    const persistence = new RecordingScenePersistence()
    const initialScene = createDefaultScene()
    const conversation = initialScene.conversations.find(({ type }) => type === 'direct')!
    const author = initialScene.participants.find(({ kind }) => kind === 'user')!
    // 模拟从更宽上限时期的快照恢复：AI 测试空间恢复就是把持久化场景当作初始场景传入。
    for (let index = 0; index < 8; index += 1) {
      initialScene.messages.push({
        id: `seed-${index}`,
        authorId: author.id,
        conversationId: conversation.id,
        content: `预置 ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      })
      conversation.messageIds.push(`seed-${index}`)
    }

    const { control } = await createControl({ initialScene, sceneMessageLimit: 3, persistence })
    await control.waitForSceneReady()
    expect(control.getSnapshot().messages.map(({ content }) => content)).toEqual(['预置 5', '预置 6', '预置 7'])

    control.resetScene()
    await control.waitForPersistence()
    const snapshot = control.getSnapshot()
    expect(snapshot.messages.map(({ content }) => content)).toEqual(['预置 5', '预置 6', '预置 7'])
    expect(snapshot.conversations.find(({ id }) => id === conversation.id)!.messageIds).toHaveLength(3)
    // 落盘的场景同样不含被淘汰的消息 ID。
    const stored = await persistence.load()
    expect(stored.kind === 'loaded' && stored.scene.messages).toHaveLength(3)
    expect(JSON.stringify(stored)).not.toContain('seed-0')
  })

  it('淘汰级联清理孤儿合并转发，并保留仍被存活消息引用的转发', async () => {
    const { control, conversation, user } = await createControl({ sceneMessageLimit: 2 })
    await control.sendForwardMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      nodes: [{ type: 'custom', userId: user.id, nickname: '旧节点', content: '将被淘汰' }],
    })
    const survivingForward = await control.sendForwardMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      nodes: [{ type: 'custom', userId: user.id, nickname: '新节点', content: '仍被引用' }],
    })
    await control.sendMessage({ operatorId: user.id, conversationId: conversation.id, content: '最新消息' })

    const snapshot = control.getSnapshot()
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.forwards?.map(({ id }) => id)).toEqual([survivingForward.forwardId])
  })

  it('淘汰后回收不再被引用的媒体，仍被存活消息引用的媒体不回收', async () => {
    const mediaDirectory = await makeTemporaryDirectory('sandbox-retention-media-')
    const { control, conversation, user } = await createControl({ sceneMessageLimit: 1, mediaDirectory })
    const doomed = await control.sendMediaMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      media: [{ fileName: 'doomed.png', mimeType: 'image/png', dataBase64: Buffer.from('doomed-media').toString('base64') }],
    })
    const doomedMediaId = control.getSnapshot().messages
      .find(({ id }) => id === doomed.messageId)!.media![0]!.id
    expect(existsSync(resolve(mediaDirectory, doomedMediaId))).toBe(true)

    const survivor = await control.sendMediaMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      media: [{ fileName: 'survivor.png', mimeType: 'image/png', dataBase64: Buffer.from('survivor-media').toString('base64') }],
    })
    const survivorMediaId = control.getSnapshot().messages
      .find(({ id }) => id === survivor.messageId)!.media![0]!.id

    expect(control.getSnapshot().messages).toHaveLength(1)
    expect(existsSync(resolve(mediaDirectory, doomedMediaId))).toBe(false)
    expect(existsSync(resolve(mediaDirectory, survivorMediaId))).toBe(true)
  })

  it('主环境与每个 AI 测试空间各自持有独立配额', async () => {
    const app = new App()
    app.baseDir = await makeTemporaryDirectory('sandbox-retention-spaces-')
    const runtimeBots = new SandboxRuntimeBotRegistry()
    let main: SandboxControlService | undefined
    let spaces: SandboxTestSpaceService | undefined
    app.plugin((ctx) => {
      main = new SandboxControlService(ctx, { runtimeBots, sceneMessageLimit: 2 })
      spaces = new SandboxTestSpaceService(ctx, runtimeBots, undefined, undefined, undefined, undefined, undefined, {
        sceneMessageLimit: 2,
      })
    })
    runningApps.push(app)
    await app.start()
    if (!main || !spaces) throw new Error('沙盒服务未注册')

    const snapshot = main.getSnapshot()
    const conversation = snapshot.conversations.find(({ type }) => type === 'direct')!
    const user = snapshot.participants.find(({ kind }) => kind === 'user')!
    for (let index = 0; index < 4; index += 1) {
      await main.sendMessage({ operatorId: user.id, conversationId: conversation.id, content: `主环境 ${index}` })
    }

    const space = spaces.createSpace({ name: '配额空间' })
    space.control.createUser({ id: '10501', name: '空间用户' })
    space.control.createBot({ id: '20501', name: '空间机器人', implementation: 'napcat', enabled: true })
    const spaceConversation = space.control.getSnapshot().conversations.find(({ type }) => type === 'direct')!
    await space.control.sendMessage({ operatorId: '10501', conversationId: spaceConversation.id, content: '空间唯一消息' })

    expect(main.getSnapshot().messages).toHaveLength(2)
    // 主环境已经填满自己的配额，测试空间仍从零开始计数。
    expect(space.control.getSnapshot().messages).toHaveLength(1)
  })
})

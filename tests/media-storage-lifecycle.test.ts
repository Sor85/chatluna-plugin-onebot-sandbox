import { App } from './helpers/app'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { MAX_PINNED_MEDIA, SandboxMediaStorage, toMediaMetadata } from '../src/media-storage'
import { SandboxTestSpaceService } from '../src/test-spaces'
import type { SandboxTestSpacePersistence, SandboxTestSpacePersistenceRecord } from '../src/persistence'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createControl(options: { mediaDirectory?: string, baseDir?: string } = {}) {
  const app = new App()
  if (options.baseDir) app.baseDir = options.baseDir
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, options.mediaDirectory ? { mediaDirectory: options.mediaDirectory } : {})
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('control 未创建')
  const snapshot = control.getSnapshot()
  return {
    app,
    control,
    conversation: snapshot.conversations.find(({ type }) => type === 'direct')!,
    user: snapshot.participants.find(({ kind }) => kind === 'user')!,
  }
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe('在途上传的媒体不会被场景变更回收', () => {
  it('上传后先发生其他场景变更，再引用该媒体仍能发送成功', async () => {
    const mediaDirectory = await makeTemporaryDirectory('sandbox-pin-')
    const { control, conversation, user } = await createControl({ mediaDirectory })
    const media = control.storeMedia({
      fileName: 'probe.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('probe-payload-unique').toString('base64'),
    })

    // upload_media 与 send_message 之间插入一次无关的场景变更
    await control.sendMessage({ operatorId: user.id, conversationId: conversation.id, content: 'hello' })
    expect(readdirSync(mediaDirectory)).toContain(media.id)

    await expect(control.sendStoredMediaMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      content: '',
      media: [media],
    })).resolves.toMatchObject({ messageId: expect.any(String) })
  })

  it('媒体进入场景后解除钉住，删除引用后可以正常回收', async () => {
    const mediaDirectory = await makeTemporaryDirectory('sandbox-unpin-')
    const { control, conversation, user } = await createControl({ mediaDirectory })
    const media = control.storeMedia({
      fileName: 'once.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('reclaimable-payload').toString('base64'),
    })
    await control.sendStoredMediaMessage({ operatorId: user.id, conversationId: conversation.id, content: '', media: [media] })
    expect(control.getMediaDirectory()).toBe(mediaDirectory)

    control.clearConversationMessages({ operatorId: user.id, conversationId: conversation.id })
    expect(readdirSync(mediaDirectory)).not.toContain(media.id)
  })

  it('钉住数量超过上限后最旧的在途上传重新变成可回收孤儿', async () => {
    const directory = await makeTemporaryDirectory('sandbox-pin-cap-')
    const storage = new SandboxMediaStorage(directory, 2)
    const ids = ['a', 'b', 'c'].map((seed) => storage.save({
      fileName: `${seed}.txt`,
      mimeType: 'text/plain',
      dataBase64: Buffer.from(`payload-${seed}`).toString('base64'),
    }))
    for (const media of ids) storage.pin(media.id)
    expect(ids.map(({ id }) => storage.isPinned(id))).toEqual([false, true, true])

    storage.reclaimUnreferenced(new Set())
    expect(readdirSync(directory)).not.toContain(ids[0]!.id)
    expect(readdirSync(directory)).toContain(ids[2]!.id)
  })

  it('默认钉住上限是一个明确的有限值', () => {
    expect(MAX_PINNED_MEDIA).toBe(256)
  })
})

describe('场景快照只保存媒体元数据', () => {
  it('调用方在媒体对象上附加的 dataBase64 不会写入消息', async () => {
    const mediaDirectory = await makeTemporaryDirectory('sandbox-meta-')
    const { control, conversation, user } = await createControl({ mediaDirectory })
    const dataBase64 = Buffer.from('X'.repeat(4096)).toString('base64')
    const media = control.storeMedia({ fileName: 'p.png', mimeType: 'image/png', dataBase64 })

    await control.sendStoredMediaMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      content: '',
      media: [{ ...media, dataBase64 } as never],
    })

    const stored = control.getSnapshot().messages.at(-1)!.media![0]!
    expect(Object.keys(stored).sort()).toEqual(['id', 'mimeType', 'name', 'reference', 'size', 'type'])
    expect(JSON.stringify(control.getSnapshot())).not.toContain(dataBase64)
  })

  it('合并转发节点同样只保存媒体元数据', async () => {
    const mediaDirectory = await makeTemporaryDirectory('sandbox-meta-forward-')
    const { control, conversation, user } = await createControl({ mediaDirectory })
    const dataBase64 = Buffer.from('Y'.repeat(4096)).toString('base64')
    const media = control.storeMedia({ fileName: 'f.png', mimeType: 'image/png', dataBase64 })

    await control.sendForwardMessage({
      operatorId: user.id,
      conversationId: conversation.id,
      nodes: [{
        type: 'custom',
        userId: user.id,
        nickname: '测试',
        content: '',
        media: [{ ...media, dataBase64 } as never],
      }],
    })

    expect(JSON.stringify(control.getSnapshot())).not.toContain(dataBase64)
  })

  it('toMediaMetadata 剥掉契约外字段', () => {
    const result = toMediaMetadata({
      id: 'a'.repeat(32),
      type: 'image',
      name: 'a.png',
      mimeType: 'image/png',
      size: 1,
      reference: `sandbox-media://${'a'.repeat(32)}`,
      dataBase64: 'zzz',
    } as never)
    expect(Object.keys(result).sort()).toEqual(['id', 'mimeType', 'name', 'reference', 'size', 'type'])
  })
})

describe('实例级媒体目录随实例回收', () => {
  it('内存模式的实例目录在 dispose 后被删除', async () => {
    const baseDir = await makeTemporaryDirectory('sandbox-ephemeral-')
    const ephemeralRoot = resolve(baseDir, 'data/chatluna/onebot-sandbox/ephemeral-media')
    const { control } = await createControl({ baseDir })

    const directory = control.getMediaDirectory()
    expect(directory.startsWith(ephemeralRoot)).toBe(true)
    expect(existsSync(directory)).toBe(true)

    await control.dispose()
    expect(existsSync(directory)).toBe(false)
    expect(readdirSync(ephemeralRoot)).toEqual([])
  })

  it('调用方显式传入的目录不会被 dispose 删除', async () => {
    const mediaDirectory = await makeTemporaryDirectory('sandbox-owned-')
    const { control } = await createControl({ mediaDirectory })
    await control.dispose()
    expect(existsSync(mediaDirectory)).toBe(true)
  })
})

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { h } from '@satorijs/core'
import { App } from './helpers/app'
import { SandboxControlService, type SandboxControlServiceOptions } from '../src/control-service'

const apps: App[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function setup(options: SandboxControlServiceOptions = {}) {
  const app = new App()
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-satori-media-'))
  apps.push(app)
  directories.push(directory)
  const control = new SandboxControlService(app, { ...options, mediaDirectory: directory })
  await app.start()
  return { app, control, directory }
}

function pngBytes(source: string | undefined) {
  expect(source).toMatch(/^data:image\/png;base64,/)
  const bytes = Buffer.from(source?.split(',')[1] ?? '', 'base64')
  expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  return bytes
}

describe('Satori 图片输出边界', () => {
  it('默认头像直接使用预生成的 512px PNG，读取不修改场景', async () => {
    const { control } = await setup()
    const snapshot = control.getSnapshot()
    const user = await control.bot.getUser('10001')
    const login = await control.bot.getLogin()
    const member = await control.bot.getGuildMember('30001', '10001')
    expect(pngBytes(user.avatar).readUInt32BE(16)).toBe(512)
    expect(pngBytes(login.user?.avatar).readUInt32BE(16)).toBe(512)
    expect(member.avatar).toBe(user.avatar)
    expect(control.bot.user?.avatar).toBe(login.user?.avatar)
    expect(snapshot.participants.every(({ avatar }) => avatar?.startsWith('sandbox-media://'))).toBe(true)
    expect(control.getSnapshot()).toEqual(snapshot)
  })

  it('自定义头像保持原始字节，更换机器人头像后 Satori user 同步更新', async () => {
    const { control } = await setup()
    const first = `data:image/png;base64,${Buffer.from('avatar-one').toString('base64')}`
    const second = `data:image/png;base64,${Buffer.from('avatar-two').toString('base64')}`
    control.createUser({ id: '10098', name: '测试用户', avatar: first })
    expect((await control.bot.getUser('10098')).avatar).toBe(first)
    await control.bot.internal._request('set_qq_avatar', { file: second })
    expect(control.bot.user?.avatar).toBe(second)
    expect((await control.bot.getLogin()).user?.avatar).toBe(second)
    expect(control.getSnapshot().participants.find(({ id }) => id === '20001')?.avatar).toMatch(/^sandbox-media:\/\//)
  })

  it('引用图片保留 img 元素和正文，而不是只有会话预览文字', async () => {
    const { app, control } = await setup()
    const dataBase64 = Buffer.from('quoted-image').toString('base64')
    const quoted: h[] = []
    app.middleware(async (session, next) => {
      if (session.quote) quoted.push(...session.quote.elements)
      return next()
    })
    const first = await control.sendMediaMessage({ operatorId: '10001', conversationId: 'group:30001', content: '图片说明', media: [{ fileName: 'image.png', mimeType: 'image/png', dataBase64 }] })
    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '引用图片', replyToMessageId: first.messageId })
    expect(quoted.some((element) => element.type === 'img' && element.attrs.src === `data:image/png;base64,${dataBase64}`)).toBe(true)
    expect(quoted.some((element) => element.type === 'text' && element.attrs.content === '图片说明')).toBe(true)
  })

  it.each(['text', 'upload', 'stored'])('%s 发送触发条数回收时，仍投递完整的引用图片', async (kind) => {
    const { app, control, directory } = await setup({ sceneMessageLimit: 1 })
    const dataBase64 = Buffer.from('retained-quote').toString('base64')
    const quoted: h[] = []
    app.middleware(async (session, next) => {
      if (session.quote) quoted.push(...session.quote.elements)
      return next()
    })
    const first = await control.sendMediaMessage({ operatorId: '10001', conversationId: 'group:30001', content: '图片说明', media: [{ fileName: 'quote.png', mimeType: 'image/png', dataBase64 }] })
    const media = control.getSnapshot().messages[0].media![0]
    const input = { operatorId: '10001', conversationId: 'group:30001', content: '引用图片', replyToMessageId: first.messageId }
    const attachment = { fileName: 'reply.png', mimeType: 'image/png', dataBase64: Buffer.from('reply-image').toString('base64') }
    const result = kind === 'text'
      ? await control.sendMessage(input)
      : kind === 'upload'
        ? await control.sendMediaMessage({ ...input, media: [attachment] })
        : await control.sendStoredMediaMessage({ ...input, media: [control.storeMedia(attachment)] })

    expect(control.getSnapshot().messages.map(({ id }) => id)).toEqual([result.messageId])
    expect(existsSync(join(directory, media.id))).toBe(false)
    expect(quoted.some((element) => element.type === 'img' && element.attrs.src === `data:image/png;base64,${dataBase64}`)).toBe(true)
    expect(quoted.some((element) => element.type === 'text' && element.attrs.content === '图片说明')).toBe(true)
  })

  it('体积回收淘汰引用目标后，仍能投递已经读取的图片', async () => {
    const { app, control } = await setup({ sceneMessageMaxBytes: 64 * 1024 })
    const dataBase64 = Buffer.from('byte-limit-quote').toString('base64')
    const quoted: h[] = []
    app.middleware(async (session, next) => {
      if (session.quote) quoted.push(...session.quote.elements)
      return next()
    })
    const first = await control.sendMediaMessage({ operatorId: '10001', conversationId: 'group:30001', content: 'a'.repeat(40 * 1024), media: [{ fileName: 'quote.png', mimeType: 'image/png', dataBase64 }] })
    const result = await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: 'b'.repeat(40 * 1024), replyToMessageId: first.messageId })
    expect(control.getSnapshot().messages.map(({ id }) => id)).toEqual([result.messageId])
    expect(quoted.some((element) => element.type === 'img' && element.attrs.src === `data:image/png;base64,${dataBase64}`)).toBe(true)
  })

  it('引用图片确实缺失时在落库前拒绝，不留下未投递的消息', async () => {
    const { control, directory } = await setup()
    const first = await control.sendMediaMessage({ operatorId: '10001', conversationId: 'group:30001', content: '图片说明', media: [{ fileName: 'quote.png', mimeType: 'image/png', dataBase64: Buffer.from('missing-quote').toString('base64') }] })
    const snapshot = control.getSnapshot()
    await rm(join(directory, snapshot.messages[0].media![0].id))
    await expect(control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '引用图片', replyToMessageId: first.messageId })).rejects.toThrow('媒体文件不存在')
    expect(control.getSnapshot()).toEqual(snapshot)
  })
})

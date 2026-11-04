import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'

const apps: App[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createControl() {
  const app = new App()
  const directory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-avatar-import-'))
  directories.push(directory)
  apps.push(app)
  const control = new SandboxControlService(app, { mediaDirectory: directory })
  await app.start()
  return control
}

function mediaId(reference: string) {
  const id = reference.match(/^sandbox-media:\/\/([a-f0-9]{32})$/)?.[1]
  if (!id) throw new Error(`不是受管媒体引用：${reference}`)
  return id
}

describe('自定义头像受管媒体导入', () => {
  it('把 Data URL、base64 和上传媒体引用统一写成受管图片', async () => {
    const control = await createControl()
    const dataUrl = `data:image/png;base64,${Buffer.from('user-avatar').toString('base64')}`
    control.createUser({ id: '10098', name: 'Data 用户', avatar: dataUrl })
    control.createBot({ id: '20098', name: 'Base64 机器人', implementation: 'llbot', enabled: true, avatar: `base64://${Buffer.from('bot-avatar').toString('base64')}` })
    const uploaded = control.storeMedia({ fileName: 'group.png', mimeType: 'image/png', dataBase64: Buffer.from('group-avatar').toString('base64') })
    control.createGroup({ id: '30098', name: '头像群', avatar: uploaded.reference, members: [{ participantId: '10098', role: 'owner' }] })

    const snapshot = control.getSnapshot()
    const references = [
      snapshot.participants.find(({ id }) => id === '10098')!.avatar!,
      snapshot.participants.find(({ id }) => id === '20098')!.avatar!,
      snapshot.groups.find(({ id }) => id === '30098')!.avatar!,
    ]
    expect(references.every((value) => /^sandbox-media:\/\//.test(value))).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('data:image')
    expect(JSON.stringify(snapshot)).not.toContain('base64://')
    expect(control.getMediaContent({ operatorId: '10098', mediaId: mediaId(references[0]) }).dataBase64)
      .toBe(Buffer.from('user-avatar').toString('base64'))
  })

  it('让 set_qq_avatar 下载外部 URL，失败时保留原头像', async () => {
    const control = await createControl()
    const server = createServer((request, response) => {
      if (request.url === '/missing') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.from('remote-avatar'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器未启动')
    try {
      await control.bot.internal._request('set_qq_avatar', { file: `http://127.0.0.1:${address.port}/avatar.png` })
      const avatar = control.getSnapshot().participants.find(({ id }) => id === '20001')!.avatar!
      expect(avatar).toMatch(/^sandbox-media:\/\//)
      expect(control.getMediaContent({ operatorId: '10001', mediaId: mediaId(avatar) }).dataBase64)
        .toBe(Buffer.from('remote-avatar').toString('base64'))

      await expect(control.bot.internal._request('set_qq_avatar', { file: `http://127.0.0.1:${address.port}/missing` }))
        .rejects.toThrow('头像下载失败')
      expect(control.getSnapshot().participants.find(({ id }) => id === '20001')!.avatar).toBe(avatar)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('头像导入失败时不提前修改实体字段', async () => {
    const control = await createControl()
    const originalAvatar = `data:image/png;base64,${Buffer.from('original-avatar').toString('base64')}`
    control.createUser({ id: '10098', name: '原昵称', avatar: originalAvatar })

    expect(() => control.updateUser({ id: '10098', name: '不应保存', avatar: 'https://invalid.example/avatar.png' }))
      .toThrow('外部头像 URL 需要先通过 importAvatar 导入受管媒体')
    expect(control.getSnapshot().participants).toContainEqual(expect.objectContaining({
      id: '10098',
      name: '原昵称',
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))
  })
})

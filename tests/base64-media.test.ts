import { h } from '@satorijs/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './helpers/app'
import { SandboxControlService } from '../src/control-service'
import { SandboxMediaStorage } from '../src/media-storage'
import { DEFAULT_MEDIA_MAX_SIZE } from '../src/media-limits'
import { redactTestCallValue } from '../src/mcp/call-records'
import { SandboxOneBotDebugStore } from '../src/onebot-debug'

const apps: App[] = []
const directories: string[] = []
const attachmentSize = 5 * 1024 * 1024

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'sandbox-base64-'))
  directories.push(path)
  return path
}

describe('大附件 Base64 校验', () => {
  it.each([attachmentSize, DEFAULT_MEDIA_MAX_SIZE - 2, DEFAULT_MEDIA_MAX_SIZE - 1, DEFAULT_MEDIA_MAX_SIZE])('%i 字节媒体可以保存和读回，覆盖三种尾部填充', async (size) => {
    const storage = new SandboxMediaStorage(await directory())
    const content = Buffer.alloc(size, 0x41)
    const media = storage.save({ fileName: 'fixture.zip', mimeType: 'application/zip', dataBase64: content.toString('base64') })
    expect(media.size).toBe(size)
    expect(Buffer.from(storage.read(media).dataBase64, 'base64').equals(content)).toBe(true)
  })

  it('仍然拒绝超过 10 MiB 的媒体', async () => {
    const storage = new SandboxMediaStorage(await directory())
    expect(() => storage.save({ fileName: 'fixture.zip', mimeType: 'application/zip', dataBase64: Buffer.alloc(DEFAULT_MEDIA_MAX_SIZE + 1).toString('base64') }))
      .toThrow('媒体大小不能超过 10 MiB')
  })

  it.each(['', 'A', 'AAA', 'AAAAA', 'A===', '====', 'AA=A', '=AAA', 'AA-_', 'AA A', 'AA\nA', 'AA A', 'AA!A', 'AA中A'])('拒绝非法内容 %j', async (dataBase64) => {
    const storage = new SandboxMediaStorage(await directory())
    expect(() => storage.save({ fileName: 'fixture.txt', mimeType: 'text/plain', dataBase64 }))
      .toThrow('媒体内容不是有效的 Base64')
  })

  it.each(['AA==', 'AAA=', 'AAAA', '/+8=', ' /+8=\n'])('接受合法内容 %j', async (dataBase64) => {
    const storage = new SandboxMediaStorage(await directory())
    expect(storage.save({ fileName: 'fixture.txt', mimeType: 'text/plain', dataBase64 }).size).toBeGreaterThan(0)
  })

  it('大字符串末尾的非法字符不会引发栈溢出', async () => {
    const storage = new SandboxMediaStorage(await directory())
    const body = Buffer.alloc(attachmentSize).toString('base64')
    expect(() => storage.save({ fileName: 'fixture.zip', mimeType: 'application/zip', dataBase64: `${body.slice(0, -1)}!` }))
      .toThrow('媒体内容不是有效的 Base64')
  })
})

describe('大附件调试投影', () => {
  it.each(['', 'base64://', 'data:application/zip;base64,'])('两种调试记录均能折叠 %s 大附件', (prefix) => {
    const body = Buffer.alloc(attachmentSize).toString('base64')
    const file = `${prefix}${body}`
    const expected = { kind: 'large-value', byteLength: attachmentSize, charCount: body.length }
    const store = new SandboxOneBotDebugStore()
    const record = store.append({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'upload_group_file', action: 'upload_group_file',
      status: 'success', durationMs: 1, payload: { file },
    })
    expect(record.payload).toMatchObject({ file: expected })
    expect(redactTestCallValue({ file })).toMatchObject({ file: expected })
  })
})

describe('沙盒大文件投递', () => {
  it.each(['30001', 'private:10001'])('通过真实 SandboxBot 发送到 %s', async (channelId) => {
    const app = new App()
    apps.push(app)
    const control = new SandboxControlService(app, { mediaDirectory: await directory() })
    await app.start()
    const content = Buffer.alloc(attachmentSize, 0x41)
    const ids = await control.bot.sendMessage(channelId, h.file(content, 'application/zip', { title: 'fixture.zip' }))
    expect(ids).toHaveLength(1)
    const media = control.getSnapshot().messages.at(-1)?.media?.[0]
    expect(media).toMatchObject({ name: 'fixture.zip', mimeType: 'application/zip', size: attachmentSize })
    const stored = control.getMediaContent({ operatorId: '20001', mediaId: media!.id })
    expect(Buffer.from(stored.dataBase64, 'base64').equals(content)).toBe(true)
  })
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxMcpService } from '../src/mcp/service'

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
})

function createService(uploadedMediaLimit?: number) {
  const app = new App()
  apps.push(app)
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-upload-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const service = new SandboxMcpService(app, control, { dataDirectory: directory, uploadedMediaLimit })
  const credential = service.createCredential('测试凭证', ['read', 'interact'])
  // 关闭机器人运行时：本组用例只关心上传缓存，不需要等待真实投递。
  control.updateBot({ id: '20001', name: 'Koishi', implementation: 'napcat', enabled: false })
  return { app, control, service, credential }
}

async function upload(service: SandboxMcpService, token: string, seed: string) {
  return await service.callTool(token, 'upload_media', {
    fileName: `${seed}.txt`,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(`payload-${seed}`).toString('base64'),
  }) as { mediaId: string, media: Record<string, unknown> }
}

describe('MCP 上传缓存不保留媒体正文', () => {
  it('upload_media 返回的媒体只含元数据字段', async () => {
    const { service, credential } = createService()
    const result = await upload(service, credential.token, 'meta')
    expect(Object.keys(result.media).sort()).toEqual(['id', 'mimeType', 'name', 'reference', 'size', 'type'])
  })

  it('通过上传缓存发送的消息不会把正文写进场景', async () => {
    const { service, control, credential } = createService()
    const dataBase64 = Buffer.from('Z'.repeat(4096)).toString('base64')
    const result = await service.callTool(credential.token, 'upload_media', {
      fileName: 'big.txt',
      mimeType: 'text/plain',
      dataBase64,
    }) as { mediaId: string }

    await service.callTool(credential.token, 'send_message', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: 'MCP 消息',
      mediaIds: [result.mediaId],
      idempotencyKey: 'send-1',
    })

    expect(JSON.stringify(control.getSnapshot())).not.toContain(dataBase64)
  })

  it('上传缓存超过上限后最旧条目被淘汰', async () => {
    const { service, credential } = createService(2)
    const first = await upload(service, credential.token, 'a')
    await upload(service, credential.token, 'b')
    await upload(service, credential.token, 'c')

    await expect(service.callTool(credential.token, 'send_message', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '引用已淘汰媒体',
      mediaIds: [first.mediaId],
      idempotencyKey: 'send-2',
    })).rejects.toMatchObject({ code: 'media_not_found' })
  })

  it('上限内的上传仍然可以正常引用', async () => {
    const { service, credential } = createService(2)
    const kept = await upload(service, credential.token, 'keep')
    await upload(service, credential.token, 'other')

    await expect(service.callTool(credential.token, 'send_message', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '引用保留媒体',
      mediaIds: [kept.mediaId],
      idempotencyKey: 'send-3',
    })).resolves.toMatchObject({ messageId: expect.any(String) })
  })
})

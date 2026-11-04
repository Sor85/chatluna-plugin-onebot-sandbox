import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { redactTestCallValue } from '../src/mcp/call-records'
import { SandboxMcpService } from '../src/mcp/service'
import { SandboxTestSpaceService } from '../src/test-spaces'

const apps: App[] = []

function createService(scopes: Array<'read' | 'interact' | 'manage' | 'debug'> = ['read'], enableTestSpaces = false) {
  const app = new App()
  apps.push(app)
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-test-calls-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const service = new SandboxMcpService(app, control, {
    dataDirectory: directory,
    testSpaces: enableTestSpaces ? testSpaces : undefined,
  })
  const credential = service.createCredential('测试凭证', scopes)
  return { app, control, service, credential, testSpaces }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
})

describe('测试调用值脱敏', () => {
  it('保留消息正文，只脱敏敏感字段', () => {
    expect(redactTestCallValue({
      content: '你好世界',
      message: 'hello',
      text: 'short',
      raw_message: 'raw',
      authorization: 'secret-token',
      confirmationToken: 'confirm-secret',
    })).toEqual({
      content: '你好世界',
      message: 'hello',
      text: 'short',
      raw_message: 'raw',
      authorization: '[已脱敏]',
      confirmationToken: '[已脱敏]',
    })
  })
})

describe('MCP 测试调用记录', () => {
  it('记录脱敏参数和结果，并区分列表摘要与详情', async () => {
    const { control, service, credential } = createService(['read', 'interact', 'debug'])
    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: false })
    const debugCredential = service.createCredential('调试凭证', ['debug'])
    const mediaBase64 = Buffer.alloc(12 * 1024, 1).toString('base64')
    await service.callTool(credential.token, 'send_message', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '秘密正文',
      authorization: credential.token,
      confirmationToken: 'confirm-secret',
      dataBase64: mediaBase64,
      idempotencyKey: 'message-redact-1',
      testRunId: 'run-redact',
    }, { sourceIp: '10.0.0.8' })

    const page = await service.callTool(debugCredential.token, 'list_test_call_records', {}) as {
      items: Array<Record<string, unknown>>
    }
    const sendRecord = page.items.find((item) => item.tool === 'send_message')
    expect(sendRecord).toMatchObject({
      credentialName: '测试凭证',
      sourceIp: '10.0.0.8',
      tool: 'send_message',
      testRunId: 'run-redact',
      status: 'success',
    })
    expect(sendRecord).not.toHaveProperty('arguments')
    expect(sendRecord).not.toHaveProperty('result')
    expect(JSON.stringify(page.items)).not.toContain(credential.token)

    const detail = await service.callTool(debugCredential.token, 'get_test_call_record', {
      recordId: sendRecord!.id,
    }) as Record<string, unknown>
    expect(detail.arguments).toMatchObject({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '秘密正文',
      authorization: '[已脱敏]',
      confirmationToken: '[已脱敏]',
    })
    expect(detail.result).toEqual(expect.objectContaining({
      messageId: expect.any(String),
      revision: expect.any(Number),
    }))
    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain(credential.token)
    expect(serialized).not.toContain('confirm-secret')
    expect(serialized).not.toContain(mediaBase64)
  })

  it('鉴权成功后的权限和限流失败也写入记录，无效凭证不写入', async () => {
    const app = new App()
    apps.push(app)
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-test-calls-limit-'))
    const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media') })
    const service = new SandboxMcpService(app, control, { dataDirectory: directory, readPerMinute: 1 })
    const credential = service.createCredential('限流凭证', ['read'])
    const debugCredential = service.createCredential('调试凭证', ['debug'])

    await service.callTool(credential.token, 'get_server_info', {}, { sourceIp: '127.0.0.1' })
    await expect(service.callTool(credential.token, 'get_scene_snapshot', {})).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(service.callTool(credential.token, 'send_message', {})).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.callTool('invalid-token', 'get_server_info', {})).rejects.toMatchObject({ code: 'unauthorized' })

    const page = service.listCallRecords()
    expect(page.records.map(({ tool, status, errorCode }) => ({ tool, status, errorCode }))).toEqual([
      { tool: 'send_message', status: 'error', errorCode: 'permission_denied' },
      { tool: 'get_scene_snapshot', status: 'error', errorCode: 'rate_limited' },
      { tool: 'get_server_info', status: 'success', errorCode: undefined },
    ])
    expect(page.records).toHaveLength(3)

    const denied = service.getCallRecord(page.records[0]!.id)
    expect(denied.error).toMatchObject({
      code: 'permission_denied',
      message: '凭证缺少 interact 权限',
      retryable: false,
    })
    expect(JSON.stringify(page.records)).not.toContain(credential.token)
  })

  it('从调用参数或创建结果提取空间，并允许按空间筛选和清理', async () => {
    const { service, credential } = createService(['read', 'manage', 'debug'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '调用记录空间',
      idempotencyKey: 'space-record-1',
    }) as { spaceId: string }
    await service.callTool(credential.token, 'get_scene_snapshot', { spaceId: created.spaceId })
    await service.callTool(credential.token, 'get_server_info', {})

    const all = service.listCallRecords()
    expect(all.records.find(({ tool }) => tool === 'create_test_space')).toMatchObject({
      tool: 'create_test_space',
      spaceId: created.spaceId,
    })
    expect(all.records.find(({ tool }) => tool === 'get_scene_snapshot')).toMatchObject({
      tool: 'get_scene_snapshot',
      spaceId: created.spaceId,
    })
    expect(all.records.find(({ tool }) => tool === 'get_server_info')).not.toHaveProperty('spaceId')

    const filtered = service.listCallRecords({ spaceId: created.spaceId, tool: 'get_scene_snapshot' })
    expect(filtered.records).toEqual([
      expect.objectContaining({ tool: 'get_scene_snapshot', spaceId: created.spaceId }),
    ])
    const listed = await service.callTool(credential.token, 'list_test_call_records', {}) as { items: Array<Record<string, unknown>> }
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'create_test_space', spaceId: created.spaceId }),
      expect.objectContaining({ tool: 'get_server_info' }),
    ]))
    expect(service.clearCallRecords()).toEqual({ cleared: all.records.length + 1 })
    expect(service.listCallRecords().records).toEqual([])
  })

  it('支持按时间正序或倒序返回调用记录', async () => {
    const { service, credential } = createService(['read', 'debug'])
    await service.callTool(credential.token, 'get_server_info', {})
    await service.callTool(credential.token, 'get_scene_snapshot', {})

    expect(service.listCallRecords({ order: 'asc' }).records.map(({ tool }) => tool)).toEqual([
      'get_server_info',
      'get_scene_snapshot',
    ])
    expect(service.listCallRecords({ order: 'desc' }).records.map(({ tool }) => tool)).toEqual([
      'get_scene_snapshot',
      'get_server_info',
    ])
    const listed = await service.callTool(credential.token, 'list_test_call_records', { order: 'asc' }) as {
      items: Array<{ tool: string }>
    }
    expect(listed.items.map(({ tool }) => tool)).toEqual([
      'get_server_info',
      'get_scene_snapshot',
    ])
  })
})

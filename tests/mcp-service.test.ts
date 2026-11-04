import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { h } from '@satorijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { SandboxMcpService } from '../src/mcp/service'
import {
  createMcpTestService as createService,
  registerMcpTestApp,
  stopMcpTestApps,
} from './helpers/mcp-service-harness'
import { MCP_RESOURCE_URIS, MCP_TOOL_CATALOGUE, mcpToolCatalogueForScopes, toMcpToolCatalogue } from './helpers/mcp-tool-catalogue'

afterEach(async () => {
  await stopMcpTestApps()
})

describe('SandboxMcpService', () => {
  it('持久化明文 Token 供控制台再次查看，并按权限发现工具', () => {
    const { service, credential, directory } = createService()

    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(service.authenticate(credential.token)?.name).toBe('测试凭证')
    expect(service.getCredential(credential.id).token).toBe(credential.token)
    // 只读凭证发现的工具必须与完整清单里 read 能力范围的条目逐条一致：既抓改名，也抓能力范围写错。
    expect(toMcpToolCatalogue(service.listTools(credential.token))).toEqual(mcpToolCatalogueForScopes(['read']))
    expect(readFileSync(join(directory, 'test-credentials.json'), 'utf8')).toContain(credential.token)
    expect(service.listCredentials()[0]).not.toHaveProperty('tokenDigest')
  })

  it('从同一权威定义生成完整 MCP 能力目录', () => {
    const { service } = createService(['read', 'interact', 'manage', 'debug'])

    const catalog = service.getCapabilityCatalog()
    expect(catalog.serverCapabilities).toEqual({ tools: true, resources: true, prompts: false })
    expect(catalog.scopes).toEqual(['read', 'interact', 'manage', 'debug'])
    // 完整清单断言取代数量断言：工具被误删、误加、改名或能力范围写错都会变红，数量由清单长度隐含。
    expect(toMcpToolCatalogue(catalog.tools)).toEqual(MCP_TOOL_CATALOGUE)
    expect(catalog.resources.map(({ uri }) => uri)).toEqual(MCP_RESOURCE_URIS)
    expect(catalog.tools).toContainEqual(expect.objectContaining({
      name: 'get_server_info',
      scope: 'read',
      inputSchema: expect.objectContaining({ type: 'object' }),
    }))
    expect(catalog.resources).toContainEqual(expect.objectContaining({
      uri: 'onebot-sandbox://guide',
      mimeType: 'application/json',
      requiredScopes: ['read'],
    }))

    catalog.tools[0]!.name = 'mutated'
    expect(service.getCapabilityCatalog().tools[0]!.name).toBe('get_server_info')
    expect(service.listCallRecords()).toEqual({ records: [] })
  })

  it('允许查看并修改已创建凭证的名称、权限和 Token', () => {
    const { app, service, credential, directory, control } = createService(['read'])

    expect(service.getCredential(credential.id)).toMatchObject({
      id: credential.id,
      name: '测试凭证',
      scopes: ['read'],
      enabled: true,
      token: credential.token,
    })
    expect(service.listCredentials()[0]).not.toHaveProperty('tokenDigest')

    const updated = service.updateCredential(credential.id, { name: '联调凭证', scopes: ['read', 'debug'] })
    expect(updated).toMatchObject({ id: credential.id, name: '联调凭证', scopes: ['read', 'debug'], token: credential.token })
    expect(service.authenticate(credential.token)?.name).toBe('联调凭证')
    expect(service.listTools(credential.token).map(({ name }) => name)).toContain('list_onebot_debug_records')

    const reloaded = new SandboxMcpService(app, control, { dataDirectory: directory })
    expect(reloaded.getCredential(credential.id)).toMatchObject({ name: '联调凭证', scopes: ['read', 'debug'], token: credential.token })
    expect(readFileSync(join(directory, 'test-credentials.json'), 'utf8')).toContain(credential.token)
    expect(() => service.updateCredential('missing', { name: 'x' })).toThrow(/凭证不存在/)
    expect(() => service.updateCredential(credential.id, { name: '  ' })).toThrow(/凭证名称/)
    expect(() => service.updateCredential(credential.id, { scopes: [] })).toThrow(/至少选择一项有效权限/)
  })

  it('保留只有摘要的旧凭证，并允许重新生成可查看的 Token', () => {
    const { app, directory, control, service, credential } = createService(['read'])
    writeFileSync(join(directory, 'test-credentials.json'), `${JSON.stringify([{
      id: 'legacy-credential',
      name: '旧摘要凭证',
      scopes: ['read'],
      enabled: true,
      // 真实的旧记录带的是完整 sha256 摘要；长度不合规的摘要现在会让整条被丢弃（见凭证存储健壮性用例）。
      tokenDigest: createHash('sha256').update('legacy-token').digest('hex'),
      createdAt: new Date().toISOString(),
    }], null, 2)}\n`)

    const reloaded = new SandboxMcpService(app, control, { dataDirectory: directory })
    expect(reloaded.listCredentials()).toEqual([expect.objectContaining({
      id: 'legacy-credential',
      name: '旧摘要凭证',
    })])
    expect(reloaded.listCredentials()[0]).not.toHaveProperty('token')

    const rotated = service.rotateCredentialToken(credential.id)
    expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(rotated.token).not.toBe(credential.token)
    expect(service.authenticate(credential.token)).toBeUndefined()
    expect(service.authenticate(rotated.token)?.id).toBe(credential.id)
    expect(service.getCredential(credential.id).token).toBe(rotated.token)
  })

  it('只读工具返回共享场景且拒绝越权调用', async () => {
    const { service, credential } = createService()

    const snapshot = await service.callTool(credential.token, 'get_scene_snapshot', {})
    expect(snapshot).toMatchObject({ revision: 0, participants: expect.any(Array) })
    await expect(service.callTool(credential.token, 'send_message', {})).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('上传媒体、发送消息和等待事实共享同一事件游标', async () => {
    const { control, service, credential } = createService(['read', 'interact'])
    control.updateBot({ id: '20001', name: 'Koishi', implementation: 'napcat', enabled: false })
    const cursor = service.currentCursor()
    const upload = await service.callTool(credential.token, 'upload_media', {
      fileName: '测试.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('hello').toString('base64'),
    }) as { mediaId: string }
    const input = {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: 'MCP 消息',
      mediaIds: [upload.mediaId],
      idempotencyKey: 'message-1',
      testRunId: 'run-1',
    }
    const first = await service.callTool(credential.token, 'send_message', input)
    const replay = await service.callTool(credential.token, 'send_message', input)
    expect(replay).toEqual(first)
    await expect(service.callTool(credential.token, 'send_message', { ...input, content: '不同消息' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(service.callTool(credential.token, 'wait_for_message', { cursor, timeoutSeconds: 1 })).resolves.toMatchObject({ outcome: 'matched' })
  })

  it('机器人图片回复通过 MCP 消息事件暴露结构化媒体', async () => {
    const { app, service, credential } = createService(['read', 'interact'])
    const imageBase64 = Buffer.from('meme-list-image').toString('base64')
    app.middleware((session, next) => next(async () => {
      if (session.selfId !== '20001' || session.userId !== '10001') return
      await session.send(h.image(`data:image/png;base64,${imageBase64}`))
    }))
    await app.start()
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'send_message', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: 'meme.list',
      idempotencyKey: 'meme-list-image-1',
    })

    await expect(service.callTool(credential.token, 'wait_for_message', {
      cursor,
      conversationId: 'private:10001:20001',
      authorId: '20001',
      timeoutSeconds: 1,
    })).resolves.toMatchObject({
      outcome: 'matched',
      event: {
        data: {
          authorId: '20001',
          content: '[图片] image.png',
          media: [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
        },
      },
    })
  })

  it('发送、读取并幂等重放合并转发，同时支持上传媒体与嵌套节点', async () => {
    const { control, service, credential } = createService(['read', 'interact'])
    control.updateBot({ id: '20001', name: 'Koishi', implementation: 'napcat', enabled: false })
    const firstMessage = await service.callTool(credential.token, 'send_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', content: '第一条', idempotencyKey: 'forward-source-1',
    }) as { messageId: string }
    const secondMessage = await service.callTool(credential.token, 'send_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', content: '第二条', idempotencyKey: 'forward-source-2',
    }) as { messageId: string }
    const input = {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      messageIds: [secondMessage.messageId, firstMessage.messageId],
      idempotencyKey: 'forward-send-1',
    }
    const sent = await service.callTool(credential.token, 'send_forward_message', input) as { messageId: string; forwardId: string }
    await expect(service.callTool(credential.token, 'send_forward_message', input)).resolves.toEqual(sent)
    await expect(service.callTool(credential.token, 'send_forward_message', { ...input, messageIds: [firstMessage.messageId] })).rejects.toMatchObject({ code: 'idempotency_conflict' })

    const byForward = await service.callTool(credential.token, 'get_forward_message', {
      operatorId: '10001', forwardId: sent.forwardId,
    }) as { nodes: Array<{ content: string }> }
    await expect(service.callTool(credential.token, 'get_forward_message', {
      operatorId: '10001', messageId: sent.messageId,
    })).resolves.toEqual(expect.objectContaining({ id: sent.forwardId }))
    expect(byForward.nodes.map(({ content }) => content)).toEqual(['第一条', '第二条'])

    const upload = await service.callTool(credential.token, 'upload_media', {
      fileName: '节点.txt', mimeType: 'text/plain', dataBase64: Buffer.from('node').toString('base64'),
    }) as { mediaId: string }
    const nested = await service.callTool(credential.token, 'send_forward_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', idempotencyKey: 'forward-send-2',
      nodes: [{ type: 'custom', userId: '10001', nickname: '测试用户', content: '媒体节点', mediaIds: [upload.mediaId], forwardId: sent.forwardId }],
    }) as { forwardId: string }
    await expect(service.callTool(credential.token, 'get_forward_message', {
      operatorId: '10001', forwardId: nested.forwardId,
    })).resolves.toMatchObject({
      nodes: [{ content: '媒体节点', forwardId: sent.forwardId, media: [expect.objectContaining({ id: upload.mediaId })] }],
    })

    await expect(service.callTool(credential.token, 'send_forward_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', messageIds: [firstMessage.messageId], nodes: [{ type: 'reference', messageId: secondMessage.messageId }], idempotencyKey: 'forward-invalid-1',
    })).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(service.callTool(credential.token, 'send_forward_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', nodes: [{ type: 'custom', userId: '10001', nickname: '测试用户', mediaIds: ['missing'] }], idempotencyKey: 'forward-invalid-2',
    })).rejects.toMatchObject({ code: 'media_not_found' })
    await expect(service.callTool(credential.token, 'send_forward_message', {
      operatorId: '20001', conversationId: 'private:10001:20001', messageIds: [firstMessage.messageId], idempotencyKey: 'forward-invalid-3',
    })).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('合并转发投递完成后可从发送前游标等待机器人同步回复', async () => {
    const { app, service, credential } = createService(['read', 'interact'])
    app.middleware((session, next) => next(async () => {
      if (session.selfId !== '20001' || session.userId !== '10001') return
      await session.send('收到合并转发')
    }))
    await app.start()
    const source = await service.callTool(credential.token, 'send_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', content: '来源', idempotencyKey: 'forward-wait-source',
    }) as { messageId: string }
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'send_forward_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', messageIds: [source.messageId], idempotencyKey: 'forward-wait-send',
    })

    await expect(service.callTool(credential.token, 'wait_for_message', {
      cursor, conversationId: 'private:10001:20001', authorId: '20001', timeoutSeconds: 1,
    })).resolves.toMatchObject({ outcome: 'matched', event: { data: { content: '收到合并转发', authorId: '20001' } } })
    await expect(service.callTool(credential.token, 'wait_for_message', {
      cursor, conversationId: 'private:10001:20001', authorId: '10001', recipientBotId: '20001', timeoutSeconds: 1,
    })).resolves.toMatchObject({ outcome: 'matched', event: { data: { recipientBotId: '20001', forwardId: expect.any(String) } } })
  })

  it('领域交互复用真实权限并禁止代机器人审批', async () => {
    const { service, credential } = createService(['read', 'interact'])
    const request = await service.callTool(credential.token, 'perform_friend_action', {
      operatorId: '10001',
      action: 'request',
      targetId: '10002',
      idempotencyKey: 'friend-request-1',
    }) as { requestId: string }
    await expect(service.callTool(credential.token, 'handle_request', {
      operatorId: '10002',
      requestId: request.requestId,
      approve: true,
      idempotencyKey: 'friend-handle-1',
    })).resolves.toMatchObject({ revision: expect.any(Number) })

    await service.callTool(credential.token, 'perform_friend_action', {
      operatorId: '10002',
      action: 'delete',
      targetId: '20001',
      idempotencyKey: 'robot-delete-1',
    })
    const robotRequest = await service.callTool(credential.token, 'perform_friend_action', {
      operatorId: '10002',
      action: 'request',
      targetId: '20001',
      idempotencyKey: 'robot-request-1',
    }) as { requestId: string }
    await expect(service.callTool(credential.token, 'handle_request', {
      operatorId: '20001',
      requestId: robotRequest.requestId,
      approve: true,
      idempotencyKey: 'robot-handle-1',
    })).rejects.toMatchObject({ code: 'robot_request_forbidden' })
  })

  it('环境变更原子提交且破坏性操作要求版本绑定的一次性令牌', async () => {
    const { control, service, credential } = createService(['read', 'manage'])
    const revision = control.getSnapshot().revision
    await service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: revision,
      idempotencyKey: 'atomic-change-1',
      changes: [{ action: 'create-user', data: { id: '10009', name: '临时用户' } }],
    })
    expect(control.getSnapshot().participants).toContainEqual(expect.objectContaining({
      kind: 'user',
      id: '10009',
      name: '临时用户',
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
    }))
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: revision,
      idempotencyKey: 'atomic-change-2',
      changes: [{ action: 'create-user', data: { id: '10010', name: '过期变更' } }],
    })).rejects.toMatchObject({ code: 'revision_conflict' })

    const prepared = await service.callTool(credential.token, 'prepare_destructive_action', {
      expectedRevision: control.getSnapshot().revision,
      tool: 'delete_environment_entity',
      arguments: { kind: 'user', id: '10009' },
    }) as { confirmationToken: string }
    await service.callTool(credential.token, 'delete_environment_entity', {
      kind: 'user',
      id: '10009',
      confirmationToken: prepared.confirmationToken,
    })
    expect(control.getSnapshot().participants.some(({ id }) => id === '10009')).toBe(false)
    await expect(service.callTool(credential.token, 'delete_environment_entity', {
      kind: 'user', id: '10001', confirmationToken: prepared.confirmationToken,
    })).rejects.toMatchObject({ code: 'confirmation_required' })
  })

  it('环境变更用幂等键让丢失响应后的重试返回首次结果', async () => {
    const { control, service, credential } = createService(['read', 'manage'])
    const expectedRevision = control.getSnapshot().revision
    const changes = [{ action: 'create-user', data: { id: '10009', name: '幂等用户' } }]

    await expect(service.callTool(credential.token, 'apply_environment_changes', { expectedRevision, changes }))
      .rejects.toMatchObject({ code: 'invalid_arguments', message: 'idempotencyKey 不能为空' })

    const first = await service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision, idempotencyKey: 'replay-1', changes,
    })
    expect(first).toMatchObject({ revision: expectedRevision + 1, affected: ['create-user'] })

    // 响应丢失后同键同参重试：拿回首次结果，而不是 expectedRevision 已过期导致的 revision_conflict；
    // 环境也不会被改第二次。
    expect(await service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision, idempotencyKey: 'replay-1', changes,
    })).toEqual(first)
    expect(control.getSnapshot().revision).toBe(expectedRevision + 1)
    expect(control.getSnapshot().participants.filter(({ id }) => id === '10009')).toHaveLength(1)

    // 同键换参数是调用方的编程错误，必须暴露而不是静默返回上一次的结果。
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision, idempotencyKey: 'replay-1',
      changes: [{ action: 'create-user', data: { id: '10010', name: '换参用户' } }],
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(control.getSnapshot().participants.some(({ id }) => id === '10010')).toBe(false)
  })

  it('按凭证限制调用频率并记录脱敏测试调用', async () => {
    const app = registerMcpTestApp(new App())
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-limit-'))
    const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media') })
    const service = new SandboxMcpService(app, control, { dataDirectory: directory, readPerMinute: 1 })
    const credential = service.createCredential('限流凭证', ['read', 'debug'])
    await service.callTool(credential.token, 'get_server_info', {}, { sourceIp: '127.0.0.1' })
    await expect(service.callTool(credential.token, 'get_scene_snapshot', {})).rejects.toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: expect.any(Number) })
    const page = service.listCallRecords()
    expect(page.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ credentialName: '限流凭证', sourceIp: '127.0.0.1', tool: 'get_server_info', status: 'success' }),
      expect.objectContaining({ credentialName: '限流凭证', tool: 'get_scene_snapshot', status: 'error', errorCode: 'rate_limited' }),
    ]))
    expect(JSON.stringify(page.records)).not.toContain(credential.token)
  })

  it('在显式 spaceId 中准备隔离环境并保留完成结果', async () => {
    const { control, service, credential, testSpaces } = createService(['read', 'manage'], true)
    expect(service.readResource(credential.token, 'onebot-sandbox://errors')).toEqual(expect.arrayContaining([
      'space_id_required',
      'space_taken_over',
      'space_not_found',
      'space_unavailable',
      'test_spaces_unavailable',
    ]))
    expect(service.readResource(credential.token, 'onebot-sandbox://examples')).toMatchObject({
      create_test_space: {
        name: '退群公告测试',
        idempotencyKey: 'example-space-1',
      },
      send_message: {
        spaceId: '<create_test_space.spaceId>',
        operatorId: '10001',
        conversationId: 'private:10001:20002',
        content: '你好',
        idempotencyKey: 'example-message-1',
      },
      send_forward_message: {
        spaceId: '<create_test_space.spaceId>',
        operatorId: '10001',
        conversationId: 'private:10001:20002',
        messageIds: expect.any(Array),
        idempotencyKey: 'example-forward-1',
      },
      get_forward_message: {
        operatorId: '10001',
        forwardId: '<send_forward_message.forwardId>',
      },
      等待机器人回复: {
        步骤: [
          // 不再需要先取一次游标：发送工具返回的 cursorBefore 就是发送前的位置。
          expect.objectContaining({ tool: 'send_message', 得到: 'cursorBefore' }),
          expect.objectContaining({ tool: 'wait_for_message' }),
        ],
      },
    })
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: control.getSnapshot().revision,
      idempotencyKey: 'main-write-1',
      changes: [],
    })).rejects.toMatchObject({ code: 'space_id_required' })
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '退群公告测试',
      idempotencyKey: 'space-create-1',
    }) as { spaceId: string; revision: number }

    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'space-setup-1',
      changes: [{ action: 'create-user', data: { id: '11001', name: '测试成员' } }],
    })
    const snapshot = await service.callTool(credential.token, 'get_scene_snapshot', { spaceId: created.spaceId }) as { participants: Array<{ id: string }> }
    expect(snapshot.participants.map(({ id }) => id)).toEqual(['11001'])
    expect(control.getSnapshot().participants).toHaveLength(4)

    testSpaces.takeOver(created.spaceId)
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: 1,
      idempotencyKey: 'space-setup-2',
      changes: [],
    })).rejects.toMatchObject({ code: 'space_taken_over' })
    testSpaces.returnControl(created.spaceId)

    await service.callTool(credential.token, 'complete_test_space', {
      spaceId: created.spaceId,
      idempotencyKey: 'space-complete-1',
    })
    const spaces = await service.callTool(credential.token, 'list_test_spaces', {}) as { items: Array<{ id: string; status: string; snapshot: { participants: unknown[] } }> }
    expect(spaces.items).toMatchObject([{ id: created.spaceId, status: 'completed', snapshot: { participants: [{ id: '11001' }] } }])
  })

  it('让所有有效凭证共享测试空间，同时保留 Scope 与接管限制', async () => {
    const { service, credential, testSpaces } = createService(['read', 'manage'], true)
    const rotated = service.createCredential('轮换凭证', ['read', 'manage'])
    const readOnly = service.createCredential('只读凭证', ['read'])
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '跨凭证空间',
      idempotencyKey: 'shared-space-create-1',
    }) as { spaceId: string; revision: number }

    await expect(service.callTool(rotated.token, 'list_test_spaces', {})).resolves.toMatchObject({
      items: [{ id: created.spaceId, name: '跨凭证空间', status: 'running' }],
    })
    await expect(service.callTool(rotated.token, 'get_test_space', { spaceId: created.spaceId })).resolves.toMatchObject({
      id: created.spaceId,
      name: '跨凭证空间',
    })
    await service.callTool(rotated.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'shared-space-setup-1',
      changes: [{ action: 'create-user', data: { id: '11001', name: '轮换后创建' } }],
    })
    await expect(service.callTool(readOnly.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: 1,
      idempotencyKey: 'shared-space-setup-2',
      changes: [],
    })).rejects.toMatchObject({ code: 'permission_denied' })

    testSpaces.takeOver(created.spaceId)
    await expect(service.callTool(readOnly.token, 'get_scene_snapshot', { spaceId: created.spaceId })).resolves.toMatchObject({
      participants: [expect.objectContaining({ id: '11001' })],
    })
    await expect(service.callTool(rotated.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: 1,
      idempotencyKey: 'shared-space-setup-3',
      changes: [],
    })).rejects.toMatchObject({ code: 'space_taken_over' })
  })

  it('等待消息时按空间隔离并返回实际接收机器人的 ID', async () => {
    const { app, service, credential, testSpaces } = createService(['read', 'interact', 'manage'], true)
    app.middleware(() => {})
    await app.start()
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'space-message-1',
    }) as { spaceId: string }
    const control = testSpaces.getControl(created.spaceId)
    control.createUser({ id: '11001', name: '测试成员' })
    control.createBot({ id: '21001', name: '测试机器人', implementation: 'napcat', enabled: true })
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'send_message', {
      spaceId: created.spaceId,
      operatorId: '11001',
      conversationId: 'private:11001:21001',
      content: '测试消息',
      idempotencyKey: 'space-message-send-1',
    })

    await expect(service.callTool(credential.token, 'wait_for_message', {
      spaceId: created.spaceId,
      recipientBotId: '21001',
      cursor,
      timeoutSeconds: 1,
    })).resolves.toMatchObject({
      outcome: 'matched',
      event: {
        spaceId: created.spaceId,
        data: { recipientBotId: '21001' },
      },
    })
  })

  it('update-bot 只更新显式提供的字段', async () => {
    const { service, credential, testSpaces } = createService(['read', 'manage'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'space-update-bot-1',
    }) as { spaceId: string; revision: number }
    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'update-bot-setup-1',
      changes: [{
        action: 'create-bot',
        data: { id: '21001', name: '被测机器人', implementation: 'llbot', enabled: false, avatar: `data:image/png;base64,${Buffer.from('avatar-a').toString('base64')}`, disabledCapabilities: ['set_qq_profile'] },
      }],
    })
    const control = testSpaces.getControl(created.spaceId)

    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: control.getSnapshot().revision,
      idempotencyKey: 'update-bot-1',
      changes: [{ action: 'update-bot', data: { id: '21001', name: 'koishi' } }],
    })
    expect(control.getSnapshot().participants[0]).toEqual({
      kind: 'bot',
      id: '21001',
      name: 'koishi',
      implementation: 'llbot',
      enabled: false,
      avatar: expect.stringMatching(/^sandbox-media:\/\//),
      disabledCapabilities: ['set_qq_profile'],
    })

    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: control.getSnapshot().revision,
      idempotencyKey: 'update-bot-2',
      changes: [{ action: 'update-bot', data: { id: '21001', implementation: 'napcat', enabled: true } }],
    })
    expect(control.getSnapshot().participants[0]).toMatchObject({ name: 'koishi', implementation: 'napcat', enabled: true })

    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: control.getSnapshot().revision,
      idempotencyKey: 'update-bot-3',
      changes: [{ action: 'update-bot', data: { id: '21001', implementation: 'gocq' } }],
    })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('环境变更 schema 按 action 判别并声明各自必填字段', () => {
    const { service, credential } = createService(['manage'], true)
    const schema = service.listTools(credential.token)
      .find(({ name }) => name === 'apply_environment_changes')!.inputSchema as {
        properties: { changes: { items: { oneOf: Array<{ title: string; properties: Record<string, unknown>; required: string[] }> } } }
      }
    const variants = schema.properties.changes.items.oneOf

    expect(variants.map(({ title }) => title)).toEqual([
      'create-user', 'update-user', 'create-bot', 'update-bot',
      'set-capabilities', 'create-group', 'update-group', 'set-friendship',
    ])
    expect(variants.every(({ required }) => required.includes('action') && required.includes('data'))).toBe(true)
    const updateBot = variants.find(({ title }) => title === 'update-bot')!
    expect(updateBot.properties.action).toEqual({ const: 'update-bot' })
    expect(updateBot.properties.data).toMatchObject({ required: ['id'] })
    expect(variants.find(({ title }) => title === 'create-bot')!.properties.data).toMatchObject({ required: ['id', 'name'] })
  })

  it('发送工具返回发送前游标，用它能等到调用返回前就已发生的同步回复', async () => {
    const { app, service, credential, testSpaces } = createService(['read', 'interact', 'manage'], true)
    // 同步回复：中间件在 send_message 返回之前就把回复送进事件流。
    app.middleware(async (session, next) => {
      if (session.userId !== '11001') return next()
      await session.send('同步回复')
    })
    await app.start()
    const created = await service.callTool(credential.token, 'create_test_space', { idempotencyKey: 'space-cursor-1' }) as { spaceId: string }
    const control = testSpaces.getControl(created.spaceId)
    control.createUser({ id: '11001', name: '测试成员' })
    control.createBot({ id: '21001', name: '测试机器人', implementation: 'napcat', enabled: true })

    const sent = await service.callTool(credential.token, 'send_message', {
      spaceId: created.spaceId,
      operatorId: '11001',
      conversationId: 'private:11001:21001',
      content: '触发同步回复',
      idempotencyKey: 'space-cursor-send-1',
    }) as { cursorBefore: { epoch: string, sequence: number }, cursor: { epoch: string, sequence: number } }

    // 两个游标必须是不同位置，否则「发送前」这个说法本身就不成立。
    expect(sent.cursorBefore.sequence).toBeLessThan(sent.cursor.sequence)
    const waitArgs = { spaceId: created.spaceId, conversationId: 'private:11001:21001', authorId: '21001', timeoutSeconds: 1 }
    await expect(service.callTool(credential.token, 'wait_for_message', { ...waitArgs, cursor: sent.cursorBefore }))
      .resolves.toMatchObject({ outcome: 'matched', event: { data: { content: '同步回复' } } })
    // 用发送后的游标等同一条回复必然错过：这正是 cursorBefore 存在的理由。
    await expect(service.callTool(credential.token, 'wait_for_message', { ...waitArgs, cursor: sent.cursor }))
      .resolves.toMatchObject({ outcome: 'timeout', reason: 'timeout' })
  })

  it('静默期等待收集完整回复序列并返回最终消息', async () => {
    const { app, service, credential, testSpaces } = createService(['read', 'interact', 'manage'], true)
    app.middleware(async (session, next) => {
      if (session.userId !== '11001') return next()
      await session.send('稍等，正在处理')
      setTimeout(() => { void session.send('最终结果') }, 30)
    })
    await app.start()
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'space-settle-1',
    }) as { spaceId: string }
    const control = testSpaces.getControl(created.spaceId)
    control.createUser({ id: '11001', name: '测试成员' })
    control.createBot({ id: '21001', name: '测试机器人', implementation: 'napcat', enabled: true })
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'send_message', {
      spaceId: created.spaceId,
      operatorId: '11001',
      conversationId: 'private:11001:21001',
      content: '触发多段回复',
      idempotencyKey: 'space-settle-send-1',
    })

    const settled = await service.callTool(credential.token, 'wait_for_message', {
      spaceId: created.spaceId,
      cursor,
      conversationId: 'private:11001:21001',
      authorId: '21001',
      settleSeconds: 1,
      timeoutSeconds: 5,
    }) as { outcome: string; event: { data: { content: string } }; events: Array<{ data: { content: string } }> }

    expect(settled.outcome).toBe('matched')
    expect(settled.events.map(({ data }) => data.content)).toEqual(['稍等，正在处理', '最终结果'])
    expect(settled.event.data.content).toBe('最终结果')
  })

  it('等待插件真实发起的 OneBot action 并按结果过滤', async () => {
    const { app, service, credential, testSpaces } = createService(['read', 'interact', 'manage', 'debug'], true)
    app.middleware(async (session, next) => {
      if (session.userId !== '11001') return next()
      // 机器人是普通成员，踢人必定失败：验证等待工具能拿到真实失败结果，
      // 而不是只看机器人回复的自述文本。
      await session.bot.internal._request('set_group_kick', { group_id: 31001, user_id: 11002 }).catch(() => {})
    })
    await app.start()
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'space-action-1',
    }) as { spaceId: string }
    const control = testSpaces.getControl(created.spaceId)
    control.createUser({ id: '11001', name: '测试成员' })
    control.createUser({ id: '11002', name: '目标成员' })
    control.createBot({ id: '21001', name: '测试机器人', implementation: 'napcat', enabled: true })
    control.createGroup({ id: '31001', name: '权限群', members: [
      { participantId: '11001', role: 'owner' },
      { participantId: '11002', role: 'admin' },
      { participantId: '21001', role: 'member' },
    ] })
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'send_message', {
      spaceId: created.spaceId,
      operatorId: '11001',
      conversationId: 'group:31001',
      content: '踢掉他',
      idempotencyKey: 'space-action-send-1',
    })

    await expect(service.callTool(credential.token, 'wait_for_onebot_action', {
      spaceId: created.spaceId,
      cursor,
      botId: '21001',
      action: 'set_group_kick',
      timeoutSeconds: 5,
    })).resolves.toMatchObject({
      outcome: 'matched',
      record: {
        botId: '21001',
        requestedAction: 'set_group_kick',
        action: 'set_group_kick',
        status: 'error',
        error: expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          retryable: expect.any(Boolean),
          traceId: expect.any(String),
        }),
      },
      cursor: expect.objectContaining({ sequence: expect.any(Number) }),
    })
    await expect(service.callTool(credential.token, 'wait_for_onebot_action', {
      spaceId: created.spaceId,
      cursor,
      action: 'set_group_kick',
      status: 'success',
      timeoutSeconds: 1,
    })).resolves.toMatchObject({ outcome: 'timeout', reason: 'timeout' })
  })

  it('AI 测试空间占用期间报告 MCP 活动，结束后清除', async () => {
    const { service, credential, testSpaces } = createService(['read', 'interact', 'manage'], true)
    const events: boolean[] = []
    service.onActivity((running) => events.push(running))
    expect(service.isActivityRunning()).toBe(false)

    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'space-activity-1',
    }) as { spaceId: string }
    expect(service.isActivityRunning()).toBe(true)
    expect(events).toEqual([true])

    await service.callTool(credential.token, 'wait_for_message', {
      spaceId: created.spaceId,
      cursor: service.currentCursor(),
      timeoutSeconds: 1,
    })
    expect(service.isActivityRunning()).toBe(true)
    expect(events).toEqual([true])

    testSpaces.takeOver(created.spaceId)
    expect(service.isActivityRunning()).toBe(false)
    expect(events).toEqual([true, false])

    testSpaces.returnControl(created.spaceId)
    expect(service.isActivityRunning()).toBe(true)

    await service.callTool(credential.token, 'complete_test_space', {
      spaceId: created.spaceId,
      idempotencyKey: 'space-activity-complete-1',
    })
    expect(service.isActivityRunning()).toBe(false)
    expect(events).toEqual([true, false, true, false])
  })
})

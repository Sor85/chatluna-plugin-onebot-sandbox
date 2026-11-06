import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxMcpService } from '../src/mcp/service'
import { beginAgentTurn, createDirectSession, finishAgentTurn } from './helpers/chatluna-state-broadcast'
import { createMcpTestService, createStartedMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 补齐此前零覆盖的十五个对外工具，并断言它们各自的领域约束。
 *
 * 全部调用经 `service.callTool`——测试控制服务的工具调用入口，而不是下降到测试空间服务、
 * 控制服务或调试记录存储各自的方法：只有经该入口才会覆盖能力范围检查、限流分类、并发包装、
 * 幂等处理、调用记录写入，以及非结构化领域错误被归一为 `domain_error` 这条行为。
 *
 * 断言不止于「调用成功」。只断言调用成功是最弱的覆盖形式，本文件正是在补那类伪覆盖留下的缺口。
 */

afterEach(async () => {
  await stopMcpTestApps()
})

describe('MCP 读取类工具', () => {
  it('分页列出当前操作者可见会话', async () => {
    const { service, credential } = createMcpTestService(['read'])
    type Page = { items: Array<{ id: string }>; nextPageCursor?: string }

    const all = await service.callTool(credential.token, 'list_conversations', { operatorId: '10001' }) as Page
    // 默认场景里 10001 只与机器人有私聊，另两位用户的私聊对它不可见。
    expect(all.items.map(({ id }) => id)).toEqual(['private:10001:20001', 'group:30001'])
    expect(all.nextPageCursor).toBeUndefined()

    const firstPage = await service.callTool(credential.token, 'list_conversations', { operatorId: '10001', limit: 1 }) as Page
    expect(firstPage.items.map(({ id }) => id)).toEqual(['private:10001:20001'])
    expect(firstPage.nextPageCursor).toEqual(expect.any(String))

    const secondPage = await service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001', limit: 1, pageCursor: firstPage.nextPageCursor,
    }) as Page
    expect(secondPage.items.map(({ id }) => id)).toEqual(['group:30001'])
    expect(secondPage.nextPageCursor).toBeUndefined()

    // 另一位操作者看到的是自己的私聊，可见性随操作者变化而不是返回全量会话。
    const other = await service.callTool(credential.token, 'list_conversations', { operatorId: '10002' }) as Page
    expect(other.items.map(({ id }) => id)).toEqual(['private:10002:20001', 'group:30001'])
  })

  it('会话列表默认只返回根会话，显式传 rootConversationId 时返回该根会话下的实例', async () => {
    const { service, credential, control } = createMcpTestService(['read'])
    // 默认场景不生成实例，因此显式问一个根会话时返回空列表而不是报错。
    await expect(service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    })).resolves.toEqual({ items: [] })

    const first = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001', title: '第一条对话线' })
    const second = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'private:10001:20001', title: '第二条对话线' })
    const grouped = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001', title: '群里的对话线' })

    // 三个实例存在之后默认列表仍然只有根会话：外部测试控制器不会把实例误当成新的联系人。
    const roots = await service.callTool(credential.token, 'list_conversations', { operatorId: '10001' }) as { items: Array<{ id: string }> }
    expect(roots.items.map(({ id }) => id)).toEqual(['private:10001:20001', 'group:30001'])

    const instances = await service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
    }) as { items: Array<{ id: string, kind: string, rootConversationId: string, title?: string, type: string }> }
    // 只返回被问到的那个根会话下的实例，群会话的实例不混进来。
    expect(instances.items).toEqual([
      { id: first.conversationId, kind: 'instance', rootConversationId: 'private:10001:20001', type: 'direct', participantIds: ['10001', '20001'], messageIds: [], title: '第一条对话线' },
      { id: second.conversationId, kind: 'instance', rootConversationId: 'private:10001:20001', type: 'direct', participantIds: ['10001', '20001'], messageIds: [], title: '第二条对话线' },
    ])
    expect(await service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001',
      rootConversationId: 'group:30001',
    })).toMatchObject({ items: [expect.objectContaining({ id: grouped.conversationId, type: 'group', groupId: '30001' })] })

    // 分页对实例列表同样生效。
    const instanceFirstPage = await service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001', rootConversationId: 'private:10001:20001', limit: 1,
    }) as { items: Array<{ id: string }>; nextPageCursor?: string }
    expect(instanceFirstPage).toMatchObject({ items: [expect.objectContaining({ id: first.conversationId })], nextPageCursor: expect.any(String) })
    expect(await service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001', rootConversationId: 'private:10001:20001', limit: 1, pageCursor: instanceFirstPage.nextPageCursor,
    })).toEqual({ items: [expect.objectContaining({ id: second.conversationId })] })

    // 传入实例 ID 时归一化到它的根会话：层级严格两层，不存在第三层可问。
    expect(await service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001', rootConversationId: first.conversationId,
    })).toEqual(instances)

    // 实例的可见性完全继承根会话：别人的私聊按会话不存在拒绝，而不是泄露它下面有几条对话线。
    await expect(service.callTool(credential.token, 'list_conversations', {
      operatorId: '10002', rootConversationId: 'private:10001:20001',
    })).rejects.toMatchObject({ code: 'conversation_not_found' })
    await expect(service.callTool(credential.token, 'list_conversations', {
      operatorId: '10001', rootConversationId: 'private:10001:99999',
    })).rejects.toMatchObject({ code: 'conversation_not_found' })
    // 显式传了参数却不是字符串时必须显式失败：静默按「省略」处理会返回根会话列表，
    // 而调用方以为自己拿到的是实例列表，两者形状相同、没有任何可察觉的迹象。
    for (const rootConversationId of ['', '   ', null, 42]) {
      await expect(service.callTool(credential.token, 'list_conversations', { operatorId: '10001', rootConversationId }))
        .rejects.toMatchObject({ code: 'invalid_arguments' })
    }
  })

  it('测试控制端点不提供创建或分叉会话实例的写工具', async () => {
    // 会话实例目前是人工复盘手段：按 ADR-0017 只暴露稳定的领域测试能力，本轮不给外部
    // 测试控制器开写入口。工具清单本身由 tests/helpers/mcp-tool-catalogue.ts 逐条守卫，
    // 这里断言的是「尝试写入会被明确拒绝」，而不是静默成功或落到别的工具上。
    const { service, credential } = createMcpTestService(['read', 'interact', 'manage', 'debug'])
    for (const tool of ['create_conversation_instance', 'branch_conversation_instance', 'create_conversation', 'branch_conversation']) {
      await expect(service.callTool(credential.token, tool, { operatorId: '10001', rootConversationId: 'private:10001:20001' }))
        .rejects.toMatchObject({ code: 'tool_not_found' })
    }
    // 环境变更也不接受实例形状的动作，AI 不能绕开工具清单从这里造实例。
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: 0,
      idempotencyKey: 'instance-change-1',
      changes: [{ action: 'create-conversation-instance', data: { rootConversationId: 'private:10001:20001', title: '外部造出来的实例' } }],
    })).rejects.toMatchObject({ code: 'unsupported_change' })
  })

  it('读取单个会话及其消息，并拒绝不可见会话', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'interact'])
    // 未启动 App 时机器人 middleware 不会收敛，send_message 会一直等待同步回复；停用机器人后仍会写入消息。
    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: false })
    const sent = await service.callTool(credential.token, 'send_message', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '会话详情用例',
      idempotencyKey: 'conversation-detail-1',
    }) as { messageId: string }

    const detail = await service.callTool(credential.token, 'get_conversation', {
      operatorId: '10001',
      conversationId: 'private:10001:20001',
    }) as { conversation: { id: string; messageIds: string[] }; messages: Array<{ id: string; content: string }> }
    expect(detail.conversation.id).toBe('private:10001:20001')
    expect(detail.conversation.messageIds).toContain(sent.messageId)
    // 返回的消息集合必须正好是该会话引用的消息，而不是操作者可见的全部消息。
    expect(detail.messages.map(({ id }) => id)).toEqual(detail.conversation.messageIds)
    expect(detail.messages).toContainEqual(expect.objectContaining({ id: sent.messageId, content: '会话详情用例' }))

    // 别人的私聊对当前操作者不可见，读取时按会话不存在拒绝而不是泄露内容。
    await expect(service.callTool(credential.token, 'get_conversation', {
      operatorId: '10001',
      conversationId: 'private:10002:20001',
    })).rejects.toMatchObject({ code: 'conversation_not_found' })
  })

  it('列出当前场景真实存在的待处理好友与群申请', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'interact'])
    control.createUser({ id: '10004', name: '申请人' })

    // 结果包一层：裸数组在 MCP 表述下拿不到 structuredContent，而集合键与另外三个 list 同名。
    await expect(service.callTool(credential.token, 'list_pending_requests', {})).resolves.toEqual({ items: [] })

    const friend = await service.callTool(credential.token, 'perform_friend_action', {
      operatorId: '10004',
      action: 'request',
      targetId: '10001',
      idempotencyKey: 'pending-friend-1',
    }) as { requestId: string }
    const group = await service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10004',
      action: 'request-join',
      groupId: '30001',
      idempotencyKey: 'pending-group-1',
    }) as { requestId: string }

    expect(await service.callTool(credential.token, 'list_pending_requests', {})).toEqual({
      items: [
        expect.objectContaining({ id: friend.requestId, type: 'friend', requesterId: '10004', targetId: '10001', status: 'pending' }),
        expect.objectContaining({ id: group.requestId, type: 'group', subType: 'add', requesterId: '10004', groupId: '30001', status: 'pending' }),
      ],
    })

    // 申请被处理后不再出现在待处理列表里。
    await service.callTool(credential.token, 'handle_request', {
      operatorId: '10001',
      requestId: friend.requestId,
      approve: true,
      idempotencyKey: 'pending-friend-handle-1',
    })
    expect(await service.callTool(credential.token, 'list_pending_requests', {})).toEqual({
      items: [expect.objectContaining({ id: group.requestId })],
    })
  })

  it('读取能力覆盖矩阵，结果随实现配置与能力覆盖变化', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'manage'])
    type Capability = { id: string; action: string; supported: boolean; reason?: string }
    const matrix = async (args: Record<string, unknown>) => (
      await service.callTool(credential.token, 'get_capability_matrix', args) as { items: Capability[] }
    ).items

    const napcat = await matrix({ implementation: 'napcat' })
    const llbot = await matrix({ implementation: 'llbot' })
    expect(napcat.length).toBeGreaterThan(0)
    // 两套实现基线不同，因此矩阵随 implementation 变化而不是返回同一份清单。
    expect(llbot.map(({ id }) => id)).not.toEqual(napcat.map(({ id }) => id))
    // 省略 implementation 时按 napcat 解析。
    expect(await matrix({})).toEqual(napcat)
    // 非法值必须显式失败：静默回落到 napcat 会让测试控制器以为自己在测另一个协议，而它拿到的
    // 矩阵与 napcat 逐字节相同，没有任何可察觉的迹象。
    for (const implementation of ['bogus', 'NapCat', 'napcat ', '', null, 42]) {
      await expect(service.callTool(credential.token, 'get_capability_matrix', { implementation }))
        .rejects.toMatchObject({ code: 'invalid_arguments' })
    }

    const target = napcat.find(({ supported }) => supported)
    if (!target) throw new Error('NapCat 基线没有任何受支持能力')
    await service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: control.getSnapshot().revision,
      idempotencyKey: 'capability-override-1',
      changes: [{ action: 'set-capabilities', data: { id: '20001', disabledCapabilities: [target.id] } }],
    })

    const overridden = await matrix({ implementation: 'napcat' })
    expect(overridden).toContainEqual(expect.objectContaining({
      id: target.id,
      supported: false,
      reason: '已被机器人能力覆盖禁用',
    }))
    // 只有被覆盖的那一项变化，其余条目保持基线取值。
    expect(overridden.filter(({ id }) => id !== target.id)).toEqual(napcat.filter(({ id }) => id !== target.id))
    // 两条能力基线资源仍返回裸数组：它们的正文本来就是文本序列化，跟着包会让已在读资源的消费者白改一次。
    expect(service.readResource(credential.token, 'onebot-sandbox://capabilities/napcat')).toEqual(overridden)
    expect(Array.isArray(service.readResource(credential.token, 'onebot-sandbox://capabilities/llbot'))).toBe(true)
  })

  it('导出版本化场景，导出内容与当前快照一致', async () => {
    const { service, credential } = createMcpTestService(['read'])

    const exported = await service.callTool(credential.token, 'export_scene', {}) as {
      testApiVersion: number
      exportedAt: string
      scene: { revision: number; participants: Array<{ id: string }> }
    }
    expect(exported.testApiVersion).toBe(1)
    expect(Number.isNaN(Date.parse(exported.exportedAt))).toBe(false)
    expect(exported.scene).toEqual(await service.callTool(credential.token, 'get_scene_snapshot', {}))
    // 导出文档可直接作为 import_scene 的入参形状（导入回路由破坏性场景操作用例覆盖）。
    expect(exported.scene.participants.map(({ id }) => id)).toEqual(['10001', '10002', '10003', '20001'])
  })

  it('导出的场景包含会话实例及其消息归属', async () => {
    const { service, credential, control } = createMcpTestService(['read'])
    // 未启动 App 时机器人 middleware 不会收敛，sendMessage 会一直等待同步回复；停用机器人后仍会写入消息。
    control.updateBot({ id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: false })
    const instance = control.createConversationInstance({
      operatorId: '10001',
      rootConversationId: 'private:10001:20001',
      title: '导出用的对话线',
    })
    const sent = await control.sendMessage({ operatorId: '10001', conversationId: instance.conversationId, content: '实例里的消息' })

    const exported = await service.callTool(credential.token, 'export_scene', {}) as {
      scene: {
        conversationInstances: Array<{ id: string, rootConversationId: string, title: string, messageIds: string[] }>
        conversations: Array<{ id: string, messageIds: string[] }>
        messages: Array<{ id: string, conversationId: string }>
      }
    }

    // 导出是整份场景：漏掉实例集合会让导入回来的场景与原场景不等价。
    expect(exported.scene.conversationInstances).toEqual([{
      id: instance.conversationId,
      rootConversationId: 'private:10001:20001',
      title: '导出用的对话线',
      messageIds: [sent.messageId],
    }])
    // 消息归属跟着一起导出：实例里的消息指向实例本身，根会话没有拿到它。
    expect(exported.scene.messages.find(({ id }) => id === sent.messageId)?.conversationId).toBe(instance.conversationId)
    expect(exported.scene.conversations.find(({ id }) => id === 'private:10001:20001')?.messageIds).toEqual([])
  })
})

describe('MCP 清理类工具', () => {
  it('清理 OneBot 调试记录后记录为空且返回数量与清理前一致', async () => {
    const { service, credential, control } = await createStartedMcpTestService(['debug'])
    await control.bot.internal._request('get_login_info', {})
    await control.bot.internal._request('get_friend_list', {})

    const before = await service.callTool(credential.token, 'list_onebot_debug_records', {}) as { items: unknown[] }
    expect(before.items).toHaveLength(2)

    expect(await service.callTool(credential.token, 'clear_onebot_debug_records', {})).toEqual({ cleared: 2 })
    expect(await service.callTool(credential.token, 'list_onebot_debug_records', {})).toMatchObject({ items: [] })
  })

  it('清理测试调用记录后只留下清理调用自身的记录', async () => {
    const { service, credential } = createMcpTestService(['read', 'debug'])
    await service.callTool(credential.token, 'get_server_info', {})
    await service.callTool(credential.token, 'get_scene_snapshot', {})
    await service.callTool(credential.token, 'export_scene', {})

    const before = await service.callTool(credential.token, 'list_test_call_records', {}) as { items: Array<{ tool: string }> }
    // 调用记录在工具执行完成之后写入，因此读取自身不出现在它返回的页里。
    expect(before.items.map(({ tool }) => tool)).toEqual(['export_scene', 'get_scene_snapshot', 'get_server_info'])

    // 同理，cleared 覆盖清理调用之前的全部记录，包括上一次读取自身留下的那条。
    expect(await service.callTool(credential.token, 'clear_test_call_records', {})).toEqual({ cleared: before.items.length + 1 })
    const after = await service.callTool(credential.token, 'list_test_call_records', {}) as { items: Array<{ tool: string }> }
    expect(after.items.map(({ tool }) => tool)).toEqual(['clear_test_call_records'])
  })
})

describe('MCP 交互类工具', () => {
  it('执行群操作并改变模拟 QQ 环境，越权时明确拒绝', async () => {
    const { service, credential, control } = await createStartedMcpTestService(['read', 'interact'])
    control.createUser({ id: '10004', name: '群外用户' })
    type Snapshot = {
      groups: Array<{ id: string; members: Array<{ participantId: string; role: string }> }>
      requests: Array<{ id: string; subType?: string; requesterId: string; targetId?: string }>
    }
    const snapshot = () => service.callTool(credential.token, 'get_scene_snapshot', {}) as Promise<Snapshot>
    const members = async () => (await snapshot()).groups[0]!.members.map(({ participantId, role }) => `${participantId}:${role}`)

    // 入群：产出待处理申请，但在批准前不会直接加入群。
    const join = await service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10004', action: 'request-join', groupId: '30001', idempotencyKey: 'group-join-1',
    }) as { requestId: string }
    expect((await snapshot()).requests).toContainEqual(expect.objectContaining({ id: join.requestId, subType: 'add', requesterId: '10004' }))
    expect(await members()).not.toContain('10004:member')

    // 只能邀请好友：非好友 10004 被拒，加为好友后才能邀请。
    await expect(service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10001', action: 'invite', groupId: '30001', targetId: '10004', idempotencyKey: 'group-invite-0',
    })).rejects.toMatchObject({ code: 'domain_error', message: '只能邀请好友入群：10004 不是 10001 的好友' })
    const friend = await control.performFriendAction({ action: 'request', operatorId: '10004', targetId: '10001' })
    await control.performFriendAction({ action: 'handle-request', operatorId: '10001', requestId: friend.requestId!, approve: true })
    const invite = await service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10001', action: 'invite', groupId: '30001', targetId: '10004', idempotencyKey: 'group-invite-1',
    }) as { requestId: string }
    expect((await snapshot()).requests).toContainEqual(expect.objectContaining({ id: invite.requestId, subType: 'invite', requesterId: '10001', targetId: '10004' }))

    // 群管理：只有群主能设置管理员，普通成员越权时领域错误被归一为 domain_error。
    await expect(service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10003', action: 'set-admin', groupId: '30001', targetId: '10002', enabled: false, idempotencyKey: 'group-admin-denied-1',
    })).rejects.toMatchObject({ code: 'domain_error', message: '只有群主可以设置管理员' })
    await service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10001', action: 'set-admin', groupId: '30001', targetId: '10003', enabled: true, idempotencyKey: 'group-admin-1',
    })
    expect(await members()).toContain('10003:admin')

    await service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10002', action: 'leave', groupId: '30001', idempotencyKey: 'group-leave-1',
    })
    expect(await members()).not.toContain('10002:admin')

    await service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10001', action: 'poke', groupId: '30001', targetId: '10003', conversationId: 'group:30001', idempotencyKey: 'group-poke-1',
    })
    const conversation = await service.callTool(credential.token, 'get_conversation', {
      operatorId: '10001', conversationId: 'group:30001',
    }) as { messages: Array<{ authorId: string; content: string; event?: { type: string; targetId?: string } }> }
    expect(conversation.messages.at(-1)).toMatchObject({
      authorId: '10001',
      content: '测试用户1 戳了戳 测试用户3',
      event: { type: 'poke', targetId: '10003' },
    })
  })

  it('等待 ChatLuna 状态：按游标定位状态变更，上一轮结束的状态不会被当成本轮结果', async () => {
    const { app, service, credential, control } = await createStartedMcpTestService(['interact'])
    const session = createDirectSession(control, '20001')
    type WaitResult = {
      outcome: 'matched' | 'timeout'
      reason?: string
      state?: { botParticipantId: string; conversationId: string; thinking: boolean }
    }

    const cursor = service.currentCursor()
    // thinking=true 是瞬时状态，但状态变更进了事件流，因此发生在游标之后就能补等到。
    const pending = service.callTool(credential.token, 'wait_for_chatluna_state', {
      cursor, botParticipantId: '20001', thinking: true, timeoutSeconds: 5,
    }) as Promise<WaitResult>
    await beginAgentTurn(app, session, 'route:direct')
    expect(await pending).toMatchObject({
      outcome: 'matched',
      state: { botParticipantId: '20001', conversationId: 'private:10001:20001', thinking: true },
    })

    await finishAgentTurn(app, 'route:direct')
    await expect(service.callTool(credential.token, 'wait_for_chatluna_state', {
      cursor, botParticipantId: '20001', thinking: false, timeoutSeconds: 5,
    })).resolves.toMatchObject({ outcome: 'matched', state: { thinking: false } })

    // 本轮已经结束：用结束之后取的新游标等待时，两种状态都必须超时。thinking=false 这条是关键——
    // 直接读当前状态的实现会立刻匹配到上一轮留下的已结束状态，把它当成本轮结果。
    const afterRound = service.currentCursor()
    expect(await service.callTool(credential.token, 'wait_for_chatluna_state', {
      cursor: afterRound, botParticipantId: '20001', thinking: false, timeoutSeconds: 1,
    })).toEqual({ outcome: 'timeout', reason: 'timeout', cursor: expect.objectContaining({ sequence: expect.any(Number) }) })
    expect(await service.callTool(credential.token, 'wait_for_chatluna_state', {
      cursor: afterRound, botParticipantId: '20001', thinking: true, timeoutSeconds: 1,
    })).toMatchObject({ outcome: 'timeout', reason: 'timeout' })

    // 会话过滤同样生效：状态只存在于私聊，按群会话等待不会命中。
    expect(await service.callTool(credential.token, 'wait_for_chatluna_state', {
      cursor, conversationId: 'group:30001', timeoutSeconds: 1,
    })).toMatchObject({ outcome: 'timeout', reason: 'timeout' })

    await expect(service.callTool(credential.token, 'wait_for_chatluna_state', {
      cursor: { epoch: 'stale-epoch', sequence: 0 }, timeoutSeconds: 1,
    })).rejects.toMatchObject({ code: 'cursor_expired' })
  })
})

describe('MCP 空间生命周期工具', () => {
  it('标记失败只作用于运行中的空间，并停止空间内机器人', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '失败路径空间', idempotencyKey: 'fail-space-create-1',
    }) as { spaceId: string; revision: number }
    const observer = await service.callTool(credential.token, 'create_test_space', {
      name: '观察空间', idempotencyKey: 'fail-space-create-2',
    }) as { spaceId: string; revision: number }
    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'fail-space-setup-1',
      changes: [{ action: 'create-bot', data: { id: '20009', name: '空间机器人', implementation: 'napcat' } }],
    })
    // 机器人 ID 在全局运行时里只能有一个活动占用者，因此「另一个空间能不能建同 ID 的机器人」
    // 就是「前一个空间的机器人是否还在运行」这件事在工具调用入口上的可观察形态。
    const claimSameBot = (key: string) => service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: observer.spaceId,
      expectedRevision: observer.revision,
      idempotencyKey: key,
      changes: [{ action: 'create-bot', data: { id: '20009', name: '同 ID 机器人', implementation: 'napcat' } }],
    })
    await expect(claimSameBot('fail-space-claim-1')).rejects.toMatchObject({
      code: 'domain_error',
      message: '机器人 ID 已被活动场景占用：20009',
    })

    await expect(service.callTool(credential.token, 'fail_test_space', {
      spaceId: created.spaceId, idempotencyKey: 'fail-space-1',
    })).resolves.toMatchObject({ spaceId: created.spaceId, status: 'failed' })
    await expect(service.callTool(credential.token, 'get_test_space', { spaceId: created.spaceId }))
      .resolves.toMatchObject({ id: created.spaceId, status: 'failed' })
    // 空间内机器人确实停止了：同一个 ID 现在可以被另一个空间接手。
    await expect(claimSameBot('fail-space-claim-2')).resolves.toMatchObject({ revision: observer.revision + 1 })
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId, expectedRevision: 1, idempotencyKey: 'fail-space-setup-2', changes: [],
    })).rejects.toMatchObject({ code: 'space_unavailable' })

    await expect(service.callTool(credential.token, 'fail_test_space', {
      spaceId: created.spaceId, idempotencyKey: 'fail-space-2',
    })).rejects.toMatchObject({ code: 'domain_error', message: '空间当前不可修改：failed' })
  })

  it('重新激活只作用于已结束空间，并把控制权归还原 AI 控制者', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '重新激活空间', idempotencyKey: 'reactivate-create-1',
    }) as { spaceId: string; revision: number }

    await expect(service.callTool(credential.token, 'reactivate_test_space', {
      spaceId: created.spaceId, idempotencyKey: 'reactivate-running-1',
    })).rejects.toMatchObject({ code: 'domain_error', message: '只有已完成或失败的空间可以重新激活' })

    await service.callTool(credential.token, 'complete_test_space', {
      spaceId: created.spaceId, idempotencyKey: 'reactivate-complete-1',
    })
    // WebQQ 重新激活代表用户接管，测试控制端点重新激活必须归还原 AI 控制者：
    // 状态回到 running 而不是 taken-over，因此紧随其后的 MCP 修改可以成功。
    await expect(service.callTool(credential.token, 'reactivate_test_space', {
      spaceId: created.spaceId, idempotencyKey: 'reactivate-1',
    })).resolves.toMatchObject({ spaceId: created.spaceId, status: 'running' })
    await expect(service.callTool(credential.token, 'get_test_space', { spaceId: created.spaceId }))
      .resolves.toMatchObject({ status: 'running' })
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'reactivate-setup-1',
      changes: [{ action: 'create-user', data: { id: '11001', name: '重新激活后新增' } }],
    })).resolves.toMatchObject({ revision: created.revision + 1 })
  })

  it('删除后的空间不再出现在空间列表里', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)
    const removed = await service.callTool(credential.token, 'create_test_space', {
      name: '待删除空间', idempotencyKey: 'delete-create-1',
    }) as { spaceId: string }
    const kept = await service.callTool(credential.token, 'create_test_space', {
      name: '保留空间', idempotencyKey: 'delete-create-2',
    }) as { spaceId: string }

    await expect(service.callTool(credential.token, 'delete_test_space', {
      spaceId: removed.spaceId, idempotencyKey: 'delete-1',
    })).resolves.toMatchObject({ spaceId: removed.spaceId, deleted: true })

    const spaces = await service.callTool(credential.token, 'list_test_spaces', {}) as { items: Array<{ id: string }> }
    expect(spaces.items.map(({ id }) => id)).toEqual([kept.spaceId])
    await expect(service.callTool(credential.token, 'get_test_space', { spaceId: removed.spaceId }))
      .rejects.toMatchObject({ code: 'space_not_found' })
  })
})

/** 取得一次性确认令牌：破坏性操作的两步确认，`arguments` 必须与随后实际调用去除令牌后的参数逐字段一致。 */
async function prepareDestructive(
  service: SandboxMcpService,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  revision: number,
): Promise<string> {
  const prepared = await service.callTool(token, 'prepare_destructive_action', {
    ...(typeof args.spaceId === 'string' ? { spaceId: args.spaceId } : {}),
    expectedRevision: revision,
    tool,
    arguments: args,
  }) as { confirmationToken: string }
  return prepared.confirmationToken
}

describe('MCP 破坏性场景工具', () => {
  it('恢复初始场景：主场景回到默认场景，测试空间回到创建时的空白场景', async () => {
    const main = createMcpTestService(['read', 'manage'])
    const mainRevision = main.control.getSnapshot().revision
    await main.service.callTool(main.credential.token, 'apply_environment_changes', {
      expectedRevision: mainRevision,
      idempotencyKey: 'reset-main-setup-1',
      changes: [{ action: 'create-user', data: { id: '10009', name: '重置前新增' } }],
    })
    const mainConfirmation = await prepareDestructive(main.service, main.credential.token, 'reset_scene', {}, mainRevision + 1)
    await main.service.callTool(main.credential.token, 'reset_scene', { confirmationToken: mainConfirmation })
    const mainScene = await main.service.callTool(main.credential.token, 'get_scene_snapshot', {}) as {
      participants: Array<{ id: string }>
      groups: Array<{ id: string }>
    }
    expect(mainScene.participants.map(({ id }) => id)).toEqual(['10001', '10002', '10003', '20001'])
    expect(mainScene.groups.map(({ id }) => id)).toEqual(['30001'])

    const spaced = createMcpTestService(['read', 'manage'], true)
    const created = await spaced.service.callTool(spaced.credential.token, 'create_test_space', {
      idempotencyKey: 'reset-space-create-1',
    }) as { spaceId: string; revision: number }
    await spaced.service.callTool(spaced.credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'reset-space-setup-1',
      changes: [{ action: 'create-user', data: { id: '11001', name: '空间成员' } }],
    })
    const spaceConfirmation = await prepareDestructive(
      spaced.service, spaced.credential.token, 'reset_scene', { spaceId: created.spaceId }, created.revision + 1,
    )
    await spaced.service.callTool(spaced.credential.token, 'reset_scene', {
      spaceId: created.spaceId, confirmationToken: spaceConfirmation,
    })
    // 空间的初始场景是空白，不是全局默认场景：恢复后不应凭空出现默认机器人。
    await expect(spaced.service.callTool(spaced.credential.token, 'get_scene_snapshot', { spaceId: created.spaceId }))
      .resolves.toMatchObject({ participants: [], groups: [], conversations: [], messages: [] })
  })

  it('清空场景后场景确实为空', async () => {
    const { service, credential, testSpaces } = createMcpTestService(['read', 'manage'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'clear-space-create-1',
    }) as { spaceId: string; revision: number }
    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'clear-space-setup-1',
      changes: [
        { action: 'create-user', data: { id: '11001', name: '空间成员' } },
        { action: 'create-bot', data: { id: '21001', name: '空间机器人', implementation: 'napcat' } },
        { action: 'set-friendship', data: { firstId: '11001', secondId: '21001' } },
      ],
    })
    const spaceControl = testSpaces.getControl(created.spaceId)
    spaceControl.createConversationInstance({ operatorId: '11001', rootConversationId: 'private:11001:21001' })

    const confirmation = await prepareDestructive(
      service, credential.token, 'clear_scene', { spaceId: created.spaceId }, spaceControl.getSnapshot().revision,
    )
    await service.callTool(credential.token, 'clear_scene', { spaceId: created.spaceId, confirmationToken: confirmation })
    // 会话实例是独立集合，清空场景必须把它一起清掉，否则留下解析不出根会话的无主对话线。
    await expect(service.callTool(credential.token, 'get_scene_snapshot', { spaceId: created.spaceId })).resolves.toMatchObject({
      participants: [], groups: [], conversations: [], conversationInstances: [], messages: [], friendships: [], requests: [],
    })
  })

  it('导入版本化场景，导入结果与导出的场景一致', async () => {
    const { service, credential, testSpaces } = createMcpTestService(['read', 'manage'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'import-space-create-1',
    }) as { spaceId: string; revision: number }
    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: created.revision,
      idempotencyKey: 'import-space-setup-1',
      changes: [
        { action: 'create-user', data: { id: '11001', name: '导出成员' } },
        // 未启动 App 时机器人 middleware 不会收敛，sendMessage 会一直等待同步回复；停用后仍会写入消息。
        { action: 'create-bot', data: { id: '21001', name: '导出机器人', implementation: 'llbot', enabled: false } },
        { action: 'create-group', data: { id: '31001', name: '导出群', members: [{ participantId: '11001', role: 'owner' }, { participantId: '21001', role: 'member' }] } },
        { action: 'set-friendship', data: { firstId: '11001', secondId: '21001' } },
      ],
    })
    // 用户准备好的分支要能作为测试前置条件，因此导入导出必须把实例连同它的消息归属一起带过去。
    const spaceControl = testSpaces.getControl(created.spaceId)
    const instance = spaceControl.createConversationInstance({
      operatorId: '11001',
      rootConversationId: 'private:11001:21001',
      title: '导入前准备好的分支',
    })
    const sent = await spaceControl.sendMessage({
      operatorId: '11001',
      conversationId: instance.conversationId,
      content: '分支里的前置消息',
    })
    type Scene = {
      revision: number
      participants: Array<{ id: string }>
      groups: Array<{ id: string; members: Array<{ participantId: string }> }>
      conversations: Array<{ id: string }>
      conversationInstances: Array<{ id: string; rootConversationId: string; title: string; messageIds: string[] }>
      messages: Array<{ id: string; conversationId: string }>
      friendships: Array<{ id: string }>
    }
    const exported = await service.callTool(credential.token, 'export_scene', { spaceId: created.spaceId }) as {
      testApiVersion: number
      scene: Scene
    }

    const clearConfirmation = await prepareDestructive(
      service, credential.token, 'clear_scene', { spaceId: created.spaceId }, exported.scene.revision,
    )
    const cleared = await service.callTool(credential.token, 'clear_scene', {
      spaceId: created.spaceId, confirmationToken: clearConfirmation,
    }) as { revision: number }
    // 清空之后实例连一条都不剩，接下来恢复出来的实例只可能来自导入的文档。
    await expect(service.callTool(credential.token, 'get_scene_snapshot', { spaceId: created.spaceId }))
      .resolves.toMatchObject({ conversationInstances: [] })

    const importConfirmation = await prepareDestructive(
      service, credential.token, 'import_scene', { spaceId: created.spaceId, document: exported }, cleared.revision,
    )
    await service.callTool(credential.token, 'import_scene', {
      spaceId: created.spaceId, document: exported, confirmationToken: importConfirmation,
    })

    const restored = await service.callTool(credential.token, 'get_scene_snapshot', { spaceId: created.spaceId }) as Scene
    // 除 revision 由服务端单调递增外，导入结果与导出的场景逐字段一致。
    expect({ ...restored, revision: exported.scene.revision }).toEqual(exported.scene)
    expect(restored.revision).toBeGreaterThan(exported.scene.revision)
    // 实例的数量、归属与标题原样保留，实例里的消息仍然归属实例而不是被挪回根会话。
    expect(restored.conversationInstances).toEqual([{
      id: instance.conversationId,
      rootConversationId: 'private:11001:21001',
      title: '导入前准备好的分支',
      messageIds: [sent.messageId],
    }])
    expect(restored.messages.find(({ id }) => id === sent.messageId)?.conversationId).toBe(instance.conversationId)

    await expect(service.callTool(credential.token, 'import_scene', {
      spaceId: created.spaceId,
      document: { testApiVersion: 2, scene: exported.scene },
      confirmationToken: await prepareDestructive(
        service, credential.token, 'import_scene',
        { spaceId: created.spaceId, document: { testApiVersion: 2, scene: exported.scene } },
        restored.revision,
      ),
    })).rejects.toMatchObject({ code: 'unsupported_scene_version' })
  })

  it('三个破坏性场景操作缺少或持有无效确认令牌时都被拒绝', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)
    const created = await service.callTool(credential.token, 'create_test_space', {
      idempotencyKey: 'confirm-space-create-1',
    }) as { spaceId: string; revision: number }
    const document = await service.callTool(credential.token, 'export_scene', { spaceId: created.spaceId })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['reset_scene', { spaceId: created.spaceId }],
      ['clear_scene', { spaceId: created.spaceId }],
      ['import_scene', { spaceId: created.spaceId, document }],
    ]

    for (const [tool, args] of calls) {
      await expect(service.callTool(credential.token, tool, args))
        .rejects.toMatchObject({ code: 'invalid_arguments', message: 'confirmationToken 不能为空' })
      await expect(service.callTool(credential.token, tool, { ...args, confirmationToken: '伪造令牌' }))
        .rejects.toMatchObject({ code: 'confirmation_required', message: '破坏性操作需要有效的一次性确认令牌' })
    }

    // 场景仍然是创建时的空白场景：三次拒绝都没有产生任何副作用。
    await expect(service.callTool(credential.token, 'get_scene_snapshot', { spaceId: created.spaceId }))
      .resolves.toMatchObject({ revision: created.revision, participants: [] })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

type Cursor = { epoch: string; sequence: number }

afterEach(async () => {
  await stopMcpTestApps()
})

async function createSpace(harness: ReturnType<typeof createMcpTestService>, key: string, ids: { user: string; bot: string }) {
  const { service, credential } = harness
  const { spaceId } = await service.callTool(credential.token, 'create_test_space', { name: key, idempotencyKey: key }) as { spaceId: string }
  await service.callTool(credential.token, 'apply_environment_changes', {
    spaceId,
    expectedRevision: 0,
    idempotencyKey: `${key}-env`,
    changes: [
      { action: 'create-user', data: { id: ids.user, name: '用户' } },
      { action: 'create-bot', data: { id: ids.bot, name: '机器人' } },
      { action: 'set-friendship', data: { firstId: ids.user, secondId: ids.bot } },
    ],
  })
  return spaceId
}

async function revisionOf(harness: ReturnType<typeof createMcpTestService>, spaceId: string) {
  const snapshot = await harness.service.callTool(harness.credential.token, 'get_scene_snapshot', { spaceId }) as { revision: number }
  return snapshot.revision
}

async function prepare(harness: ReturnType<typeof createMcpTestService>, spaceId: string, tool: string, args: Record<string, unknown>) {
  const prepared = await harness.service.callTool(harness.credential.token, 'prepare_destructive_action', {
    spaceId,
    expectedRevision: await revisionOf(harness, spaceId),
    tool,
    arguments: args,
  }) as { confirmationToken: string }
  return prepared.confirmationToken
}

describe('破坏性操作只让所在空间的游标失效', () => {
  it('空间 A 清空场景后，空间 B 手里的游标与 get_server_info 游标仍可等待', async () => {
    const harness = createMcpTestService(['read', 'interact', 'manage'], true)
    const { service, credential } = harness
    const spaceA = await createSpace(harness, 'scope-a', { user: '11001', bot: '29001' })
    const spaceB = await createSpace(harness, 'scope-b', { user: '12001', bot: '29002' })
    const { cursor: shared } = await service.callTool(credential.token, 'get_server_info', {}) as { cursor: Cursor }

    const token = await prepare(harness, spaceA, 'clear_scene', { spaceId: spaceA })
    const cleared = await service.callTool(credential.token, 'clear_scene', { spaceId: spaceA, confirmationToken: token }) as { cursor: Cursor }
    expect(cleared.cursor.epoch).toBe(shared.epoch)

    await service.callTool(credential.token, 'send_message', {
      spaceId: spaceB, operatorId: '12001', conversationId: 'private:12001:29002', content: '并行空间', idempotencyKey: 'scope-b-message',
    })
    await expect(service.callTool(credential.token, 'wait_for_event', {
      spaceId: spaceB, cursor: shared, type: 'message.created', timeoutSeconds: 1,
    })).resolves.toMatchObject({ outcome: 'matched', event: { spaceId: spaceB, data: { content: '并行空间' } } })

    // 空间 A 自己在破坏性操作之前取得的游标失效，操作返回的游标继续可用。
    await expect(service.callTool(credential.token, 'wait_for_event', { spaceId: spaceA, cursor: shared, timeoutSeconds: 1 }))
      .rejects.toMatchObject({ code: 'cursor_expired', message: '事件游标早于该作用域最近一次破坏性操作' })
    await expect(service.callTool(credential.token, 'wait_for_event', { spaceId: spaceA, cursor: cleared.cursor, timeoutSeconds: 1 }))
      .resolves.toMatchObject({ outcome: 'timeout' })
  })

  it('空间 A 的破坏性操作只清掉 A 的幂等结果，B 的同键重放仍返回首次结果', async () => {
    const harness = createMcpTestService(['read', 'interact', 'manage'], true)
    const { service, credential } = harness
    const spaceA = await createSpace(harness, 'idem-a', { user: '11001', bot: '29001' })
    const spaceB = await createSpace(harness, 'idem-b', { user: '12001', bot: '29002' })
    const send = { spaceId: spaceB, operatorId: '12001', conversationId: 'private:12001:29002', content: '一次', idempotencyKey: 'idem-b-message' }
    const first = await service.callTool(credential.token, 'send_message', send) as { messageId: string }

    const token = await prepare(harness, spaceA, 'reset_scene', { spaceId: spaceA })
    await service.callTool(credential.token, 'reset_scene', { spaceId: spaceA, confirmationToken: token })

    await expect(service.callTool(credential.token, 'send_message', send)).resolves.toMatchObject({ messageId: first.messageId })
  })

  it('重置场景后版本号继续递增，重置前的版本无法再通过乐观锁', async () => {
    const harness = createMcpTestService(['read', 'interact', 'manage'], true)
    const { service, credential } = harness
    const spaceId = await createSpace(harness, 'reset-revision', { user: '11001', bot: '29001' })
    const before = await revisionOf(harness, spaceId)
    const token = await prepare(harness, spaceId, 'reset_scene', { spaceId })
    const reset = await service.callTool(credential.token, 'reset_scene', { spaceId, confirmationToken: token }) as { revision: number }
    expect(reset.revision).toBe(before + 1)
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId, expectedRevision: 0, idempotencyKey: 'stale-revision', changes: [],
    })).rejects.toMatchObject({ code: 'revision_conflict' })
  })
})

describe('确认令牌按失败原因报错', () => {
  it('参数写错时说明原因且不消耗令牌，改正后同一令牌可用，用过后不能复用', async () => {
    const harness = createMcpTestService(['read', 'manage'], true)
    const { service, credential } = harness
    const spaceId = await createSpace(harness, 'confirm-args', { user: '11001', bot: '29001' })
    const args = { spaceId, kind: 'user', id: '11001' }
    const token = await prepare(harness, spaceId, 'delete_environment_entity', args)

    await expect(service.callTool(credential.token, 'delete_environment_entity', { ...args, id: '29001', confirmationToken: token }))
      .rejects.toMatchObject({ code: 'confirmation_required', message: '调用参数与签发确认令牌时的 arguments 不一致', recovery: expect.stringContaining('令牌仍然有效') })
    await expect(service.callTool(credential.token, 'reset_scene', { spaceId, confirmationToken: token }))
      .rejects.toMatchObject({ code: 'confirmation_required', message: '确认令牌签发给 delete_environment_entity，不能用于 reset_scene' })
    await expect(service.callTool(credential.token, 'delete_environment_entity', { ...args, confirmationToken: token }))
      .resolves.toMatchObject({ revision: expect.any(Number) })
    await expect(service.callTool(credential.token, 'delete_environment_entity', { ...args, confirmationToken: token }))
      .rejects.toMatchObject({ code: 'confirmation_required', message: '破坏性操作需要有效的一次性确认令牌' })
  })

  it('签发后场景版本变化时说明令牌已作废', async () => {
    const harness = createMcpTestService(['read', 'interact', 'manage'], true)
    const { service, credential } = harness
    const spaceId = await createSpace(harness, 'confirm-revision', { user: '11001', bot: '29001' })
    const token = await prepare(harness, spaceId, 'clear_scene', { spaceId })
    await service.callTool(credential.token, 'send_message', {
      spaceId, operatorId: '11001', conversationId: 'private:11001:29001', content: '改动版本', idempotencyKey: 'confirm-revision-message',
    })
    await expect(service.callTool(credential.token, 'clear_scene', { spaceId, confirmationToken: token }))
      .rejects.toMatchObject({ code: 'confirmation_required', message: '签发确认令牌后场景版本已变化，令牌已作废' })
  })
})

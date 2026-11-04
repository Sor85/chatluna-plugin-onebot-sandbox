import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 工具参数取值的两条规则，都只在经 `service.callTool` 的完整治理路径上才观察得到。
 *
 * 一条是调用标注参数不参与业务参数指纹（ADR-0097）：`testRunId` 由注册表统一注入到每个工具上，
 * 一个鼓励普遍携带的标注键此前会改变确认令牌与幂等键的判定结果。另一条是数值参数类型不对时显式
 * 失败（ADR-0098）：此前经 `Number(...)` 变成 NaN 后被静默放行，让调用退化成另一种行为。
 *
 * 两条都按「同一份调用带与不带那个参数」成对断言，因此断言对象是行为差异而不是实现细节。
 */

afterEach(async () => {
  await stopMcpTestApps()
})

async function seedUser(harness: ReturnType<typeof createMcpTestService>, id: string, key: string) {
  await harness.service.callTool(harness.credential.token, 'apply_environment_changes', {
    expectedRevision: harness.control.getSnapshot().revision,
    idempotencyKey: key,
    changes: [{ action: 'create-user', data: { id, name: '指纹用户' } }],
  })
}

describe('调用标注参数不参与业务参数指纹', () => {
  it('签发令牌时未复述 testRunId，实际调用带上它仍然确认通过', async () => {
    const harness = createMcpTestService(['read', 'manage'])
    const { service, credential, control } = harness
    await seedUser(harness, '19901', 'annotation-seed-1')
    const prepared = await service.callTool(credential.token, 'prepare_destructive_action', {
      expectedRevision: control.getSnapshot().revision,
      tool: 'delete_environment_entity',
      arguments: { kind: 'user', id: '19901' },
    }) as { confirmationToken: string }

    // 编排给每次调用都打标注是本端点鼓励的用法，它不该让一次已经签发的确认失效。
    await expect(service.callTool(credential.token, 'delete_environment_entity', {
      kind: 'user',
      id: '19901',
      confirmationToken: prepared.confirmationToken,
      testRunId: 'run-1',
    })).resolves.toMatchObject({ revision: expect.any(Number) })
    expect(control.getSnapshot().participants.some(({ id }) => id === '19901')).toBe(false)
  })

  it('业务参数真的不一致时确认照旧失败', async () => {
    const harness = createMcpTestService(['read', 'manage'])
    const { service, credential, control } = harness
    await seedUser(harness, '19902', 'annotation-seed-2')
    const prepared = await service.callTool(credential.token, 'prepare_destructive_action', {
      expectedRevision: control.getSnapshot().revision,
      tool: 'delete_environment_entity',
      arguments: { kind: 'user', id: '19902' },
    }) as { confirmationToken: string }

    await expect(service.callTool(credential.token, 'delete_environment_entity', {
      kind: 'user',
      id: '10001',
      confirmationToken: prepared.confirmationToken,
    })).rejects.toMatchObject({ code: 'confirmation_required' })
  })

  it('同一幂等键换一个 testRunId 重放仍返回首次结果', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)

    const first = await service.callTool(credential.token, 'create_test_space', {
      name: '标注空间',
      idempotencyKey: 'annotation-replay',
      testRunId: 'run-1',
    }) as { spaceId: string }
    const replayed = await service.callTool(credential.token, 'create_test_space', {
      name: '标注空间',
      idempotencyKey: 'annotation-replay',
      testRunId: 'run-2',
    }) as { spaceId: string }

    expect(replayed.spaceId).toBe(first.spaceId)
    expect(await service.callTool(credential.token, 'list_test_spaces', {})).toMatchObject({ items: [expect.anything()] })
  })

  it('业务参数真的不同时幂等冲突照旧报出', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'], true)

    await service.callTool(credential.token, 'create_test_space', { name: '甲', idempotencyKey: 'annotation-conflict', testRunId: 'run-1' })
    await expect(service.callTool(credential.token, 'create_test_space', {
      name: '乙',
      idempotencyKey: 'annotation-conflict',
      testRunId: 'run-1',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})

describe('数值参数类型不对时显式失败', () => {
  it('分页条数传字符串时报参数错误，而不是静默返回空列表', async () => {
    const { service, credential, control } = createMcpTestService(['read'])
    const operatorId = control.getSnapshot().participants.find(({ kind }) => kind === 'user')!.id

    const healthy = await service.callTool(credential.token, 'list_conversations', { operatorId }) as { items: unknown[] }
    expect(healthy.items.length).toBeGreaterThan(0)

    await expect(service.callTool(credential.token, 'list_conversations', { operatorId, limit: '五十' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(service.callTool(credential.token, 'list_conversations', { operatorId, offset: null }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(service.callTool(credential.token, 'get_conversation', { operatorId, conversationId: 'group:30001', messageLimit: '五十' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('越界的分页条数按声明的上下限收敛，不当成失败', async () => {
    const { service, credential, control } = createMcpTestService(['read'])
    const operatorId = control.getSnapshot().participants.find(({ kind }) => kind === 'user')!.id

    // 上下限已经写在 inputSchema 里，收敛之后拿到的是一页真实数据，不会得出错的结论。
    const page = await service.callTool(credential.token, 'list_conversations', { operatorId, limit: 10_000 }) as { items: unknown[] }
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('等待超时与静默期传字符串时立刻报参数错误，而不是立刻超时', async () => {
    const { service, credential } = createMcpTestService(['read', 'interact'])
    const { cursor } = await service.callTool(credential.token, 'get_server_info', {}) as { cursor: unknown }

    await expect(service.callTool(credential.token, 'wait_for_event', { cursor, timeoutSeconds: '三十' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(service.callTool(credential.token, 'wait_for_message', { cursor, timeoutSeconds: 1, settleSeconds: '五' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('事件游标序号传字符串时报参数错误，而不是等到超时', async () => {
    const { service, credential } = createMcpTestService(['read', 'interact'])
    const { cursor } = await service.callTool(credential.token, 'get_server_info', {}) as { cursor: { epoch: string } }

    await expect(service.callTool(credential.token, 'wait_for_event', {
      cursor: { epoch: cursor.epoch, sequence: '零' },
      timeoutSeconds: 1,
    })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('场景版本传字符串时报参数错误，而不是伪装成版本冲突', async () => {
    const { service, credential } = createMcpTestService(['read', 'manage'])

    // 报成 revision_conflict 会把调用方推向「重读快照再重试」这条永远走不通的路。
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: '第一版',
      idempotencyKey: 'numeric-revision',
      changes: [],
    })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('调试记录与模型请求记录的每页条数传字符串时同样报参数错误', async () => {
    const { service, credential } = createMcpTestService(['read', 'debug'])

    // 分页游标本身是字符串，不再有可拼错成非数值的分页参数；两族记录页剩下的数值参数就是每页条数。
    await expect(service.callTool(credential.token, 'list_onebot_debug_records', { limit: '第三条' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(service.callTool(credential.token, 'list_model_request_records', { scope: 'main', limit: '五十' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })
})

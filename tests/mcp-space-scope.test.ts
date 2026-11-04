import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 空间作用域必须贯穿事件流与错误信封。
 *
 * 两处缺陷是同一个错误的两种形态：`handle_request` 转调好友/群操作时重新拼参数对象丢了
 * `spaceId`，事件因此写入 `spaceId: undefined` 而 `wait_for_event` 按严格相等过滤；错误
 * 信封的 `revision` 恒读主场景，测试空间里的失败会报错的基线。两者都只在测试空间里可见，
 * 主场景路径正常，因此用例必须构造真实的测试空间与真实的申请审批流程。
 */

afterEach(async () => {
  await stopMcpTestApps()
})

/** 建一个带两名用户的测试空间，返回空间与当前版本。 */
async function createSpaceWithUsers(prefix: string) {
  const harness = createMcpTestService(['read', 'interact', 'manage'], true)
  const { service, credential } = harness
  const space = await service.callTool(credential.token, 'create_test_space', {
    name: '空间作用域',
    idempotencyKey: `${prefix}-space`,
  }) as { spaceId: string; revision: number }
  const applied = await service.callTool(credential.token, 'apply_environment_changes', {
    spaceId: space.spaceId,
    expectedRevision: space.revision,
    idempotencyKey: `${prefix}-env`,
    changes: [
      { action: 'create-user', data: { id: '11001', name: '申请人' } },
      { action: 'create-user', data: { id: '11002', name: '审批人' } },
      { action: 'create-group', data: { id: '31001', name: '审批群', members: [{ participantId: '11002', role: 'owner' }] } },
    ],
  }) as { revision: number }
  return { ...harness, spaceId: space.spaceId, revision: applied.revision }
}

describe('MCP 空间作用域', () => {
  it('在测试空间里用 handle_request 批准好友申请后可等待 friend.action', async () => {
    const { service, credential, spaceId } = await createSpaceWithUsers('friend-scope')
    const request = await service.callTool(credential.token, 'perform_friend_action', {
      spaceId,
      operatorId: '11001',
      action: 'request',
      targetId: '11002',
      idempotencyKey: 'friend-scope-request',
    }) as { requestId: string }
    // 游标必须取在审批之前：审批产生的事件要落在游标之后才可等待。
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'handle_request', {
      spaceId,
      operatorId: '11002',
      requestId: request.requestId,
      approve: true,
      idempotencyKey: 'friend-scope-handle',
    })

    await expect(service.callTool(credential.token, 'wait_for_event', {
      spaceId,
      cursor,
      type: 'friend.action',
      timeoutSeconds: 1,
    })).resolves.toMatchObject({
      outcome: 'matched',
      event: { spaceId, type: 'friend.action', data: { action: 'handle-request', approve: true } },
    })
  })

  it('在测试空间里用 handle_request 批准入群申请后可等待 group.action', async () => {
    const { service, credential, spaceId } = await createSpaceWithUsers('group-scope')
    const request = await service.callTool(credential.token, 'perform_group_action', {
      spaceId,
      operatorId: '11001',
      action: 'request-join',
      groupId: '31001',
      idempotencyKey: 'group-scope-request',
    }) as { requestId: string }
    const cursor = service.currentCursor()

    await service.callTool(credential.token, 'handle_request', {
      spaceId,
      operatorId: '11002',
      requestId: request.requestId,
      approve: true,
      idempotencyKey: 'group-scope-handle',
    })

    await expect(service.callTool(credential.token, 'wait_for_event', {
      spaceId,
      cursor,
      type: 'group.action',
      timeoutSeconds: 1,
    })).resolves.toMatchObject({
      outcome: 'matched',
      event: { spaceId, type: 'group.action', data: { action: 'handle-request', approve: true } },
    })
  })

  it('测试空间里失败的调用携带该空间的场景版本而不是主场景版本', async () => {
    const { service, credential, control, spaceId, revision } = await createSpaceWithUsers('revision-scope')
    // 探针前提：主场景与空间的版本必须不同，否则用例无法区分两者。
    expect(control.getSnapshot().revision).not.toBe(revision)

    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId,
      expectedRevision: revision + 100,
      idempotencyKey: 'revision-scope-conflict',
      changes: [],
    })).rejects.toMatchObject({ code: 'revision_conflict', revision })
  })

  it('主场景失败的调用携带主场景版本', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'manage'])

    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: control.getSnapshot().revision + 100,
      idempotencyKey: 'main-revision-conflict',
      changes: [],
    })).rejects.toMatchObject({ code: 'revision_conflict', revision: control.getSnapshot().revision })
  })
})

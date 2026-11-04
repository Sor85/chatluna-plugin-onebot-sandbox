import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxMcpService } from '../src/mcp/service'
import { SandboxModelRequestStore } from '../src/model-request'
import { SandboxTestSpaceService } from '../src/test-spaces'

const apps: App[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
})

/** 一套「控制服务 + 测试空间 + 未归属库 + 测试控制服务 + 凭证」，含一个已创建的 AI 测试空间。 */
function createHarness(spaceName = '模型请求空间') {
  const app = new App()
  apps.push(app)
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-model-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const unattributed = new SandboxModelRequestStore()
  const service = new SandboxMcpService(app, control, { dataDirectory: directory, testSpaces, unattributedModelRequests: unattributed })
  const credential = service.createCredential('调试凭证', ['read', 'manage', 'debug'])
  return { control, testSpaces, unattributed, service, credential, space: testSpaces.createSpace({ name: spaceName }) }
}

const call = (
  { service, credential }: ReturnType<typeof createHarness>,
  tool: string,
  args: Record<string, unknown>,
) => service.callTool(credential.token, tool, args)

describe('模型请求 MCP 工具', () => {
  it('按 scope 读取主环境、测试空间和未归属记录，且不能清理未归属库', async () => {
    const app = new App()
    apps.push(app)
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-model-'))
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
    const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
    const unattributed = new SandboxModelRequestStore()
    const service = new SandboxMcpService(app, control, { dataDirectory: directory, testSpaces, unattributedModelRequests: unattributed })
    const credential = service.createCredential('调试凭证', ['read', 'manage', 'debug'])
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '模型请求空间',
      idempotencyKey: 'model-request-space-1',
    }) as { spaceId: string }
    const spaceControl = testSpaces.getControl(created.spaceId)

    control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'main-model',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    const spaceRecord = spaceControl.getModelRequestStore().append({
      status: 'success', durationMs: 2, model: 'space-model',
      attribution: 'attributed', entities: { scopeId: created.spaceId },
      requestBodyAvailable: true, requestBody: { model: 'space-model', messages: [{ role: 'user', content: 'hi' }] },
      responseBodyStatus: 'complete', responseBodyFormat: 'json', responseStatus: 200,
      responseBodyRaw: JSON.stringify({ content: 'hello' }),
    })
    const lost = unattributed.append({
      status: 'error', durationMs: 3, model: 'lost-model',
      attribution: 'unattributed', entities: {}, requestBodyAvailable: false,
    })

    const mainPage = await service.callTool(credential.token, 'list_model_request_records', { scope: 'main' }) as { items: Array<{ model: string }> }
    expect(mainPage.items.map(({ model }) => model)).toEqual(['main-model'])
    // scope=space 缺 spaceId 此前静默读主环境；那会让消费者拿着主环境的记录断言某个空间。
    await expect(service.callTool(credential.token, 'list_model_request_records', { scope: 'space' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
    const allPage = await service.callTool(credential.token, 'list_model_request_records', { scope: 'all' }) as { items: Array<{ model: string }> }
    expect(allPage.items.map(({ model }) => model).sort()).toEqual(['main-model', 'space-model'])
    expect(allPage.items.some(({ model }) => model === 'lost-model')).toBe(false)
    const spacePage = await service.callTool(credential.token, 'list_model_request_records', {
      scope: 'space',
      spaceId: created.spaceId,
    }) as { items: Array<{ id: string, model: string }> }
    expect(spacePage.items).toEqual([expect.objectContaining({ id: spaceRecord.id, model: 'space-model' })])
    expect(spacePage.items[0]).not.toHaveProperty('requestBody')
    expect(spacePage.items[0]).not.toHaveProperty('responseBodyRaw')
    expect(await service.callTool(credential.token, 'get_model_request_record', {
      scope: 'space',
      spaceId: created.spaceId,
      recordId: spaceRecord.id,
    })).toMatchObject({
      id: spaceRecord.id,
      requestBody: { model: 'space-model', messages: [{ role: 'user', content: 'hi' }] },
      responseBodyStatus: 'complete',
      responseBodyFormat: 'json',
      responseStatus: 200,
      responseBodyRaw: JSON.stringify({ content: 'hello' }),
    })
    expect(await service.callTool(credential.token, 'list_model_request_records', { scope: 'unattributed' })).toMatchObject({
      items: [expect.objectContaining({ id: lost.id, model: 'lost-model' })],
    })

    // 清理工具不再接受 scope：目标由 spaceId 决定，显式传了要拒绝而不是无声忽略。
    await expect(service.callTool(credential.token, 'clear_model_request_records', { scope: 'unattributed' })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    await expect(service.callTool(credential.token, 'clear_model_request_records', { scope: 'space', spaceId: created.spaceId })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    expect(await service.callTool(credential.token, 'clear_model_request_records', { spaceId: created.spaceId })).toEqual({ cleared: 1 })
    expect((await spaceControl.getModelRequestStore().getRecords()).records).toEqual([])
    expect((await unattributed.getRecords()).records).toHaveLength(1)
  })

  it('scope=all 按记录 ID 跨全部已归属记录域读详情，并标注来源', async () => {
    const harness = createHarness()
    const mainRecord = harness.control.getModelRequestStore().append({
      status: 'success', durationMs: 1, model: 'main-model',
      attribution: 'attributed', entities: { scopeId: 'main' }, requestBodyAvailable: false,
    })
    const spaceRecord = harness.space.control.getModelRequestStore().append({
      status: 'success', durationMs: 2, model: 'space-model',
      attribution: 'attributed', entities: { scopeId: harness.space.id },
      requestBodyAvailable: true, requestBody: { model: 'space-model', messages: [{ role: 'user', content: 'hi' }] },
      responseBodyStatus: 'complete', responseBodyFormat: 'json', responseStatus: 200,
      responseBodyRaw: JSON.stringify({ content: 'hello' }),
    })

    expect(await call(harness, 'get_model_request_record', { scope: 'all', recordId: mainRecord.id })).toMatchObject({
      id: mainRecord.id,
      source: { scope: 'main', spaceId: 'main', name: '主环境' },
    })
    // 正文与显式指定该空间读到的完全一致，联邦查找只是替调用方省掉「先判断它属于哪个空间」这一步。
    const viaExplicitSpace = await call(harness, 'get_model_request_record', {
      scope: 'space', spaceId: harness.space.id, recordId: spaceRecord.id,
    }) as Record<string, unknown>
    expect(await call(harness, 'get_model_request_record', { scope: 'all', recordId: spaceRecord.id })).toEqual({
      ...viaExplicitSpace,
      source: { scope: 'space', spaceId: harness.space.id, name: '模型请求空间' },
    })
    expect(viaExplicitSpace).toMatchObject({
      requestBody: { model: 'space-model', messages: [{ role: 'user', content: 'hi' }] },
      responseBodyRaw: JSON.stringify({ content: 'hello' }),
    })
  })

  it('scope=all 的未归属记录与全部未命中都返回结构化的记录不存在', async () => {
    const harness = createHarness()
    const lost = harness.unattributed.append({
      status: 'error', durationMs: 3, model: 'lost-model',
      attribution: 'unattributed', entities: {}, requestBodyAvailable: false,
    })

    // 未归属不参与联邦查找；要读它仍必须显式指定范围。
    await expect(call(harness, 'get_model_request_record', { scope: 'all', recordId: lost.id })).rejects.toMatchObject({
      code: 'record_not_found',
    })
    expect(await call(harness, 'get_model_request_record', { scope: 'unattributed', recordId: lost.id })).toMatchObject({ id: lost.id })
    await expect(call(harness, 'get_model_request_record', { scope: 'all', recordId: '不存在的记录' })).rejects.toMatchObject({
      code: 'record_not_found',
    })
  })

  /**
   * 收拢前 scope=all 的详情用 try/catch 遍历，任何异常都被记成 record_not_found，
   * 一个记录域的持久化故障因此伪装成「记录不存在」，用户看到的是一条错误结论。
   */
  it('scope=all 遇到某个记录域的读取故障时不伪装成未命中', async () => {
    const harness = createHarness()
    const store = harness.space.control.getModelRequestStore()
    store.getRecord = () => Promise.reject(new Error('模型请求持久化不可用'))

    await expect(call(harness, 'get_model_request_record', { scope: 'all', recordId: '任意记录' })).rejects.toMatchObject({
      code: 'internal_error',
    })
  })

  it('清理类工具与调试记录列表未随详情一并放开', async () => {
    const harness = createHarness()
    harness.control.recordOneBotDebug({
      botId: '20001', implementation: 'napcat', direction: 'action',
      requestedAction: 'main-action', action: 'main-action', status: 'success', durationMs: 1,
    })
    harness.space.control.recordOneBotDebug({
      botId: '21001', implementation: 'llbot', direction: 'event',
      requestedAction: 'space-event', action: 'space-event', status: 'success', durationMs: 2,
    })

    // 联邦清理意味着一个测试凭证一次抹掉主环境与全部空间的证据，这个能力不给外部测试控制器。
    // 两个清理工具缺 spaceId 时报同一个错误码；模型请求那个另外不接受 scope，因此它照着读取工具的
    // 形状被调用时报的是参数错误，而不是把 scope 无声忽略后按 spaceId 清理。
    await expect(call(harness, 'clear_model_request_records', { scope: 'all' })).rejects.toMatchObject({ code: 'invalid_arguments' })
    for (const args of [{ scope: 'all' }, {}]) {
      await expect(call(harness, 'clear_onebot_debug_records', args)).rejects.toMatchObject({ code: 'space_id_required' })
    }
    await expect(call(harness, 'clear_model_request_records', {})).rejects.toMatchObject({ code: 'space_id_required' })
    // 调试记录的联邦列表同样不补：省略 spaceId 仍然只读主环境。
    expect(await call(harness, 'list_onebot_debug_records', {})).toMatchObject({
      items: [expect.objectContaining({ requestedAction: 'main-action' })],
    })
  })
})

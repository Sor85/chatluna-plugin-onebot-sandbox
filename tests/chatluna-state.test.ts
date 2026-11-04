import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { createDirectSession, createGroupSession, emitChatLunaEvent } from './helpers/chatluna-state-broadcast'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

async function createControl() {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx)
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  control.createBot({ id: '20002', name: '第二机器人', implementation: 'llbot', enabled: true })
  const group = control.getSnapshot().groups[0]
  control.updateGroup({
    id: group.id,
    name: group.name,
    members: [...group.members, { participantId: '20002', role: 'admin' }],
  })
  return { app, control }
}

describe('ChatLuna 多机器人对话状态', () => {
  it('同一机器人在私聊和群聊并发时分别记录状态与 Token 用量', async () => {
    const { app, control } = await createControl()
    const directSession = createDirectSession(control, '20001')
    const groupSession = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:direct', {}, {}, {}, directSession)
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:group', {}, {}, {}, groupSession)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:direct' },
      usageMetadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    })
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:group' },
      usageMetadata: { input_tokens: 21, output_tokens: 13, total_tokens: 34 },
    })

    expect(control.getChatLunaStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        botParticipantId: '20001',
        conversationId: 'private:10001:20001',
        thinking: true,
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      }),
      expect.objectContaining({
        botParticipantId: '20001',
        conversationId: 'group:30001',
        thinking: true,
        usage: { inputTokens: 21, outputTokens: 13, totalTokens: 34 },
      }),
    ]))
  })

  it('按机器人参与者和逻辑会话分别记录思考状态与 Token 用量', async () => {
    const { app, control } = await createControl()
    const firstSession = createGroupSession(control, '20001')
    const secondSession = createGroupSession(control, '20002')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:first', {}, {}, {}, firstSession)
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:second', {}, {}, {}, secondSession)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:first' },
      usageMetadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    })
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:second' },
      usageMetadata: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    })

    expect(control.getChatLunaStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        botParticipantId: '20001',
        conversationId: 'group:30001',
        thinking: true,
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      }),
      expect.objectContaining({
        botParticipantId: '20002',
        conversationId: 'group:30001',
        thinking: true,
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      }),
    ]))

    control.getVisibleSnapshot('10001')
    control.getVisibleSnapshot('20002')
    await emitChatLunaEvent(app, 'chatluna/after-chat', 'chatluna:first', {}, {}, {}, {}, firstSession)

    expect(control.getChatLunaStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ botParticipantId: '20001', conversationId: 'group:30001', thinking: false }),
      expect.objectContaining({ botParticipantId: '20002', conversationId: 'group:30001', thinking: true }),
    ]))
  })

  it('Character collect 补充已开始的 Core 同轮时保留会话映射、用量与请求引用', async () => {
    const { app, control } = await createControl()
    const firstSession = createGroupSession(control, '20001')
    const secondSession = createGroupSession(control, '20002')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:core-a', {}, {}, {}, firstSession)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:core-a' },
      usageMetadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    })
    control.recordChatLunaModelRequest('main', 'request:core-a', '20001', 'group:30001')

    // 同一 Session 的 Character 开始只是补充同一轮，不能拆掉 Core 已建立的内部会话映射和证据。
    await emitChatLunaEvent(app, 'chatluna_character/message_collect', firstSession, [])
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:core-b', {}, {}, {}, secondSession)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:core-a' },
      usageMetadata: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    })

    expect(control.getChatLunaStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        botParticipantId: '20001',
        conversationId: 'group:30001',
        thinking: true,
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      }),
      expect.objectContaining({
        botParticipantId: '20002',
        conversationId: 'group:30001',
        thinking: true,
      }),
    ]))

    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: 'A 回复' })
    await emitChatLunaEvent(app, 'chatluna/after-chat', 'chatluna:core-a', {}, { content: 'A 回复' }, {}, {}, firstSession)
    expect(control.getSnapshot().messages.at(-1)?.chatLuna).toMatchObject({
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      modelRequests: [{ scopeId: 'main', recordId: 'request:core-a' }],
    })
  })

  it('不同 Character Session 接管同目标时重建 Core 遗留状态', async () => {
    const { app, control } = await createControl()
    const coreSession = createGroupSession(control, '20001')
    const nextCharacterSession = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:stale-core', {}, {}, {}, coreSession)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:stale-core' },
      usageMetadata: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    })
    control.recordChatLunaModelRequest('main', 'request:stale-core', '20001', 'group:30001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', nextCharacterSession, [])
    expect(control.getChatLunaStates()).toEqual([
      expect.not.objectContaining({ usage: expect.anything() }),
    ])

    control.recordChatLunaModelRequest('main', 'request:next-character', '20001', 'group:30001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '新 Character 回复' })
    control.finishChatLunaCharacterTurn(nextCharacterSession)
    expect(control.getSnapshot().messages.at(-1)?.chatLuna?.modelRequests).toEqual([
      { scopeId: 'main', recordId: 'request:next-character' },
    ])
  })

  it('无法唯一确定机器人或逻辑会话时不记录或串联状态', async () => {
    const { app, control } = await createControl()
    const firstSession = createGroupSession(control, '20001')
    const secondSession = createGroupSession(control, '20002')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:shared', {}, {}, {}, firstSession)
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:shared', {}, {}, {}, secondSession)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:shared' },
      usageMetadata: { input_tokens: 99, output_tokens: 99, total_tokens: 198 },
    })
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:invalid', {}, {}, {}, {
      selfId: '10001',
      channelId: 'group:30001',
    })
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:missing' },
      usageMetadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
    })

    expect(control.getChatLunaStates()).toHaveLength(2)
    expect(control.getChatLunaStates().every(({ usage }) => usage === undefined)).toBe(true)

    await emitChatLunaEvent(app, 'chatluna/after-chat-error', new Error('测试错误'), 'chatluna:shared')
    expect(control.getChatLunaStates()).toEqual([])
  })

  it('把唯一 ChatLuna 会话的规范错误关联到同一逻辑会话最近的失败模型请求', async () => {
    const { app, control } = await createControl()
    const directSession = createDirectSession(control, '20001')
    const groupSession = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:direct', {}, {}, {}, directSession)
    control.getModelRequestStore().append({
      status: 'error',
      durationMs: 10,
      model: 'direct-model',
      attribution: 'attributed',
      entities: { conversationId: 'private:10001:20001' },
      requestBodyAvailable: true,
      responseBodyStatus: 'unavailable',
      error: { code: 'model_request_error', message: 'HTTP 500', retryable: false, traceId: 'direct-trace' },
    })
    control.getModelRequestStore().append({
      status: 'error',
      durationMs: 10,
      model: 'group-model',
      attribution: 'attributed',
      entities: { conversationId: 'group:30001' },
      requestBodyAvailable: true,
      responseBodyStatus: 'unavailable',
      error: { code: 'model_request_error', message: 'HTTP 500', retryable: false, traceId: 'group-trace' },
    })

    await emitChatLunaEvent(app, 'chatluna/after-chat-error', {
      errorCode: 103,
      message: 'API 请求失败 (103)',
      originError: new Error('provider rejected request'),
    }, 'chatluna:direct')

    // 错误归档要先查最近的失败请求再单行更新，只能在后台完成；收尾等待覆盖它。
    await control.waitForPersistence()
    expect((await control.getModelRequestStore().getRecords({ model: 'direct-model' })).records[0]).toMatchObject({
      chatlunaError: {
        code: 103,
        message: 'API 请求失败 (103)',
        originMessage: 'provider rejected request',
      },
    })
    expect((await control.getModelRequestStore().getRecords({ model: 'group-model' })).records[0]?.chatlunaError).toBeUndefined()
  })

  it('ChatLuna 会话同时映射多个机器人时不把错误串到任意模型请求', async () => {
    const { app, control } = await createControl()
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:shared-error', {}, {}, {}, createGroupSession(control, '20001'))
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:shared-error', {}, {}, {}, createGroupSession(control, '20002'))
    const request = control.getModelRequestStore().append({
      status: 'error',
      durationMs: 10,
      attribution: 'attributed',
      entities: { conversationId: 'group:30001' },
      requestBodyAvailable: true,
      responseBodyStatus: 'unavailable',
      error: { code: 'model_request_error', message: 'HTTP 500', retryable: false, traceId: 'shared-trace' },
    })

    await emitChatLunaEvent(app, 'chatluna/after-chat-error', { errorCode: 103, message: 'API 请求失败 (103)' }, 'chatluna:shared-error')

    await control.waitForPersistence()
    expect((await control.getModelRequestStore().requireRecord(request.id)).chatlunaError).toBeUndefined()
  })

  it('兼容 chatluna-character 的思考开始与结束事件', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({ botParticipantId: '20001', conversationId: 'group:30001', thinking: true }),
    ])

    await emitChatLunaEvent(app, 'chatluna_character/after-chat', { session })
    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({ botParticipantId: '20001', conversationId: 'group:30001', thinking: false }),
    ])
  })

  it('思考开始与结束都广播场景变更，让聊天页面实时显示等待态', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')
    const notifications: boolean[] = []
    control.onSceneMutation(() => {
      notifications.push(control.getChatLunaStates().some(({ thinking }) => thinking))
    })

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:group', {}, {}, {}, session)
    await emitChatLunaEvent(app, 'chatluna/after-chat', 'chatluna:group', {}, {}, {}, {}, session)

    expect(notifications).toEqual([true, false])
  })

  it('无法归属的思考事件不产生场景变更广播', async () => {
    const { app, control } = await createControl()
    let notifications = 0
    control.onSceneMutation(() => {
      notifications += 1
    })

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:invalid', {}, {}, {}, {
      selfId: '10001',
      channelId: 'group:30001',
    })

    expect(notifications).toBe(0)
  })

  it('把 chatluna-character 的思考内容与用量归档到机器人消息上', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:character' },
      usageMetadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '好的' })
    await emitChatLunaEvent(app, 'chatluna_character/after-chat', {
      session,
      lastResponseMessage: { content: '已清理的回复' },
      completionMessages: [{
        id: ['langchain_core', 'messages', 'AIMessage'],
        kwargs: { content: '<think>先确认用户意图</think>好的' },
      }],
    })

    const message = control.getSnapshot().messages.at(-1)
    expect(message).toMatchObject({
      authorId: '20001',
      chatLuna: {
        thought: '先确认用户意图',
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      },
    })
    expect(message?.chatLuna?.thoughtDurationMs).toBeGreaterThanOrEqual(0)
    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({ botParticipantId: '20001', thinking: false }),
    ])
  })

  it('成功 after-chat 后的 release 收尾幂等保留思考、用量与请求引用', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:character-success' },
      usageMetadata: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
    })
    control.recordChatLunaModelRequest('main', 'request:success', '20001', 'group:30001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '成功回复' })
    await emitChatLunaEvent(app, 'chatluna_character/after-chat', {
      session,
      lastResponseMessage: { content: '<think>成功思考</think>成功回复' },
    })
    const completedMessage = structuredClone(control.getSnapshot().messages.at(-1))
    const completedState = structuredClone(control.getChatLunaStates())

    control.finishChatLunaCharacterTurn(session)

    expect(control.getSnapshot().messages.at(-1)).toEqual(completedMessage)
    expect(control.getChatLunaStates()).toEqual(completedState)
    expect(completedMessage?.chatLuna).toMatchObject({
      thought: '成功思考',
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      modelRequests: [{ scopeId: 'main', recordId: 'request:success' }],
    })
  })

  it('失败 release 无明确本轮回复时不把证据回填到上一条机器人消息', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '上一轮回复' })

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:character-failed' },
      usageMetadata: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
    })
    control.recordChatLunaModelRequest('main', 'request:failed', '20001', 'group:30001')
    control.finishChatLunaCharacterTurn(session)

    expect(control.getSnapshot().messages.at(-1)).toMatchObject({ content: '上一轮回复' })
    expect(control.getSnapshot().messages.at(-1)?.chatLuna).toBeUndefined()
    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({
        thinking: false,
        usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
      }),
    ])
  })

  it('失败前已有部分回复时只把证据归档到本轮明确捕获的回复', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '上一轮回复' })

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:character-partial' },
      usageMetadata: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
    })
    control.recordChatLunaModelRequest('main', 'request:partial', '20001', 'group:30001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '本轮部分回复' })
    control.finishChatLunaCharacterTurn(session)

    const [previous, partial] = control.getSnapshot().messages
    expect(previous?.chatLuna).toBeUndefined()
    expect(partial).toMatchObject({
      content: '本轮部分回复',
      chatLuna: {
        thought: '',
        usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
        modelRequests: [{ scopeId: 'main', recordId: 'request:partial' }],
      },
    })
  })

  it('克隆或过期 Session 不能结束同目标后继轮', async () => {
    const { app, control } = await createControl()
    const stale = createGroupSession(control, '20001')
    const current = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', stale, [])
    await emitChatLunaEvent(app, 'chatluna_character/message_collect', current, [])
    control.recordChatLunaModelRequest('main', 'request:current', '20001', 'group:30001')

    control.finishChatLunaCharacterTurn(stale)
    control.finishChatLunaCharacterTurn({ ...current })
    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({ conversationId: 'group:30001', thinking: true }),
    ])

    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '后继轮回复' })
    control.finishChatLunaCharacterTurn(current)
    expect(control.getSnapshot().messages.at(-1)?.chatLuna?.modelRequests).toEqual([
      { scopeId: 'main', recordId: 'request:current' },
    ])
    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({ conversationId: 'group:30001', thinking: false }),
    ])
  })

  it('把本轮模型请求引用归档到每段机器人回复且多轮不串联', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:first-request', {}, {}, {}, session)
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:first-request' },
      usageMetadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    })
    control.recordChatLunaModelRequest('main', 'request:first-a', '20001', 'group:30001')
    control.recordChatLunaModelRequest('main', 'request:first-b', '20001', 'group:30001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第一轮第一段' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第一轮第二段' })
    await emitChatLunaEvent(app, 'chatluna/after-chat', 'chatluna:first-request', {}, { content: '第一轮回复' }, {}, {}, session)

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:second-request', {}, {}, {}, session)
    control.recordChatLunaModelRequest('main', 'request:second', '20001', 'group:30001')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第二轮回复' })
    await emitChatLunaEvent(app, 'chatluna/after-chat', 'chatluna:second-request', {}, { content: '第二轮回复' }, {}, {}, session)

    expect(control.getSnapshot().messages.map(({ chatLuna }) => chatLuna?.modelRequests)).toEqual([
      [
        { scopeId: 'main', recordId: 'request:first-a' },
        { scopeId: 'main', recordId: 'request:first-b' },
      ],
      [
        { scopeId: 'main', recordId: 'request:first-a' },
        { scopeId: 'main', recordId: 'request:first-b' },
      ],
      [{ scopeId: 'main', recordId: 'request:second' }],
    ])
    expect(control.getSnapshot().messages.map(({ chatLuna }) => chatLuna?.usage)).toEqual([
      undefined,
      { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      undefined,
    ])
  })

  it('多轮对话时每条机器人消息各自保留思考内容', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    for (const round of ['第一轮想法', '第二轮想法']) {
      await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
      await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: `回复 ${round}` })
      await emitChatLunaEvent(app, 'chatluna_character/after-chat', {
        session,
        lastResponseMessage: { content: `<think>${round}</think>回复` },
      })
    }

    expect(control.getSnapshot().messages.map(({ chatLuna }) => chatLuna?.thought)).toEqual(['第一轮想法', '第二轮想法'])
  })

  it('把核心 ChatLuna 的思考内容归档到机器人消息上', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:group', {}, {}, {}, session)
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '回复正文' })
    await emitChatLunaEvent(app, 'chatluna/after-chat', 'chatluna:group', {}, {
      content: '<think>核心链路思考</think>回复正文',
    }, {}, {}, session)

    expect(control.getSnapshot().messages.at(-1)?.chatLuna?.thought).toBe('核心链路思考')
  })

  it('回复不含思考内容时不写入空的思考字段', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '没有思考标签的回复' })
    await emitChatLunaEvent(app, 'chatluna_character/after-chat', {
      session,
      lastResponseMessage: { content: '没有思考标签的回复' },
    })

    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({ botParticipantId: '20001', thinking: false }),
    ])
    expect(control.getSnapshot().messages.at(-1)?.chatLuna).toBeUndefined()
  })

  it('上一轮思考因上游报错未结束时不把等待时间算进这一轮', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    // 第一轮只开始不结束，模拟 chatluna-character 遇到上游错误后不发结束事件。
    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await new Promise((resolve) => setTimeout(resolve, 60))
    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第二轮回复' })
    await emitChatLunaEvent(app, 'chatluna_character/after-chat', {
      session,
      lastResponseMessage: { content: '<think>第二轮想法</think>回复' },
    })

    const chatLuna = control.getSnapshot().messages.at(-1)?.chatLuna
    expect(chatLuna?.thought).toBe('第二轮想法')
    expect(chatLuna?.thoughtDurationMs).toBeLessThan(60)
  })

  it('chatluna-character 链路没有内部会话 ID 时仍按唯一思考状态归属 Token', async () => {
    const { app, control } = await createControl()
    const session = createGroupSession(control, '20001')

    await emitChatLunaEvent(app, 'chatluna_character/message_collect', session, [])
    await emitChatLunaEvent(app, 'chatluna/model-usage', {
      context: { conversationId: 'chatluna:character-internal' },
      usageMetadata: { input_tokens: 1197, output_tokens: 938, total_tokens: 4304 },
    })

    expect(control.getChatLunaStates()).toEqual([
      expect.objectContaining({
        botParticipantId: '20001',
        usage: { inputTokens: 1197, outputTokens: 938, totalTokens: 4304 },
      }),
    ])
  })
})

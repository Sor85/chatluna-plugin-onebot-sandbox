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

/** 模拟一轮 v2 agent。v2 的 dispatch 先发 busy 再发 `chat/receive`，用例按这个顺序调用 `busy` 与 `receive`。 */
function agentTurn(app: App, session: unknown, sessionId: string) {
  const agent = { session: { id: sessionId } }
  let stepNumber = 0
  return {
    receive: () => emitChatLunaEvent(app, 'chat/receive', session, { sessionId }),
    busy: () => emitChatLunaEvent(app, 'chatluna/agent-status', { agent, status: 'busy' }),
    idle: () => emitChatLunaEvent(app, 'chatluna/agent-status', { agent, status: 'idle' }),
    step: (options: { text?: string, usage?: { inputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, outputTokens: number, totalTokens?: number } } = {}) => {
      stepNumber += 1
      return emitChatLunaEvent(app, 'chatluna/agent-step', {
        agent,
        step: {
          content: options.text ? [{ type: 'text', text: options.text }] : [],
          toolCalls: [],
          usage: options.usage,
          trace: { attributes: { turn: 1, step: stepNumber } },
        },
      })
    },
  }
}

describe('ChatLuna v2 回合状态', () => {
  it('把 character 引擎的内心活动、用量与出处归档到本轮回复上', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')

    await turn.busy()
    await turn.receive()
    await turn.step({ text: '<think>群里在聊游戏，接一句</think><message>我也想玩</message>', usage: { inputTokens: 12, outputTokens: 5 } })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '我也想玩' })
    await turn.idle()

    expect(control.getSnapshot().messages.at(-1)?.chatLuna).toEqual({
      thought: '群里在聊游戏，接一句',
      thoughtDurationMs: expect.any(Number),
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      trace: { sessionId: 'route:a', turn: 1, step: 1 },
    })
  })

  it('只取 <think>：模型只给原生推理块时思考内容为空', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')
    const reasoningStep = (text: string) => emitChatLunaEvent(app, 'chatluna/agent-step', {
      agent: { session: { id: 'route:a' } },
      step: { content: [{ type: 'reasoning', text }, { type: 'text', text: '<message>好</message>' }], toolCalls: [] },
    })

    await turn.busy()
    await turn.receive()
    await reasoningStep('User 3 keeps sending 123.')
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第一轮' })
    await turn.idle()
    await turn.busy()
    await reasoningStep('ignored reasoning')
    await turn.step({ text: '<think>他又来了</think>' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第二轮' })
    await turn.idle()

    const messages = control.getSnapshot().messages
    expect(messages.find(({ content }) => content === '第一轮')?.chatLuna?.thought ?? '').toBe('')
    expect(messages.find(({ content }) => content === '第二轮')?.chatLuna?.thought).toBe('他又来了')
  })

  it('分段回复晚于 idle 发出时，结果只留在最后一段，前面几段只保留出处', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createDirectSession(control, '20001'), 'route:direct')

    await turn.busy()
    await turn.receive()
    await turn.step({ text: '<think>分两句说</think>', usage: { inputTokens: 3, outputTokens: 2 } })
    await turn.idle()
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: '第一句' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'private:10001:20001', content: '第二句' })

    const [first, second] = control.getSnapshot().messages.slice(-2)
    expect(first?.chatLuna).toEqual({ thought: '', trace: { sessionId: 'route:direct', turn: 1, step: 1 } })
    expect(second?.chatLuna).toEqual(expect.objectContaining({
      thought: '分两句说',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    }))
  })

  it('同一个群里的两个机器人各自记录等待态与用量', async () => {
    const { app, control } = await createControl()
    const first = agentTurn(app, createGroupSession(control, '20001'), 'route:first')
    const second = agentTurn(app, createGroupSession(control, '20002'), 'route:second')

    await first.busy()
    await second.busy()
    await first.receive()
    await second.receive()
    await first.step({ usage: { inputTokens: 12, outputTokens: 5 } })
    await second.step({ usage: { inputTokens: 20, outputTokens: 8 } })
    await first.idle()

    expect(control.getChatLunaStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ botParticipantId: '20001', conversationId: 'group:30001', thinking: false }),
      expect.objectContaining({
        botParticipantId: '20002',
        conversationId: 'group:30001',
        thinking: true,
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      }),
    ]))
  })

  it('每轮的用量只归档到该轮的回复，多轮不串联', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')

    await turn.busy()
    await turn.receive()
    await turn.step({ usage: { inputTokens: 8, outputTokens: 3 } })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第一轮回复' })
    await turn.idle()
    await turn.busy()
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第二轮回复' })
    await turn.idle()

    const messages = control.getSnapshot().messages
    expect(messages.find(({ content }) => content === '第一轮回复')?.chatLuna?.usage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 11 })
    expect(messages.find(({ content }) => content === '第二轮回复')?.chatLuna?.usage).toBeUndefined()
  })

  it('一轮多步时输入取最后一步的上下文，输出累加', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')

    await turn.busy()
    await turn.receive()
    await turn.step({ usage: { inputTokens: 1000, cacheReadTokens: 30000, outputTokens: 600 } })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '两步的回复' })
    await turn.step({ usage: { inputTokens: 1200, cacheReadTokens: 30400, outputTokens: 200 } })
    await turn.idle()

    expect(control.getSnapshot().messages.at(-1)?.chatLuna?.usage).toEqual({ inputTokens: 31600, outputTokens: 800, totalTokens: 32400 })
  })

  it('工具在这一步当中发出的回复，出处标到正在进行的这一步', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')
    const span = (name: 'chatluna/span-start' | 'chatluna/span-end', step: number) =>
      emitChatLunaEvent(app, name, { span: { spanKind: 'step', session: 'route:a', attributes: { turn: 2, step } } })

    await turn.busy()
    await turn.receive()
    await span('chatluna/span-start', 1)
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第一步里 reply 工具发的' })
    await span('chatluna/span-end', 1)
    await span('chatluna/span-start', 2)
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '第二步里 reply 工具发的' })
    await span('chatluna/span-end', 2)
    await turn.idle()
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '回合结束后渲染队列发的' })

    const traceOf = (content: string) => control.getSnapshot().messages.find((message) => message.content === content)?.chatLuna?.trace
    expect(traceOf('第一步里 reply 工具发的')).toEqual({ sessionId: 'route:a', turn: 2, step: 1 })
    expect(traceOf('第二步里 reply 工具发的')).toEqual({ sessionId: 'route:a', turn: 2, step: 2 })
    expect(traceOf('回合结束后渲染队列发的')).toEqual({ sessionId: 'route:a', turn: 2, step: 2 })
  })

  it('输入用量含缓存读写：v2 的 inputTokens 只是未命中缓存的部分', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')

    await turn.busy()
    await turn.receive()
    await turn.step({ usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20, totalTokens: 1070 } })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '命中缓存的回复' })
    await turn.idle()

    expect(control.getSnapshot().messages.at(-1)?.chatLuna?.usage).toEqual({ inputTokens: 1050, outputTokens: 20, totalTokens: 1070 })
  })

  it('回合结束后用户先发了消息，之后的机器人消息不接手上一轮的结果', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')

    await turn.busy()
    await turn.receive()
    await turn.step({ text: '<think>上一轮</think>', usage: { inputTokens: 1, outputTokens: 1 } })
    await turn.idle()
    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: 'help' })
    await control.sendMessage({ operatorId: '20001', conversationId: 'group:30001', content: '命令回复' })

    expect(control.getSnapshot().messages.at(-1)?.chatLuna).toBeUndefined()
  })

  it('等待态的开始与结束都广播场景变更，让聊天页面实时显示', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, createGroupSession(control, '20001'), 'route:a')
    const notifications: boolean[] = []
    control.onSceneMutation(() => {
      notifications.push(control.getChatLunaStates().some(({ thinking }) => thinking))
    })

    await turn.busy()
    await turn.receive()
    await turn.idle()

    expect(notifications).toEqual([true, false])
  })

  it('不属于沙盒机器人的会话不产生状态与广播', async () => {
    const { app, control } = await createControl()
    const turn = agentTurn(app, { selfId: '10001', channelId: 'group:30001' }, 'route:user')
    let notifications = 0
    control.onSceneMutation(() => {
      notifications += 1
    })

    await turn.busy()
    await turn.receive()

    expect(control.getChatLunaStates()).toEqual([])
    expect(notifications).toBe(0)
  })
})

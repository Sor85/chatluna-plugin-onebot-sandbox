import { afterEach, describe, expect, it } from 'vitest'
import { MemorySessionStore } from '@chatluna/session'
import { SandboxChatLunaModelCalls, type SandboxModelCallReader } from '../src/chatluna/model-calls'
import { editablePresetChoices, SandboxChatLunaPresets, type SandboxPresetEditor } from '../src/chatluna/presets'
import { SandboxChatLunaError } from '../src/chatluna/runtime'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import type { SandboxAppearance } from '../src/types'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

afterEach(async () => {
  await stopMcpTestApps()
})

const host = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })

const message = (id: string, role: string, content: unknown[], meta?: Record<string, unknown>) => ({
  id, role, content, source: { kind: 'test' }, ...(meta ? { meta } : {}),
})

/** 一回合两步：第一步调用工具，第二步给出回复。entry 序号就是数组下标；回合与步骤同 v2 一样从 1 开始。 */
async function sessionStore() {
  const store = new MemorySessionStore()
  const inline = 'A'.repeat(5000)
  await store.create({ sessionId: 's1', formatVersion: 1, createdAt: 0, delegationDepth: 0 } as never, [
    { n: 0, time: 0, kind: 'mark', name: 'prompt', data: {
      config: { provider: 'p', model: 'm' },
      system: '系统提示词',
      tools: [{ name: 'search', description: '搜索', parameters: { type: 'object' } }],
      turn: 1,
    } },
    { n: 1, time: 1, kind: 'message', message: message('u1', 'user', [{ type: 'text', text: '你好' }, { type: 'image', source: { type: 'data', data: inline } }]) },
    { n: 2, time: 2, kind: 'message', message: message('a1', 'assistant', [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} }], { turn: 1, step: 1 }) },
    { n: 3, time: 3, kind: 'message', message: message('t1', 'tool', [{ type: 'tool-result', toolCallId: 'c1', output: 'ok' }]) },
    { n: 4, time: 4, kind: 'message', message: message('a2', 'assistant', [{ type: 'text', text: '你好呀' }], {
      turn: 1, step: 2, usage: { inputTokens: 10, outputTokens: 2 }, finish: 'stop', raw: [{ type: 'text', text: '<think>想</think>你好呀' }],
    }) },
  ] as never)
  return store
}

describe('模型调用：读 ChatLuna 会话日志', () => {
  it('列出每一步的位置与摘要，按序号重建请求、给出响应', async () => {
    const reader = new SandboxChatLunaModelCalls(host({ session_store: await sessionStore() }))

    const calls = await reader.list('s1')
    expect(calls?.map(({ seq, turn, step, text, toolCalls }) => ({ seq, turn, step, text, toolCalls }))).toEqual([
      { seq: 2, turn: 1, step: 1, text: '', toolCalls: ['search'] },
      { seq: 4, turn: 1, step: 2, text: '你好呀', toolCalls: [] },
    ])

    const detail = await reader.get('s1', 4, { lastMessages: 2 })
    expect(detail?.request?.config).toEqual({ provider: 'p', model: 'm' })
    expect(detail?.request?.system).toBe('系统提示词')
    expect(detail?.request?.tools).toEqual([{ name: 'search', description: '搜索' }])
    expect(detail?.request?.messageCount).toBe(3)
    expect(detail?.request?.messages).toHaveLength(2)
    expect(detail?.response.raw).toEqual([{ type: 'text', text: '<think>想</think>你好呀' }])
    expect(detail?.finish).toBe('stop')

    const first = await reader.get('s1', 2, { includeToolSchemas: true })
    expect(first?.request?.tools).toEqual([{ name: 'search', description: '搜索', parameters: { type: 'object' } }])
    // 内联媒体换成占位，其余内容原样保留。
    expect(JSON.stringify(first?.request?.messages)).toContain('内联数据已省略，5000 字符')
    expect(JSON.stringify(first?.request?.messages)).toContain('你好')
  })

  it('会话不存在或不是模型调用时为空；会话存储没有加载时报不可用', async () => {
    const reader = new SandboxChatLunaModelCalls(host({ session_store: await sessionStore() }))
    expect(await reader.list('missing')).toBeUndefined()
    expect(await reader.get('s1', 1)).toBeUndefined()
    await expect(new SandboxChatLunaModelCalls(host({})).list('s1')).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('进行中的会话读 agent 自己的会话句柄', async () => {
    const store = await sessionStore()
    const agents = { get: (id: string) => (id === 's1' ? { session: { getStore: () => store } } : undefined) }
    expect(await new SandboxChatLunaModelCalls(host({ agents })).list('s1')).toHaveLength(2)
  })
})

interface FakeRecord {
  id: string
  name: string
  kind: string
  loader: string
  status: string
  origin: string
  editable: string
  revision: string
  diagnostics: unknown[]
}

function presetRuntime() {
  const record = (id: string, extra: Partial<FakeRecord> = {}): FakeRecord => ({
    id, name: id, kind: 'chat', loader: 'md', status: 'ok', origin: 'managed', editable: 'source', revision: 'r1', diagnostics: [], ...extra,
  })
  const records = new Map<string, FakeRecord>([
    ['sandbox-test-a', record('sandbox-test-a')],
    ['宁宁', record('宁宁')],
    ['其他', record('其他')],
    ['plugin-x', record('plugin-x', { origin: 'plugin', editable: 'none' })],
  ])
  const writes: string[] = []
  const presets = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    source: async (id: string) => (records.get(id)?.editable === 'source' ? { text: `# ${id}`, revision: 'r1', file: `${id}.md` } : undefined),
    listLoaders: () => [{ id: 'md', extensions: ['.md'] }],
    create: async (input: { id: string }) => {
      records.set(input.id, record(input.id))
      writes.push(`create ${input.id}`)
      return records.get(input.id)
    },
    duplicate: async (id: string, target: string) => {
      records.set(target, record(target))
      writes.push(`duplicate ${id} ${target}`)
      return records.get(target)
    },
    save: async (id: string, _text: string, revision: string | undefined) => {
      if (revision !== records.get(id)!.revision) throw Object.assign(new Error('changed'), { name: 'PresetConflictError' })
      writes.push(`save ${id}`)
      return records.get(id)
    },
    remove: async (id: string) => {
      records.delete(id)
      writes.push(`remove ${id}`)
    },
  }
  const rules = new Map<string, Record<string, unknown>>()
  const routing = {
    rules: () => [...rules.values()],
    rule: (id: string) => rules.get(id),
    save: async (input: Record<string, unknown>) => {
      rules.set(input.id as string, input)
      return input
    },
    remove: async (id: string) => {
      rules.delete(id)
    },
  }
  return { editor: new SandboxChatLunaPresets(host({ presets, routing }), ['宁宁']), records, rules, writes }
}

describe('测试预设：写权限按插件设置收窄', () => {
  it('测试预设与白名单里的预设可写，插件提供的预设只读', () => {
    const { editor } = presetRuntime()
    const writable = Object.fromEntries(editor.list().presets.map(({ id, writable }) => [id, writable]))
    expect(writable).toEqual({ 'sandbox-test-a': true, 宁宁: true, 其他: false, 'plugin-x': false })
  })

  it('新建只接受测试预设 ID，可以复制已有预设', async () => {
    const { editor, writes } = presetRuntime()
    await expect(editor.create({ id: '新预设', loader: 'md' })).rejects.toMatchObject({ reason: 'forbidden' })
    await editor.create({ id: 'sandbox-test-b', loader: 'md' })
    await editor.create({ id: 'sandbox-test-c', copyFrom: '宁宁' })
    await expect(editor.create({ id: 'sandbox-test-d', copyFrom: '不存在' })).rejects.toMatchObject({ reason: 'not_found' })
    await expect(editor.create({ id: 'sandbox-test-a', loader: 'md' })).rejects.toMatchObject({ reason: 'invalid', message: expect.stringContaining('预设已存在') })
    expect(writes).toEqual(['create sandbox-test-b', 'duplicate 宁宁 sandbox-test-c'])
  })

  it('保存按白名单放行，revision 冲突换成 conflict', async () => {
    const { editor, writes } = presetRuntime()
    await editor.save('宁宁', 'x', 'r1')
    await editor.save('sandbox-test-a', 'x', 'r1')
    await expect(editor.save('其他', 'x', 'r1')).rejects.toMatchObject({ reason: 'forbidden' })
    await expect(editor.save('plugin-x', 'x', 'r1')).rejects.toMatchObject({ reason: 'forbidden' })
    await expect(editor.save('宁宁', 'x', 'old')).rejects.toMatchObject({ reason: 'conflict' })
    expect(writes).toEqual(['save 宁宁', 'save sandbox-test-a'])
  })

  it('切换写成只命中该机器人的路由规则；删除测试预设时一并撤掉指向它的切换', async () => {
    const { editor, rules, writes } = presetRuntime()
    await editor.assign('20001', 'sandbox-test-a')
    expect(rules.get('onebot-sandbox-preset-20001')).toMatchObject({
      by: 'onebot-sandbox',
      filter: { kind: 'and', operands: [
        { kind: 'scope', field: 'platform', values: ['onebot'] },
        { kind: 'scope', field: 'self', values: ['20001'] },
      ] },
      values: { 'chat.preset': { preset: 'sandbox-test-a' } },
    })
    expect(editor.list().assignments).toEqual([{ botId: '20001', presetId: 'sandbox-test-a', ruleId: 'onebot-sandbox-preset-20001' }])

    await expect(editor.remove('宁宁')).rejects.toMatchObject({ reason: 'forbidden' })
    expect(await editor.remove('sandbox-test-a')).toEqual({ removed: 'sandbox-test-a', unassignedBots: ['20001'] })
    expect(rules.size).toBe(0)
    expect(writes).toEqual(['remove sandbox-test-a'])

    await editor.assign('20001', '宁宁')
    await editor.assign('20001', undefined)
    expect(rules.size).toBe(0)
  })
})

describe('设置页的可编辑预设选项', () => {
  it('只列出可按源文本编辑的非测试预设，已登记但不存在的预设标明后保留', () => {
    const schema = editablePresetChoices([
      { id: '宁宁', name: '宁宁', editable: 'source' },
      { id: 'cat', name: '猫娘', editable: 'source' },
      { id: 'sandbox-test-a', name: 'sandbox-test-a', editable: 'source' },
      { id: 'plugin-x', name: 'plugin-x', editable: 'none' },
    ], ['宁宁', 'gone'])
    expect(schema.type).toBe('array')
    expect(schema.meta.role).toBe('select')
    expect(schema.inner?.list?.map((item) => [item.value, item.meta.description])).toEqual([
      ['宁宁', '宁宁'],
      ['cat', '猫娘（cat）'],
      ['gone', 'gone（预设已不存在）'],
    ])
  })
})

describe('模型调用与预设工具', () => {
  const fakeModelCalls = (): SandboxModelCallReader => ({
    list: async (sessionId) => (sessionId === 's1'
      ? [{ seq: 2, turn: 1, step: 1, time: 0, text: '', toolCalls: [] }, { seq: 4, turn: 2, step: 1, time: 1, text: '好', toolCalls: [] }]
      : undefined),
    get: async (_sessionId, seq) => ({ seq, turn: seq === 2 ? 1 : 2, step: 1, time: 1, text: '好', toolCalls: [], response: { content: [] } }),
  })
  const failingPresets = (reason: SandboxChatLunaError['reason']): SandboxPresetEditor => {
    const reject = (): never => {
      throw new SandboxChatLunaError(reason, '拒绝')
    }
    const fail = async (): Promise<never> => reject()
    return { list: reject, get: fail, create: fail, save: fail, remove: fail, assign: fail }
  }

  it('按会话 ID 读最近一步；没有出处的消息与不存在的会话各报 model_call_not_found', async () => {
    const { service, credential, control } = createMcpTestService(['debug', 'interact'], false, { modelCalls: fakeModelCalls() })
    const listed = await service.callTool(credential.token, 'list_model_calls', { sessionId: 's1', limit: 1 }) as { total: number; calls: { seq: number }[]; tracePage: string }
    expect(listed).toMatchObject({ total: 2, calls: [{ seq: 4 }], tracePage: '/traces/s1' })
    expect(await service.callTool(credential.token, 'get_model_call', { sessionId: 's1' })).toMatchObject({ seq: 4, sessionId: 's1' })
    expect(await service.callTool(credential.token, 'get_model_call', { sessionId: 's1', turn: 1 })).toMatchObject({ seq: 2 })
    // v2 的步骤从 1 开始；越界按下限收敛，step 0 读的是第一步。
    expect(await service.callTool(credential.token, 'get_model_call', { sessionId: 's1', turn: 2, step: 0 })).toMatchObject({ seq: 4 })

    const { messageId } = await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '你好' })
    await expect(service.callTool(credential.token, 'get_model_call', { messageId })).rejects.toMatchObject({ code: 'model_call_not_found' })
    await expect(service.callTool(credential.token, 'list_model_calls', { sessionId: 'missing' })).rejects.toMatchObject({ code: 'model_call_not_found' })
    await expect(service.callTool(credential.token, 'list_model_calls', {})).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('领域拒绝换成稳定错误码，写预设需要环境管理权限', async () => {
    const forbidden = createMcpTestService(['read', 'manage'], false, { presets: failingPresets('forbidden') })
    await expect(forbidden.service.callTool(forbidden.credential.token, 'save_preset', { presetId: '其他', text: 'x', revision: 'r1' }))
      .rejects.toMatchObject({ code: 'preset_forbidden' })
    const conflict = createMcpTestService(['manage'], false, { presets: failingPresets('conflict') })
    await expect(conflict.service.callTool(conflict.credential.token, 'save_preset', { presetId: '宁宁', text: 'x', revision: 'r0' }))
      .rejects.toMatchObject({ code: 'revision_conflict', retryable: true })
    const unavailable = createMcpTestService(['read'], false, { presets: failingPresets('unavailable') })
    await expect(unavailable.service.callTool(unavailable.credential.token, 'list_presets', {}))
      .rejects.toMatchObject({ code: 'chatluna_unavailable' })
    await expect(unavailable.service.callTool(unavailable.credential.token, 'save_preset', { presetId: '宁宁', text: 'x', revision: 'r1' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('只能给存在的沙盒机器人切换预设', async () => {
    const { editor, rules } = presetRuntime()
    const { service, credential } = createMcpTestService(['manage'], false, { presets: editor })
    await expect(service.callTool(credential.token, 'set_bot_preset', { botId: '10001', presetId: '宁宁' }))
      .rejects.toMatchObject({ code: 'participant_not_found' })
    await service.callTool(credential.token, 'set_bot_preset', { botId: '20001', presetId: '宁宁' })
    expect([...rules.keys()]).toEqual(['onebot-sandbox-preset-20001'])
  })
})

describe('编辑机器人弹窗的预设选项', () => {
  const appearance: SandboxAppearance = { sandboxTimBubbleTail: true, sandboxIncomingBubbleStyle: 'shadow', sandboxAccentColor: '#2563eb', sandboxMarkRecalledMessages: true }
  const listen = (presets: SandboxPresetEditor) => {
    const { control } = createMcpTestService(['read'], false)
    const listeners = new Map<string, (...args: any[]) => any>()
    const registrar: SandboxConsoleRegistrar = { addEntry() {}, addListener(event, callback) { listeners.set(event, callback as never) }, broadcast() {} }
    registerConsole(registrar, control, appearance, undefined, undefined, presets)
    return listeners
  }

  it('列出预设与当前切换，切换与撤销都写路由规则，只接受存在的沙盒机器人', async () => {
    const { editor, rules } = presetRuntime()
    const listeners = listen(editor)
    expect(listeners.get('onebot-sandbox.bot-presets')?.()).toMatchObject({
      available: true,
      presets: expect.arrayContaining([{ id: '宁宁', name: '宁宁', status: 'ok' }]),
      assignments: [],
    })
    const assigned = await listeners.get('onebot-sandbox.set-bot-preset')?.({ botId: '20001', presetId: '宁宁' })
    expect(assigned.assignments).toEqual([{ botId: '20001', presetId: '宁宁', ruleId: 'onebot-sandbox-preset-20001' }])
    await expect(listeners.get('onebot-sandbox.set-bot-preset')?.({ botId: '10001', presetId: '宁宁' })).rejects.toThrow('机器人不存在')
    await expect(listeners.get('onebot-sandbox.set-bot-preset')?.({ botId: '20001', presetId: '不存在' })).rejects.toMatchObject({ reason: 'not_found' })
    expect((await listeners.get('onebot-sandbox.set-bot-preset')?.({ botId: '20001', presetId: null })).assignments).toEqual([])
    expect(rules.size).toBe(0)
  })

  it('预设服务没有加载时标成不可用而不是报错', () => {
    const listeners = listen(new SandboxChatLunaPresets(host({}), []))
    expect(listeners.get('onebot-sandbox.bot-presets')?.()).toEqual({ available: false, presets: [], assignments: [] })
  })
})

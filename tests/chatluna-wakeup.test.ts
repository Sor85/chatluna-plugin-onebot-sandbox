import { afterEach, describe, expect, it } from 'vitest'
import {
  SandboxChatLunaWakeup,
  readSandboxResponderRuntimes,
  type ChatLunaChatRuntime,
  type SandboxActivationDecider,
  type SandboxRouteIdentity,
  type SandboxRoutingRule,
  type SandboxWakeupRules,
} from '../src/chatluna/wakeup'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

afterEach(async () => {
  await stopMcpTestApps()
})

const RULE: SandboxActivationDecider = { id: 'rule', label: '规则' }
const ACTIVITY: SandboxActivationDecider = { id: 'activity', engines: ['character'] }
const JUDGE: SandboxActivationDecider = { id: 'judge', engines: ['character'] }

/** v2 解析后的规则值：各命名空间已补齐默认值，与 `binding(identity).resolution.values` 同形。 */
function resolved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'chat.engine': { id: 'agent', mode: 'normal', record: false },
    'chat.preset': { preset: '宁宁' },
    'chat.activation': {
      use: ['rule'],
      rule: {
        botNames: ['小助手'], isNickname: true, isNickNameWithContent: false, allowAtReply: true, allowQuoteReply: true,
        privateChatWithoutCommand: true, randomReplyFrequency: 0, msgCooldown: 0, ignoreSelf: true,
      },
    },
    ...overrides,
  }
}

function runtime(input: {
  values?: (identity: SandboxRouteIdentity) => Record<string, unknown>
  deciders?: SandboxActivationDecider[]
  rules?: SandboxRoutingRule[]
  nick?: Record<string, string[]>
} = {}) {
  const identities: SandboxRouteIdentity[] = []
  const chat: ChatLunaChatRuntime = {
    resolve: (identity) => {
      identities.push(identity)
      return input.values?.(identity) ?? resolved()
    },
    deciders: () => input.deciders ?? [RULE, ACTIVITY, JUDGE],
    rules: () => input.rules ?? [{ id: 'global', filter: { kind: 'true' }, values: { 'chat.activation': {} } }],
    readPresetNicknames: (id) => input.nick?.[id] ?? ['宁宁'],
  }
  return { chat, identities, reader: new SandboxChatLunaWakeup(() => ({ chat })) }
}

describe('读取 ChatLuna v2 运行时', () => {
  it('对话服务与路由服务缺一不可，预设服务缺席时只是读不到预设昵称', () => {
    const chat = { binding: () => ({ resolution: { values: resolved() } }), activationDeciders: () => [RULE] }
    const routing = { rules: () => [] }
    const host = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })
    expect(readSandboxResponderRuntimes(host({ chat }))).toEqual({})
    expect(readSandboxResponderRuntimes(host({ routing }))).toEqual({})
    const loaded = readSandboxResponderRuntimes(host({ chat, routing }))
    expect(loaded.chat?.resolve({ platform: 'onebot', selfId: '20001', isDirect: true, userId: '10001' })).toEqual(resolved())
    expect(loaded.chat?.readPresetNicknames('宁宁')).toEqual([])
    const withPresets = readSandboxResponderRuntimes(host({ chat, routing, presets: { get: () => ({ data: { nick: ['宁宁', ''] } }) } }))
    expect(withPresets.chat?.readPresetNicknames('宁宁')).toEqual(['宁宁'])
    // v1 的 chatluna 服务名在 v2 是 AI 动词服务，与回复无关，不再据它判断已加载。
    expect(readSandboxResponderRuntimes(host({ chatluna: { config: {} } }))).toEqual({})
  })

  it('没加载对话服务时说明只有 Koishi 命令会响应', () => {
    const rules = new SandboxChatLunaWakeup(() => ({})).read()
    expect(rules.loaded).toEqual([])
    expect(rules.guidance).toContain('没有加载 ChatLuna v2 的对话服务')
  })
})

describe('rule 判定器的唤醒条件', () => {
  it('默认私聊有问必答，群聊按 @、引用与昵称唤醒，昵称合并 botNames 与预设 nick', () => {
    const rules = runtime().reader.read()
    const [direct, group] = rules.scopes.map(({ responders }) => responders[0]!)
    expect(rules.loaded).toEqual(['chatluna'])
    expect(direct).toMatchObject({ status: 'responds', engine: 'agent', deciders: ['rule'], presetName: '宁宁' })
    expect(direct.conditions.map(({ kind }) => kind)).toEqual(['any-message', 'command'])
    expect(group.conditions.map(({ kind }) => kind)).toEqual(['mention', 'quote', 'nickname-prefix', 'command'])
    expect(group.nicknames).toEqual(['小助手', '宁宁'])
    expect(rules.guidance).toContain('群聊由 ChatLuna（agent 引擎，激活判定器 rule）响应')
  })

  it('消息内含昵称只在昵称开头开着时才判定，私聊关掉无需命令后与群聊共用判定', () => {
    const rule = (patch: Record<string, unknown>) => resolved({
      'chat.activation': { use: ['rule'], rule: { ...(resolved()['chat.activation'] as { rule: object }).rule, ...patch } },
    })
    const withContent = runtime({ values: () => rule({ isNickNameWithContent: true }) }).reader.read()
    expect(withContent.scopes[1]!.responders[0]!.conditions.map(({ kind }) => kind)).toContain('nickname-anywhere')
    const disabledPrefix = runtime({ values: () => rule({ isNickname: false, isNickNameWithContent: true }) }).reader.read()
    expect(disabledPrefix.scopes[1]!.responders[0]!.conditions.map(({ kind }) => kind)).not.toContain('nickname-anywhere')

    const direct = runtime({ values: () => rule({ privateChatWithoutCommand: false, randomReplyFrequency: 0.25, msgCooldown: 5000 }) }).reader.read().scopes[0]!.responders[0]!
    expect(direct.conditions.map(({ kind }) => kind)).toEqual(['mention', 'quote', 'nickname-prefix', 'random', 'command'])
    expect(direct.conditions.find(({ kind }) => kind === 'random')?.detail).toContain('25%')
    expect(direct.caveats.join('')).toContain('privateChatWithoutCommand 已关闭')
    expect(direct.caveats.join('')).toContain('msgCooldown 为 5000 毫秒')
  })
})

describe('引擎、判定器与流程设置', () => {
  it('character 引擎带上 activity 与 judge，等待发送完毕的合并方式写进注意事项', () => {
    const values = () => resolved({
      'chat.engine': { id: 'character', mode: 'normal' },
      'chat.activation': { use: ['rule', 'activity', 'judge'], rule: { botNames: [] }, activity: { chance: 0.5 } },
      'chat.merge': { mode: 'settle', quiet: 2500, max: 15000 },
      'chat.proactive': { silence: true, followUp: false, topic: false, rhythm: true },
    })
    const group = runtime({ values }).reader.read().scopes[1]!.responders[0]!
    expect(group.deciders).toEqual(['rule', 'activity', 'judge'])
    expect(group.conditions.map(({ kind }) => kind)).toEqual(['mention', 'quote', 'nickname-prefix', 'activity-score', 'model-judge', 'command'])
    expect(group.conditions.find(({ kind }) => kind === 'activity-score')?.detail).toContain('50%')
    const caveats = group.caveats.join('\n')
    expect(caveats).toContain('静默 2500 毫秒后才回复')
    expect(caveats).toContain('character 引擎')
    expect(caveats).toContain('chat.proactive 开着 silence、rhythm')
  })

  it('不适用于当前引擎或没注册的判定器被跳过，全部跳过时不会回复', () => {
    const values = () => resolved({ 'chat.activation': { use: ['activity', 'missing'] } })
    const group = runtime({ values }).reader.read().scopes[1]!.responders[0]!
    expect(group).toMatchObject({ status: 'out-of-scope', deciders: [], conditions: [] })
    expect(group.statusReason).toContain('chat.activation.use')

    const custom = runtime({
      values: () => resolved({ 'chat.activation': { use: ['rule', 'vip'] } }),
      deciders: [RULE, { id: 'vip', label: '会员优先' }],
    }).reader.read().scopes[1]!.responders[0]!
    expect(custom.conditions.find(({ kind }) => kind === 'custom-decider')?.detail).toContain('vip（会员优先）')
  })

  it('引擎关闭或静音时不列唤醒条件，只记录模式下 Koishi 命令仍然可用', () => {
    const off = runtime({ values: () => resolved({ 'chat.engine': { id: 'off', mode: 'normal' } }) }).reader.read()
    expect(off.scopes[1]!.responders[0]).toMatchObject({ status: 'out-of-scope', conditions: [] })
    expect(off.guidance).toContain('ChatLuna 不会回复：chat.engine 为 off')
    const commands = runtime({ values: () => resolved({ 'chat.engine': { id: 'agent', mode: 'commands' } }) }).reader.read()
    expect(commands.scopes[1]!.responders[0]!.conditions.map(({ kind }) => kind)).toEqual(['command'])
  })
})

describe('按调用方没给出的维度写的路由规则', () => {
  const vipRule: SandboxRoutingRule = {
    id: 'vip-group',
    name: '测试群关掉 @',
    enabled: true,
    filter: { kind: 'and', operands: [{ kind: 'group' }, { kind: 'scope', field: 'guild', values: ['30001'] }] },
    values: { 'chat.activation': { rule: { allowAtReply: false } } },
  }

  it('没给会话时标成待判定并说明要传 conversationId，给了会话就按命中结果作答', () => {
    const general = runtime({ rules: [vipRule] }).reader.read()
    expect(general.scopes[1]!.responders[0]).toMatchObject({ status: 'conditional' })
    expect(general.scopes[1]!.responders[0]!.statusReason).toContain('「测试群关掉 @」（chat.activation）')
    expect(general.scopes[1]!.responders[0]!.statusReason).toContain('conversationId')

    const targeted = runtime({ rules: [vipRule] }).reader.read([{
      conversationType: 'group', conversationKey: '30001', botId: '20001', guildId: '30001', channelId: 'group:30001', userId: '10001',
    }])
    expect(targeted.scopes[0]!.responders[0]!.status).toBe('responds')
  })

  it('停用的规则、只改无关命名空间的规则不构成待判定', () => {
    const rules = [
      { ...vipRule, enabled: false },
      { ...vipRule, id: 'model-only', values: { 'chat.model': { model: 'x' } } },
    ]
    expect(runtime({ rules }).reader.read().scopes[1]!.responders[0]!.status).toBe('responds')
  })
})

describe('get_wakeup_rules 按投递时的路由身份解析', () => {
  type WakeupResult = SandboxWakeupRules & { conversationId?: string }

  it('群聊按群号、会话 ID、机器人与发言者构造身份，会话里每个机器人一份', async () => {
    const { identities, reader } = runtime()
    const { service, credential, control } = createMcpTestService(['read'], false, { wakeup: reader })
    control.createBot({ id: '20002', name: '第二机器人', implementation: 'llbot', enabled: true })
    control.updateGroup({
      id: '30001',
      name: control.getSnapshot().groups[0]!.name,
      members: [...control.getSnapshot().groups[0]!.members, { participantId: '20002', role: 'member' }],
    })

    const rules = await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'group:30001', operatorId: '10002' }) as WakeupResult
    expect(rules.scopes.map(({ botId }) => botId)).toEqual(['20001', '20002'])
    expect(identities.slice(-2)).toEqual([
      { platform: 'onebot', selfId: '20001', isDirect: false, guildId: '30001', channelId: 'group:30001', userId: '10002' },
      { platform: 'onebot', selfId: '20002', isDirect: false, guildId: '30001', channelId: 'group:30001', userId: '10002' },
    ])

    const one = await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'group:30001', botId: '20002' }) as WakeupResult
    expect(one.scopes.map(({ botId }) => botId)).toEqual(['20002'])
    await expect(service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'group:30001', botId: '10001' }))
      .rejects.toMatchObject({ code: 'participant_not_found' })
    await expect(service.callTool(credential.token, 'get_wakeup_rules', { botId: '20001' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('私聊的发言者取会话里的普通用户，会话实例用实例自己的 ID 作频道', async () => {
    const { identities, reader } = runtime()
    const { service, credential, control } = createMcpTestService(['read'], false, { wakeup: reader })
    await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'private:10001:20001' })
    expect(identities.at(-1)).toEqual({ platform: 'onebot', selfId: '20001', isDirect: true, channelId: 'private:10001:20001', userId: '10001' })

    const instance = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })
    await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: instance.conversationId })
    expect(identities.at(-1)).toMatchObject({ guildId: '30001', channelId: instance.conversationId })
  })

  it('唤醒指引跟着 send_message 的参数说明与测试指南一起发布', async () => {
    const { reader } = runtime()
    const { service, credential } = createMcpTestService(['read'], false, { wakeup: reader })
    const guidance = reader.read().guidance
    const sendMessage = service.getCapabilityCatalog().tools.find(({ name }) => name === 'send_message')?.inputSchema as { description?: string }
    expect(sendMessage.description).toContain('cursorBefore')
    expect(sendMessage.description).toContain(guidance)
    const guide = service.readResource(credential.token, 'onebot-sandbox://guide') as { wakeup: WakeupResult }
    expect(guide.wakeup.loaded).toEqual(['chatluna'])
  })
})

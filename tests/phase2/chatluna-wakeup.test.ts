import { afterEach, describe, expect, it } from 'vitest'
import {
  SandboxChatLunaWakeup,
  readSandboxResponderRuntimes,
  type ChatLunaCharacterRuntime,
  type ChatLunaCoreRuntime,
  type SandboxResponderRuntimes,
  type SandboxWakeupReader,
  type SandboxWakeupTarget,
} from '../src/chatluna/wakeup'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 唤醒规则的断言对象是「外部测试控制器读到的那份答案」：哪个响应插件在回复、哪些方式能唤醒它、
 * 哪些陷阱会让唤醒落空。判定口径来自被测插件源码，因此这里的期望值按那份源码书写，而不是按实现回读。
 */

/** 一份形如 chatluna-character 运行时配置的假配置；只写用例关心的键，其余键走上游默认值。 */
function characterRuntime(
  config: Record<string, unknown> = {},
  nicknames: Record<string, string[]> = { CHARACTER: ['香草', '香草酱'] },
): ChatLunaCharacterRuntime {
  return {
    config: {
      defaultPreset: 'CHARACTER',
      applyPrivate: ['10001'],
      applyGroup: ['30001'],
      ...config,
    },
    readNicknames: (presetName) => nicknames[presetName] ?? [],
  }
}

function coreRuntime(config: Record<string, unknown> = {}): ChatLunaCoreRuntime {
  return { config: { botNames: ['香草'], ...config } }
}

function readRules(runtimes: SandboxResponderRuntimes, target?: SandboxWakeupTarget) {
  return new SandboxChatLunaWakeup(() => runtimes).read(target)
}

/** 某个响应插件在这次答案里的那一条，测试只关心其中一条时用它取。 */
function responderOf(runtimes: SandboxResponderRuntimes, target: SandboxWakeupTarget, responder: string) {
  const scope = readRules(runtimes, target).scopes[0]
  const entry = scope?.responders.find((item) => item.responder === responder)
  if (!entry) throw new Error(`答案里没有 ${responder}`)
  return entry
}

function conditionKinds(runtimes: SandboxResponderRuntimes, target: SandboxWakeupTarget, responder: string) {
  return responderOf(runtimes, target, responder).conditions.map(({ kind }) => kind)
}

const GROUP: SandboxWakeupTarget = { conversationType: 'group', conversationKey: '30001' }
const DIRECT: SandboxWakeupTarget = { conversationType: 'direct', conversationKey: '10001' }

describe('没有响应插件时的唤醒规则', () => {
  it('明确答「不会因为消息内容回复」，而不是给出一份空条件清单', () => {
    const rules = readRules({})

    expect(rules.loaded).toEqual([])
    // 两类会话都在，但一个响应者也没有：外部测试控制器据此知道等不到回复是环境使然。
    expect(rules.scopes.map(({ conversationType, responders }) => ({ conversationType, responders }))).toEqual([
      { conversationType: 'direct', responders: [] },
      { conversationType: 'group', responders: [] },
    ])
    expect(rules.guidance).toContain('既没有加载 ChatLuna 主功能也没有加载 chatluna-character')
  })
})

describe('ChatLuna 主功能的唤醒规则', () => {
  it('私聊默认有问必答，群聊要 @、引用、昵称或命令', () => {
    const runtimes = { chatluna: coreRuntime() }

    expect(conditionKinds(runtimes, DIRECT, 'chatluna')).toEqual(['any-message'])
    expect(conditionKinds(runtimes, GROUP, 'chatluna')).toEqual(['mention', 'quote', 'nickname-prefix', 'command'])
    expect(responderOf(runtimes, GROUP, 'chatluna')).toMatchObject({ status: 'responds', nicknames: ['香草'] })
    // 昵称条件必须带上真实昵称，否则「用昵称唤醒」这句话没法照着做。
    expect(responderOf(runtimes, GROUP, 'chatluna').conditions.at(2)?.detail).toContain('「香草」')
  })

  it('关掉「私聊无需命令」后私聊改走命令与 @，并说清不带命令的消息不会有回复', () => {
    const runtimes = { chatluna: coreRuntime({ privateChatWithoutCommand: false }) }

    expect(conditionKinds(runtimes, DIRECT, 'chatluna')).toEqual(['mention', 'quote', 'nickname-prefix', 'command'])
    expect(responderOf(runtimes, DIRECT, 'chatluna').caveats).toContain(
      'privateChatWithoutCommand 已关闭：私聊里既不带命令、也不带 @ 或昵称的消息不会有回复',
    )
  })

  it('关掉私聊回复后私聊不再列条件，群聊不受影响', () => {
    const runtimes = { chatluna: coreRuntime({ allowPrivate: false }) }
    const direct = responderOf(runtimes, DIRECT, 'chatluna')

    expect(direct).toMatchObject({ status: 'out-of-scope', conditions: [], caveats: [] })
    expect(direct.statusReason).toContain('allowPrivate')
    expect(conditionKinds(runtimes, GROUP, 'chatluna')).toContain('mention')
  })

  it('逐项开关都反映到条件清单里：昵称任意位置、随机回复、关掉 @ 与引用', () => {
    const runtimes = {
      chatluna: coreRuntime({
        allowAtReply: false,
        allowQuoteReply: false,
        isNickNameWithContent: true,
        randomReplyFrequency: 0.05,
      }),
    }

    expect(conditionKinds(runtimes, GROUP, 'chatluna'))
      .toEqual(['nickname-prefix', 'nickname-anywhere', 'random', 'command'])
    expect(responderOf(runtimes, GROUP, 'chatluna').conditions.at(2)?.detail).toContain('5%')
  })

  it('随机回复配成计算属性时说明概率随会话而定，而不是当成不会随机回复', () => {
    const runtimes = { chatluna: coreRuntime({ randomReplyFrequency: { $switch: { branches: [] } } }) }
    const group = responderOf(runtimes, GROUP, 'chatluna')

    expect(group.conditions.map(({ kind }) => kind)).not.toContain('random')
    expect(group.caveats.join('')).toContain('随机回复的实际概率随会话而定')
  })

  it('botNames 为空时点出昵称这条路走不通', () => {
    const runtimes = { chatluna: coreRuntime({ botNames: [] }) }

    expect(responderOf(runtimes, GROUP, 'chatluna').caveats).toContain('昵称唤醒已开启，但 botNames 是空的，昵称这条路走不通')
  })
})

describe('chatluna-character 的唤醒规则', () => {
  it('群聊列出 @、引用、昵称与自动触发，昵称取自当前伪装预设', () => {
    const runtimes = { character: characterRuntime() }
    const group = responderOf(runtimes, GROUP, 'chatluna-character')

    expect(group).toMatchObject({ status: 'responds', presetName: 'CHARACTER', nicknames: ['香草', '香草酱'] })
    expect(group.conditions.map(({ kind }) => kind))
      .toEqual(['mention', 'quote', 'nickname-prefix', 'message-interval', 'activity-score'])
    expect(group.conditions.at(2)?.detail).toContain('伪装预设「CHARACTER」的 nick_name：「香草」、「香草酱」')
    // 群聊默认累计 20 条自动触发一次，这是「什么都不做也会收到回复」的唯一解释。
    expect(group.conditions.at(3)?.detail).toContain('累计 20 条')
  })

  it('开启「昵称出现在任意位置」后把这条方式告诉外部测试控制器', () => {
    const runtimes = { character: characterRuntime({ globalGroupConfig: { isNickNameWithContent: true } }) }
    const group = responderOf(runtimes, GROUP, 'chatluna-character')
    const anywhere = group.conditions.find(({ kind }) => kind === 'nickname-anywhere')

    expect(anywhere?.detail).toContain('消息任意位置包含昵称')
    expect(anywhere?.detail).toContain('「香草」')
    expect(readRules(runtimes, GROUP).guidance).toContain('消息任意位置包含昵称')
  })

  it('私聊里 @ 与引用不算唤醒，这一点必须写成陷阱而不是默默漏掉', () => {
    const runtimes = { character: characterRuntime() }
    const direct = responderOf(runtimes, DIRECT, 'chatluna-character')

    expect(direct.conditions.map(({ kind }) => kind)).toEqual(['nickname-prefix', 'message-wait'])
    expect(direct.caveats).toContain('私聊里 @ 与引用不构成唤醒条件：这个插件只在群聊里判定 @ 与引用')
    // 私聊默认消息间隔为 0，因此任何消息都会在静默 10 秒后触发。
    expect(direct.conditions.at(1)?.detail).toContain('连续 10 秒没有新消息')
  })

  it('消息间隔为 0 时说清连 @ 都要先等静默，不为 0 时只有裸 @ 与纯昵称要等', () => {
    const aggregated = characterRuntime({ globalGroupConfig: { messageInterval: 0, messageWaitTime: 3 } })
    expect(responderOf({ character: aggregated }, GROUP, 'chatluna-character').caveats)
      .toContain('本会话的消息间隔是 0：@、引用与昵称都不会立刻回复，一律要等静默 3 秒')

    expect(responderOf({ character: characterRuntime() }, GROUP, 'chatluna-character').caveats.join(''))
      .toContain('只发 @机器人而不带正文')
  })

  it('关掉固定间隔触发后既没有自动触发条件，也不再有发言等待这条陷阱', () => {
    const runtimes = { character: characterRuntime({ globalGroupConfig: { enableFixedIntervalTrigger: false } }) }
    const group = responderOf(runtimes, GROUP, 'chatluna-character')

    expect(group.conditions.map(({ kind }) => kind)).toEqual(['mention', 'quote', 'nickname-prefix', 'activity-score'])
    expect(group.caveats.join('')).not.toContain('发言等待')
    expect(group.caveats.join('')).not.toContain('静默')
  })

  it('逐会话配置覆盖全局配置，昵称随该会话自己的预设变化', () => {
    const runtimes = {
      character: characterRuntime(
        {
          globalGroupConfig: { preset: 'CHARACTER', isNickname: true },
          configs: { 30001: { preset: '猫娘', isNickname: false, isNickNameWithContent: true } },
        },
        { CHARACTER: ['香草'], 猫娘: ['喵喵'] },
      ),
    }
    const group = responderOf(runtimes, GROUP, 'chatluna-character')

    expect(group).toMatchObject({ presetName: '猫娘', nicknames: ['喵喵'] })
    expect(group.conditions.map(({ kind }) => kind)).toContain('nickname-anywhere')
    expect(group.conditions.map(({ kind }) => kind)).not.toContain('nickname-prefix')
  })

  it('昵称唤醒开着但预设读不到昵称时点出这条路走不通', () => {
    const runtimes = { character: characterRuntime({}, {}) }

    expect(responderOf(runtimes, GROUP, 'chatluna-character').caveats.join(''))
      .toContain('伪装预设「CHARACTER」当前读不到昵称')
  })

  it('关键词闭嘴开着时说明命中关键词后任何方式都唤不醒', () => {
    const runtimes = { character: characterRuntime({ globalGroupConfig: { isForceMute: true, muteTime: 30 } }) }

    expect(responderOf(runtimes, GROUP, 'chatluna-character').caveats.join(''))
      .toContain('沉默 30 秒，期间任何方式都唤不醒')
  })
})

describe('chatluna-character 的白名单', () => {
  it('会话不在白名单里时明确答「不会处理这条会话」，且不给出任何唤醒条件', () => {
    const runtimes = { character: characterRuntime() }
    const outside = responderOf(runtimes, { conversationType: 'group', conversationKey: '39999' }, 'chatluna-character')

    expect(outside).toMatchObject({ status: 'out-of-scope', conditions: [], caveats: [] })
    expect(outside.statusReason).toBe('群聊白名单模式已开启，群号 39999 不在 applyGroup 里，它不会处理这条会话')
  })

  it('没指定会话时把白名单标成待判定，但仍然给出唤醒条件', () => {
    const rules = readRules({ character: characterRuntime() })
    const [direct, group] = rules.scopes
    const groupResponder = group?.responders.at(0)

    expect(direct?.conversationKey).toBeUndefined()
    expect(groupResponder).toMatchObject({ status: 'conditional' })
    expect(groupResponder?.statusReason).toContain('本会话是否在内要传 conversationId 才能判定')
    expect(groupResponder?.conditions.length).toBeGreaterThan(0)
  })

  it('关掉白名单模式后任何会话都由它处理', () => {
    const runtimes = { character: characterRuntime({ groupWhitelistMode: false }) }

    expect(responderOf(runtimes, { conversationType: 'group', conversationKey: '39999' }, 'chatluna-character'))
      .toMatchObject({ status: 'responds' })
  })
})

describe('两个响应插件同时装上时谁在回复', () => {
  it('默认由 chatluna-character 回复，ChatLuna 主功能被它整条抑制', () => {
    const runtimes = { chatluna: coreRuntime(), character: characterRuntime() }
    const core = responderOf(runtimes, GROUP, 'chatluna')

    expect(core).toMatchObject({ status: 'suppressed', conditions: [], caveats: [] })
    expect(core.statusReason).toContain('本会话由它回复而不是 ChatLuna 主功能')
    expect(responderOf(runtimes, GROUP, 'chatluna-character')).toMatchObject({ status: 'responds' })
    // 指引里两件事都要说：谁在回复，以及另一个为什么不回复。
    expect(readRules(runtimes, GROUP).guidance).toContain('群聊由 chatluna-character 响应')
    expect(readRules(runtimes, GROUP).guidance).toContain('群聊里 chatluna 不会响应')
  })

  it('会话被 chatluna-character 的白名单排除时，ChatLuna 主功能照常回复', () => {
    const runtimes = { chatluna: coreRuntime(), character: characterRuntime() }
    const outside: SandboxWakeupTarget = { conversationType: 'group', conversationKey: '39999' }

    expect(responderOf(runtimes, outside, 'chatluna')).toMatchObject({ status: 'responds' })
    expect(responderOf(runtimes, outside, 'chatluna-character')).toMatchObject({ status: 'out-of-scope' })
  })

  it('关掉「禁用 ChatLuna 主功能」后两个插件都会回复', () => {
    const runtimes = { chatluna: coreRuntime(), character: characterRuntime({ disableChatLuna: false }) }

    expect(responderOf(runtimes, GROUP, 'chatluna')).toMatchObject({ status: 'responds' })
    expect(responderOf(runtimes, DIRECT, 'chatluna')).toMatchObject({ status: 'responds' })
  })

  it('放行名单不改变答案：disableChatLuna 开着就按抑制成立作答', () => {
    const runtimes = {
      chatluna: coreRuntime(),
      character: characterRuntime({
        whiteListDisableChatLunaPrivate: ['10001'],
        whiteListDisableChatLuna: ['30001'],
      }),
    }

    // 被测插件在放行名单里另有一层动态判定，沙盒刻意不复述它：默认按抑制成立答，代价写在 module 注释里。
    for (const target of [DIRECT, GROUP]) {
      const core = responderOf(runtimes, target, 'chatluna')
      expect(core).toMatchObject({ status: 'suppressed', conditions: [], caveats: [] })
      expect(core.statusReason).toBe('chatluna-character 开着 disableChatLuna，本会话由它回复而不是 ChatLuna 主功能')
    }
  })

  it('没指定会话时抑制照样成立，不再挂一句「要传 conversationId 才能判定」', () => {
    const rules = readRules({ chatluna: coreRuntime(), character: characterRuntime() })
    const core = rules.scopes.at(1)?.responders.at(0)

    expect(rules.loaded).toEqual(['chatluna', 'chatluna-character'])
    expect(core).toMatchObject({ responder: 'chatluna', status: 'suppressed' })
    expect(core?.statusReason).not.toContain('conversationId')
    // chatluna-character 那条仍然标出白名单待判定：抑制成不成立与它收不收这条会话是两件事。
    expect(rules.scopes.at(1)?.responders.at(1)).toMatchObject({ responder: 'chatluna-character', status: 'conditional' })
  })
})

describe('解析被测响应插件的运行时', () => {
  /** 一个形如 chatluna_character 服务的假实例：配置挂在 `_config`，昵称从预设缓存里取。 */
  function characterService(nicknames: Record<string, string[]>, throws = false) {
    return {
      // 白名单模式关掉，好让「昵称读不到」这一条不被「不处理这条会话」盖住。
      _config: { defaultPreset: 'CHARACTER', groupWhitelistMode: false, privateWhitelistMode: false },
      preset: {
        getPresetForCache: (name: string, throwError: boolean) => {
          if (throws) throw new Error(`No preset found for keyword ${name}`)
          // 上游默认在预设缺失时抛 ChatLunaError，因此沙盒必须显式传 false；这里把那个参数钉住。
          expect(throwError).toBe(false)
          return nicknames[name] ? { nick_name: nicknames[name] } : undefined
        },
      },
    }
  }

  it('两个服务都在自己的上下文里取，主功能优先读运行期那份配置', () => {
    const services: Record<string, unknown> = {
      chatluna: { config: { botNames: ['旧名'] }, currentConfig: { botNames: ['新名'] } },
      chatluna_character: characterService({ CHARACTER: ['香草'] }),
    }
    const runtimes = readSandboxResponderRuntimes({ get: (name: string) => services[name] })

    expect(runtimes.chatluna?.config).toMatchObject({ botNames: ['新名'] })
    expect(runtimes.character?.readNicknames('CHARACTER')).toEqual(['香草'])
    expect(runtimes.character?.readNicknames('不存在的预设')).toEqual([])
  })

  it('自己取不到时用插件注册表里提供方的上下文取一次', () => {
    const runtimes = readSandboxResponderRuntimes({
      get: () => undefined,
      registry: {
        values: () => [
          { ctx: { get: () => undefined } },
          { ctx: { get: (name: string) => name === 'chatluna' ? { config: { botNames: ['香草'] } } : undefined } },
        ],
      },
    })

    expect(runtimes.chatluna?.config).toMatchObject({ botNames: ['香草'] })
    expect(runtimes.character).toBeUndefined()
  })

  it('形状不对或预设读取抛异常时不影响其余答案', () => {
    expect(readSandboxResponderRuntimes(undefined)).toEqual({})
    expect(readSandboxResponderRuntimes({ get: () => ({}) })).toEqual({})
    const throwing = readSandboxResponderRuntimes({
      get: (name: string) => name === 'chatluna_character' ? characterService({}, true) : undefined,
    })
    expect(throwing.character?.readNicknames('CHARACTER')).toEqual([])
    // 昵称读不到只让指引少一句话，其余唤醒条件照常给出。
    expect(new SandboxChatLunaWakeup(() => throwing).read(GROUP).scopes[0]?.responders[0]?.conditions.length)
      .toBeGreaterThan(0)
  })
})

describe('唤醒规则在测试控制端点上的出口', () => {
  afterEach(async () => {
    await stopMcpTestApps()
  })

  /** 记录被问到的会话，答案仍由真实派生给出。 */
  function createRecordingReader(runtimes: SandboxResponderRuntimes) {
    const reader = new SandboxChatLunaWakeup(() => runtimes)
    const targets: Array<SandboxWakeupTarget | undefined> = []
    const recording: SandboxWakeupReader = {
      read: (target) => {
        targets.push(target)
        return reader.read(target)
      },
    }
    return { recording, targets }
  }

  type WakeupResult = {
    conversationId?: string
    loaded: string[]
    scopes: Array<{ conversationType: string, conversationKey?: string, responders: Array<{ responder: string, status: string }> }>
    guidance: string
  }

  it('按会话解析：群聊问群号，私聊问会话里那位普通用户的账号', async () => {
    const { recording, targets } = createRecordingReader({ character: characterRuntime() })
    const { service, credential } = createMcpTestService(['read'], false, { wakeup: recording })

    const group = await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'group:30001' }) as WakeupResult
    expect(group.conversationId).toBe('group:30001')
    expect(group.scopes).toEqual([expect.objectContaining({ conversationType: 'group', conversationKey: '30001' })])
    expect(group.scopes[0]!.responders).toEqual([expect.objectContaining({ responder: 'chatluna-character', status: 'responds' })])

    await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'private:10001:20001' })
    // 默认场景的这条私聊里 10001 是普通用户、20001 是被测机器人：问的必须是发言者而不是机器人。
    expect(targets).toEqual([
      { conversationType: 'group', conversationKey: '30001' },
      { conversationType: 'direct', conversationKey: '10001' },
    ])
  })

  it('会话实例与它的根会话得到同一个会话键', async () => {
    const { recording, targets } = createRecordingReader({ character: characterRuntime() })
    const { service, credential, control } = createMcpTestService(['read'], false, { wakeup: recording })
    const instance = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })

    await service.callTool(credential.token, 'get_wakeup_rules', { conversationId: instance.conversationId })

    // 被测插件看不见会话实例这一级，因此实例问出来的规则必须与根会话一致。
    expect(targets).toEqual([{ conversationType: 'group', conversationKey: '30001' }])
  })

  it('省略会话时给出私聊与群聊两份通用规则，会话不存在时明确拒绝', async () => {
    const { recording } = createRecordingReader({ chatluna: coreRuntime() })
    const { service, credential } = createMcpTestService(['read'], false, { wakeup: recording })

    const rules = await service.callTool(credential.token, 'get_wakeup_rules', {}) as WakeupResult
    expect(rules.conversationId).toBeUndefined()
    expect(rules.scopes.map(({ conversationType, conversationKey }) => ({ conversationType, conversationKey })))
      .toEqual([{ conversationType: 'direct', conversationKey: undefined }, { conversationType: 'group', conversationKey: undefined }])

    await expect(service.callTool(credential.token, 'get_wakeup_rules', { conversationId: 'group:39999' }))
      .rejects.toMatchObject({ code: 'conversation_not_found' })
    // 传了却不是合法字符串时必须显式失败，而不是静默按「省略」返回通用规则。
    await expect(service.callTool(credential.token, 'get_wakeup_rules', { conversationId: '' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('唤醒指引跟着 send_message 的参数说明与测试指南一起发布', async () => {
    const runtimes = { character: characterRuntime({ globalGroupConfig: { isNickNameWithContent: true } }) }
    const { recording } = createRecordingReader(runtimes)
    const { service, credential } = createMcpTestService(['read'], false, { wakeup: recording })
    const guidance = readRules(runtimes).guidance

    const tools = service.getCapabilityCatalog().tools
    const sendMessage = tools.find(({ name }) => name === 'send_message')?.inputSchema as { description?: string }
    // 既保留原有的等待模式说明，也带上唤醒指引：AI 客户端只从 tools/list 学这两件事。
    expect(sendMessage.description).toContain('cursorBefore')
    expect(sendMessage.description).toContain(guidance)
    expect(sendMessage.description).toContain('消息任意位置包含昵称')
    // 注入按参数形状选点，因此不带消息正文的工具不会被塞进这段指引。
    expect(tools.find(({ name }) => name === 'get_scene_snapshot')?.inputSchema as { description?: string })
      .not.toHaveProperty('description')

    const guide = service.readResource(credential.token, 'onebot-sandbox://guide') as { wakeup: WakeupResult }
    expect(guide.wakeup.guidance).toBe(guidance)
    expect(guide.wakeup.loaded).toEqual(['chatluna-character'])
  })
})

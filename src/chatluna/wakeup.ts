import { findChatLunaRuntime, readRecord } from './runtime'

/**
 * 被测机器人的唤醒规则：外部测试控制器要怎么写这条消息，被测机器人才会回复。
 *
 * 沙盒自己不决定唤醒，决定它的是当前 Koishi 实例里装了哪个 ChatLuna 响应插件，以及那个插件此刻的
 * 配置。两个插件的判定口径完全不同（ChatLuna 主功能在群聊里看 @、引用、昵称与随机概率，私聊默认
 * 有问必答；chatluna-character 只在群聊里看 @ 与引用，两处都看伪装预设的昵称，还会按消息条数、发言
 * 等待与群活跃度自动触发），而且 chatluna-character 默认会把 ChatLuna 主功能整条抑制掉——因此「谁在
 * 响应」本身就是一条要先答出来的事实，答错了后面每一条唤醒条件都是错的。
 *
 * 本模块是这件事的唯一持有者：读被测插件的运行时配置、按会话派生当前生效的唤醒条件、把它渲染成一段
 * 可以直接放进提示词的指引。三件事不拆开，因为拆开就会出现「结构化事实说 A、指引文案说 B」这种只有
 * 消费者能发现的漂移。
 *
 * 判定沿用被测插件源码里的口径与默认值，不做保守简化：说得比实际少会让外部测试控制器白等一轮超时，
 * 说得比实际多会让它把「本来就不该回复」当成缺陷报出来。
 */

// —— 领域形状 ——

/** 决定虚拟 OneBot 机器人要不要回复的响应插件。 */
export type SandboxResponderKind = 'chatluna' | 'chatluna-character'

/**
 * 唤醒条件的种类。
 *
 * 前六种由消息本身决定，外部测试控制器可以照着构造；后三种由被测插件自己按累计消息、静默时长与群
 * 活跃度触发，控制器只能等。两类都要列出：等待类条件是「什么都不做也会收到回复」的唯一解释，漏掉它
 * 会让控制器把一条自动触发的回复误判成自己那条消息的回复。
 */
export type SandboxWakeupConditionKind =
  | 'mention'
  | 'quote'
  | 'nickname-prefix'
  | 'nickname-anywhere'
  | 'any-message'
  | 'command'
  | 'random'
  | 'message-interval'
  | 'message-wait'
  | 'activity-score'

export interface SandboxWakeupCondition {
  kind: SandboxWakeupConditionKind
  /** 照着做就能唤醒机器人的说明，带上昵称、条数、秒数与概率的真实取值。 */
  detail: string
}

/**
 * 一个响应插件在某类会话上的处理状态。
 *
 * `conditional` 不是「说不清」的兜底，它只对应一件确定的事：chatluna-character 的白名单按**会话键**判定，
 * 没指定会话时无从判定它收不收这条会话。把这一态压成 `responds` 或 `out-of-scope` 都是在替被测插件猜，
 * 而外部测试控制器据此写出的等待会超时。`suppressed` 反过来不留余地：`disableChatLuna` 开着就按抑制成立
 * 作答（见 {@link readCoreSuppression}）。
 */
export type SandboxResponderStatus = 'responds' | 'conditional' | 'suppressed' | 'out-of-scope'

export interface SandboxResponderWakeup {
  responder: SandboxResponderKind
  status: SandboxResponderStatus
  /** 非 `responds` 时说明原因，`conditional` 说明还差哪一个判定。 */
  statusReason?: string
  /** 昵称唤醒用的字面量：ChatLuna 主功能取 `botNames`，chatluna-character 取伪装预设的 `nick_name`。 */
  nicknames: string[]
  /** chatluna-character 的昵称来自哪一个伪装预设。 */
  presetName?: string
  conditions: SandboxWakeupCondition[]
  /** 会让唤醒落空的已知陷阱。 */
  caveats: string[]
}

export interface SandboxWakeupScope {
  conversationType: 'direct' | 'group'
  /** 被测插件归档这类会话用的键：群聊是群号，私聊是发言者账号；没指定会话时缺席。 */
  conversationKey?: string
  responders: SandboxResponderWakeup[]
}

export interface SandboxWakeupRules {
  /** 当前已加载的响应插件，按 {@link SandboxResponderKind} 的顺序。 */
  loaded: SandboxResponderKind[]
  scopes: SandboxWakeupScope[]
  /** 可以直接放进提示词的指引，与 `scopes` 派生自同一次读取。 */
  guidance: string
}

export interface SandboxWakeupTarget {
  conversationType: 'direct' | 'group'
  conversationKey?: string
}

/** 唤醒规则的读取口：装配注入读被测运行时的实现，测试注入假运行时。 */
export interface SandboxWakeupReader {
  /** 省略 `target` 时同时给出私聊与群聊两份通用规则。 */
  read(target?: SandboxWakeupTarget): SandboxWakeupRules
}

// —— 被测运行时 ——

/** 被测 ChatLuna 主功能运行时里沙盒真正用到的那一小块。 */
export interface ChatLunaCoreRuntime {
  config: Record<string, unknown>
}

/** 被测 chatluna-character 运行时里沙盒真正用到的那一小块。 */
export interface ChatLunaCharacterRuntime {
  config: Record<string, unknown>
  /** 按伪装预设名取它配置的昵称；预设没加载或没配昵称时是空数组。 */
  readNicknames(presetName: string): string[]
}

export interface SandboxResponderRuntimes {
  chatluna?: ChatLunaCoreRuntime
  character?: ChatLunaCharacterRuntime
}

const CHATLUNA_SERVICE = 'chatluna'
const CHARACTER_SERVICE = 'chatluna_character'

/**
 * 从一个 Koishi 上下文解析两个响应插件的运行时。
 *
 * 读运行时而不是读 Koishi 配置文件：配置页上的值与插件此刻真正在用的值可以不同（重载中、被别的插件
 * 改写过），而唤醒规则要答的是「现在发一条消息会怎样」。
 */
export function readSandboxResponderRuntimes(host: unknown): SandboxResponderRuntimes {
  const chatluna = findChatLunaRuntime(host, CHATLUNA_SERVICE, readCoreRuntime)
  const character = findChatLunaRuntime(host, CHARACTER_SERVICE, readCharacterRuntime)
  return { ...(chatluna ? { chatluna } : {}), ...(character ? { character } : {}) }
}

function readCoreRuntime(service: Record<string, unknown>): ChatLunaCoreRuntime | undefined {
  // currentConfig 是运行期被改写的那一份（切换默认预设会写进它），因此优先读它。
  const config = readRecord(service.currentConfig) ?? readRecord(service.config)
  return config ? { config } : undefined
}

function readCharacterRuntime(service: Record<string, unknown>): ChatLunaCharacterRuntime | undefined {
  const config = readRecord(service._config) ?? readRecord(service.config)
  if (!config) return undefined
  return { config, readNicknames: (presetName) => readPresetNicknames(service.preset, presetName) }
}

/**
 * 从被测插件自己的预设缓存里读昵称。
 *
 * 读缓存而不是读预设文件：昵称要的是「这条会话此刻实际生效的那一份」，被测插件的缓存就是权威副本，
 * 而从文件反推哪个文件是哪个预设名会引入第二份解析。`throwError` 显式传 false——上游默认在预设缺失时
 * 抛 ChatLunaError，而读不到昵称只该让指引少一句话，不该让整次唤醒规则读取失败。
 */
function readPresetNicknames(preset: unknown, presetName: string): string[] {
  const holder = readRecord(preset)
  const read = holder?.getPresetForCache
  if (typeof read !== 'function') return []
  try {
    const template = readRecord((read as (name: string, throwError: boolean) => unknown).call(holder, presetName, false))
    return readStrings(template?.nick_name)
  } catch {
    // 上游随时可能改成无条件抛；读不到昵称时按「没有昵称」继续，其余唤醒条件照常给出。
    return []
  }
}

// —— 读取器 ——

/** 没指定会话时要答的两类会话。两个插件的配置都按这一维分开，因此不存在「不分会话种类」的答案。 */
const ALL_TARGETS: readonly SandboxWakeupTarget[] = [
  { conversationType: 'direct' },
  { conversationType: 'group' },
]

export class SandboxChatLunaWakeup implements SandboxWakeupReader {
  /** 运行时每次现取：被测插件可以随时重载，持有引用会让规则停在重载前的那一份配置上。 */
  constructor(private readonly resolveRuntimes: () => SandboxResponderRuntimes) {}

  read(target?: SandboxWakeupTarget): SandboxWakeupRules {
    const { chatluna, character } = this.resolveRuntimes()
    const scopes = (target ? [target] : ALL_TARGETS).map((scope): SandboxWakeupScope => ({
      conversationType: scope.conversationType,
      ...(scope.conversationKey ? { conversationKey: scope.conversationKey } : {}),
      // ChatLuna 主功能在前：它的状态要用 chatluna-character 的配置才能答（默认被后者整条抑制），
      // 因此两个运行时都传进去，而不是让调用方自己去拼这层关系。
      responders: [
        ...(chatluna ? [readCoreWakeup(chatluna, scope, character)] : []),
        ...(character ? [readCharacterWakeup(character, scope)] : []),
      ],
    }))
    return {
      loaded: [
        ...(chatluna ? ['chatluna' as const] : []),
        ...(character ? ['chatluna-character' as const] : []),
      ],
      scopes,
      guidance: describeWakeupGuidance(scopes),
    }
  }
}

// —— ChatLuna 主功能 ——

/**
 * ChatLuna 主功能的唤醒判定，口径取自它的 `allow_reply` 中间件。
 *
 * 私聊在 `allowPrivate` 成立且（带命令或 `privateChatWithoutCommand`）时提前放行：开着「无需命令」时
 * 私聊有问必答，后面四项判定根本走不到；关掉它时私聊反而与群聊走同一份判定，因此这里是「有问必答」
 * 与「共用判定」两条路，而不是私聊与群聊各写一份。
 */
function readCoreWakeup(
  runtime: ChatLunaCoreRuntime,
  target: SandboxWakeupTarget,
  character: ChatLunaCharacterRuntime | undefined,
): SandboxResponderWakeup {
  const direct = target.conversationType === 'direct'
  const config = runtime.config
  const nicknames = readStrings(config.botNames)
  const source = describeNicknames(nicknames, 'botNames')
  const byPrefix = readFlag(config.isNickname, true)
  const inContent = readFlag(config.isNickNameWithContent, false)
  const conditions: SandboxWakeupCondition[] = []
  const caveats: string[] = []
  if (direct && readFlag(config.privateChatWithoutCommand, true)) {
    conditions.push({ kind: 'any-message', detail: '私聊里任何一条消息都会触发，不必 @ 也不必带昵称（privateChatWithoutCommand 已开启）' })
  } else {
    if (readFlag(config.allowAtReply, true)) conditions.push({ kind: 'mention', detail: '在 content 里带 `<at id="机器人ID"/>`' })
    if (readFlag(config.allowQuoteReply, true)) conditions.push({ kind: 'quote', detail: '用 replyToMessageId 引用机器人自己发过的消息' })
    if (byPrefix) conditions.push({ kind: 'nickname-prefix', detail: `消息以昵称开头${source}` })
    if (inContent) conditions.push({ kind: 'nickname-anywhere', detail: `消息任意位置包含昵称${source}` })
    const random = readPercent(config.randomReplyFrequency)
    if (random === undefined) caveats.push('randomReplyFrequency 是按会话求值的 Koishi 计算属性，随机回复的实际概率随会话而定')
    else if (random > 0) conditions.push({ kind: 'random', detail: `每条消息有 ${formatPercent(random)} 概率被随机回复（randomReplyFrequency）` })
    conditions.push({
      kind: 'command',
      detail: direct
        ? '直接用 ChatLuna 命令，例如 `chatluna.chat 你好`'
        : '用 ChatLuna 命令，群聊里通常要先 @ 机器人，例如 `<at id="机器人ID"/> chatluna.chat 你好`',
    })
    if (direct) caveats.push('privateChatWithoutCommand 已关闭：私聊里既不带命令、也不带 @ 或昵称的消息不会有回复')
    if (!nicknames.length && (byPrefix || inContent)) caveats.push('昵称唤醒已开启，但 botNames 是空的，昵称这条路走不通')
  }
  const gate = direct && !readFlag(config.allowPrivate, true)
    ? { status: 'out-of-scope' as const, reason: 'ChatLuna 主功能的私聊回复已被 allowPrivate 关闭' }
    : readCoreSuppression(character, target)
  // 两种 gate 都是「这条会话上它不会回复」，因此一条唤醒条件都不列：那份清单会被读成「照着做就能唤醒」。
  const silent = gate !== undefined
  return {
    responder: 'chatluna',
    status: gate?.status ?? 'responds',
    ...(gate ? { statusReason: gate.reason } : {}),
    nicknames,
    conditions: silent ? [] : conditions,
    caveats: silent ? [] : caveats,
  }
}

/**
 * chatluna-character 有没有把 ChatLuna 主功能拦下来。
 *
 * 口径取自它的 `chatluna/before-check-sender` 拦截器，但**只取主干**：`disableChatLuna` 开着就按抑制成立
 * 作答，不再复述那两条放行名单，也不复述群聊放行由它按最近几条消息做的动态判定。这是一次刻意的取舍——
 * 复述那几层的代价是每条答案都要挂一句「要传 conversationId 才能判定」，连不带会话的通用规则都被它撑长，
 * 而 `disableChatLuna` 默认开启、放行名单默认为空，主干覆盖的正是几乎全部真实部署。代价写明：把某个会话
 * 加进 `whiteListDisableChatLuna` 之后，沙盒仍然报「已被抑制」，那时要以被测插件的实际行为为准。
 *
 * 保留的唯一一层是白名单：会话不在 chatluna-character 的处理范围里时它连消息都收不到，也就不去拦，此时
 * 抑制根本不发生。这一层不是「关于 disableChatLuna 的额外判定」，而是「谁在响应」本身——去掉它会让同一份
 * 答案自相矛盾：一边说 chatluna-character 不处理这条会话，一边说 ChatLuna 主功能被它抑制。
 */
function readCoreSuppression(
  character: ChatLunaCharacterRuntime | undefined,
  target: SandboxWakeupTarget,
): { status: 'suppressed', reason: string } | undefined {
  if (!character) return undefined
  if (readCharacterMembership(character.config, target)?.status === 'out-of-scope') return undefined
  if (!readFlag(character.config.disableChatLuna, true)) return undefined
  return { status: 'suppressed', reason: 'chatluna-character 开着 disableChatLuna，本会话由它回复而不是 ChatLuna 主功能' }
}

// —— chatluna-character ——

/**
 * chatluna-character 的唤醒判定，口径取自它的消息过滤器。
 *
 * 与 ChatLuna 主功能有三处关键差异，混淆任何一处都会让外部测试控制器白等：@ 与引用只在群聊里判定，
 * 私聊两者都不算唤醒；昵称取伪装预设的 `nick_name` 而不是插件配置里的机器人名；除了消息内容，它还会
 * 按累计条数、发言等待与群活跃度自己触发，也就是「什么都不做也可能收到回复」。
 */
function readCharacterWakeup(runtime: ChatLunaCharacterRuntime, target: SandboxWakeupTarget): SandboxResponderWakeup {
  const direct = target.conversationType === 'direct'
  const config = readCharacterScopeConfig(runtime.config, target)
  const presetName = readString(config.preset) ?? readString(runtime.config.defaultPreset)
  const nicknames = presetName ? runtime.readNicknames(presetName) : []
  const source = describeNicknames(nicknames, `伪装预设${presetName ? `「${presetName}」` : ''}的 nick_name`)
  const byPrefix = readFlag(config.isNickname, true)
  const inContent = readFlag(config.isNickNameWithContent, false)
  const intervalEnabled = readFlag(config.enableFixedIntervalTrigger, true)
  // 默认值照抄上游 schema：私聊 0（改按发言等待聚合触发）、群聊 20。
  const interval = readCount(config.messageInterval, direct ? 0 : 20)
  const wait = readCount(config.messageWaitTime, 10)
  const conditions: SandboxWakeupCondition[] = []
  if (!direct) {
    conditions.push({ kind: 'mention', detail: '在 content 里带 `<at id="机器人ID"/>` 并附上正文' })
    conditions.push({ kind: 'quote', detail: '用 replyToMessageId 引用机器人自己发过的消息' })
  }
  if (byPrefix) conditions.push({ kind: 'nickname-prefix', detail: `消息以昵称开头${source}` })
  if (inContent) conditions.push({ kind: 'nickname-anywhere', detail: `消息任意位置包含昵称${source}` })
  if (intervalEnabled && interval === 0) {
    conditions.push({ kind: 'message-wait', detail: `任何消息都会触发：收到后连续 ${wait} 秒没有新消息就回复一次（固定间隔触发开着且消息间隔为 0）` })
  }
  if (intervalEnabled && interval > 0) {
    conditions.push({ kind: 'message-interval', detail: `同一会话累计 ${interval} 条消息后自动触发一次` })
  }
  // 活跃度触发与「消息间隔为 0」互斥，这一条是被测插件自己的判定，不是保守取舍。
  if (!direct && readFlag(config.enableActivityScoreTrigger, true) && !(intervalEnabled && interval === 0)) {
    conditions.push({ kind: 'activity-score', detail: `群消息节奏的活跃度分数达到阈值（下限 ${readThreshold(config.messageActivityScoreLowerLimit, 0.85)}）时自动触发` })
  }
  const scope = readCharacterMembership(runtime.config, target)
  const silent = scope?.status === 'out-of-scope'
  return {
    responder: 'chatluna-character',
    status: scope?.status ?? 'responds',
    ...(scope ? { statusReason: scope.reason } : {}),
    nicknames: [...nicknames],
    ...(presetName ? { presetName } : {}),
    conditions: silent ? [] : conditions,
    caveats: silent ? [] : readCharacterCaveats({ direct, byPrefix, inContent, intervalEnabled, interval, wait, nicknames, presetName, config }),
  }
}

interface CharacterCaveats {
  direct: boolean
  byPrefix: boolean
  inContent: boolean
  intervalEnabled: boolean
  interval: number
  wait: number
  nicknames: readonly string[]
  presetName?: string
  config: Record<string, unknown>
}

/**
 * 会让唤醒落空的陷阱，每一条都对应被测插件里一处真实判定。
 *
 * 发言等待那两条是最容易踩的：只发一个 @ 或者正文恰好等于昵称时，插件会把这一轮记成「等更多消息」而
 * 不是立刻回复；消息间隔配成 0 时更是所有方式都要先静默一段。两种情况下按「@ 了就该马上回」去等待，
 * 结果都是超时。反过来，固定间隔触发被关掉时这条陷阱不存在，因此它跟着开关走而不是无条件写出来。
 */
function readCharacterCaveats(input: CharacterCaveats): string[] {
  const caveats: string[] = []
  if (input.direct) caveats.push('私聊里 @ 与引用不构成唤醒条件：这个插件只在群聊里判定 @ 与引用')
  if (input.intervalEnabled && input.interval === 0) {
    caveats.push(`本会话的消息间隔是 0：@、引用与昵称都不会立刻回复，一律要等静默 ${input.wait} 秒`)
  } else if (input.intervalEnabled) {
    caveats.push(`正文恰好只有昵称${input.direct ? '' : '、或只发 @机器人而不带正文'}时不会立刻回复，要再等静默 ${input.wait} 秒；带上正文即可立即触发`)
  }
  if (!input.nicknames.length && (input.byPrefix || input.inContent)) {
    caveats.push(`昵称唤醒已开启，但伪装预设${input.presetName ? `「${input.presetName}」` : ''}当前读不到昵称，改用${input.direct ? '等待自动触发' : ' @ 机器人'}`)
  }
  if (readFlag(input.config.isForceMute, false)) {
    caveats.push(`关键词触发闭嘴已开启：命中伪装预设 mute_keyword 的消息会让它沉默 ${readCount(input.config.muteTime, 60)} 秒，期间任何方式都唤不醒`)
  }
  return caveats
}

/**
 * chatluna-character 收不收这条会话。
 *
 * 白名单模式私聊与群聊两处默认都开着、名单默认为空，因此「插件装了却一条消息都不处理」是它的默认状态
 * 而不是异常状态，沙盒默认场景里的那个群与那些账号当然也不在名单里。这条事实必须先答出来，否则外部
 * 测试控制器会照着一份根本不生效的唤醒条件去等回复。
 */
function readCharacterMembership(
  config: Record<string, unknown>,
  target: SandboxWakeupTarget,
): { status: 'out-of-scope' | 'conditional', reason: string } | undefined {
  const direct = target.conversationType === 'direct'
  if (!readFlag(config[direct ? 'privateWhitelistMode' : 'groupWhitelistMode'], true)) return undefined
  const listName = direct ? 'applyPrivate' : 'applyGroup'
  const subject = direct ? '账号' : '群号'
  const label = direct ? '私聊' : '群聊'
  const allowed = readStrings(config[listName])
  if (!target.conversationKey) {
    return {
      status: 'conditional',
      reason: `${label}白名单只放行 ${listName} 里的 ${allowed.length} 个${subject}，本会话是否在内要传 conversationId 才能判定`,
    }
  }
  if (allowed.includes(target.conversationKey)) return undefined
  return {
    status: 'out-of-scope',
    reason: `${label}白名单模式已开启，${subject} ${target.conversationKey} 不在 ${listName} 里，它不会处理这条会话`,
  }
}

/**
 * 合并出这条会话上真正生效的那份 chatluna-character 配置。
 *
 * 合并顺序与被测插件一致：插件全局配置 → 全局私聊/群聊配置 → 逐会话配置。少合一层会让「某个群单独把
 * 昵称触发关掉了」这类逐会话覆盖读不出来，而那正是最需要读出来的一类配置。
 */
function readCharacterScopeConfig(config: Record<string, unknown>, target: SandboxWakeupTarget): Record<string, unknown> {
  const direct = target.conversationType === 'direct'
  const global = readRecord(config[direct ? 'globalPrivateConfig' : 'globalGroupConfig']) ?? {}
  const perConversation = target.conversationKey
    ? readRecord(readRecord(config[direct ? 'privateConfigs' : 'configs'])?.[target.conversationKey]) ?? {}
    : {}
  return { ...config, ...global, ...perConversation }
}

// —— 指引 ——

/**
 * 把结构化事实渲染成一段可以直接放进提示词的指引。
 *
 * 它与 `scopes` 派生自同一次读取，因此不可能出现「结构化事实说 A、文案说 B」。不会响应的插件也要留一句
 * 原因：外部测试控制器需要知道「等不到回复」是配置使然而不是被测插件的缺陷，否则它会把一次正常的沉默
 * 报成 Bug，或者反复重试同一条注定唤不醒的消息。
 */
function describeWakeupGuidance(scopes: readonly SandboxWakeupScope[]): string {
  const sentences = scopes.flatMap((scope) => describeWakeupScope(scope))
  if (!sentences.length) {
    return '当前 Koishi 实例既没有加载 ChatLuna 主功能也没有加载 chatluna-character：被测机器人不会因为消息内容自动回复，只有其他插件自己的命令会响应。'
  }
  return `${sentences.join('')}用 get_wakeup_rules 可以取到本会话的完整判定。`
}

function describeWakeupScope(scope: SandboxWakeupScope): string[] {
  const label = scope.conversationType === 'direct' ? '私聊' : '群聊'
  return scope.responders.flatMap((responder) => {
    if (responder.status === 'suppressed' || responder.status === 'out-of-scope') {
      return [`${label}里 ${responder.responder} 不会响应：${responder.statusReason}。`]
    }
    if (!responder.conditions.length) {
      return [`${label}里 ${responder.responder} 当前没有任何唤醒条件：它的触发开关都被关掉了。`]
    }
    const uncertain = responder.status === 'conditional' ? `（${responder.statusReason}）` : ''
    return [
      `${label}由 ${responder.responder} 响应${uncertain}，可用：${responder.conditions.map(({ detail }) => detail).join('；')}。`,
      ...responder.caveats.map((caveat) => `注意：${caveat}。`),
    ]
  })
}

// —— 取值 ——
// 缺省值一律照抄被测插件的 schema 默认值：配置对象可以只带被改过的那几个键，此时缺省值就是实际生效值。

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const text = readString(item)
    return text ? [text] : []
  })
}

function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function readThreshold(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 读一个概率配置。
 *
 * 返回 undefined 表示它是 Koishi 计算属性：那种取值要有 session 才能求解，沙盒无从代它算。不能静默当成
 * 0——那会把「这个群其实开着随机回复」说成「不会随机回复」，而随机回复正是最难与缺陷区分的一种回复。
 */
function readPercent(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(Math.max(value, 0), 1)
  return undefined
}

function formatPercent(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`
}

function describeNicknames(nicknames: readonly string[], source: string): string {
  return nicknames.length
    ? `（${source}：${nicknames.map((name) => `「${name}」`).join('、')}）`
    : `（${source} 当前读不到昵称）`
}

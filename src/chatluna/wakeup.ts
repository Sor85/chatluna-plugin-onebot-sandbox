import { findChatLunaRuntime, readRecord } from './runtime'

/**
 * 被测机器人的唤醒规则：外部测试控制器要怎么写这条消息，被测机器人才会回复。
 *
 * 沙盒自己不决定唤醒。ChatLuna v2 只有一条对话管线（`@chatluna/chat` 的 `ctx.chat`），它对每条消息依次
 * 跑 `chat.activation.use` 里列出的激活判定器（`rule`、`activity`、`judge` 或第三方注册的），判定器的配置
 * 与引擎、预设、合并方式一样都是路由规则的命名空间值，可以按群、频道、用户或机器人逐条覆盖。因此「这条
 * 会话现在怎么唤醒」要按完整的路由身份（平台、机器人、群、会话、发言者）解析出当前生效的规则值再回答。
 *
 * 本模块是这件事的唯一持有者：读被测服务的运行时、按路由身份派生生效的唤醒条件、把它渲染成一段可以直接
 * 放进提示词的指引。三件事不拆开，因为拆开就会出现「结构化事实说 A、指引文案说 B」这种只有消费者能发现
 * 的漂移。
 *
 * 只读规则、不调用 `ctx.chat.decide`：它会登记消息去重、触发 `chat/before-receive` 的合并窗口，`activity`
 * 判定器还会改写会话状态、`judge` 判定器会调用模型消耗预算，拿一条假想消息去问会污染真实测试。`rule`
 * 判定器的口径照抄 `decideActivation`（`packages/chat/core/src/activation.ts`），默认值照抄它的 schema：
 * 说得比实际少会让外部测试控制器白等一轮超时，说得比实际多会让它把「本来就不该回复」当成缺陷报出来。
 */

// —— 领域形状 ——

/** 决定虚拟 OneBot 机器人要不要回复的响应方。v2 只有 ChatLuna 对话管线一个。 */
export type SandboxResponderKind = 'chatluna'

/**
 * 唤醒条件的种类。
 *
 * 前六种由消息本身决定，外部测试控制器可以照着构造；后四种由被测服务自己按会话热度、模型判断或第三方
 * 逻辑触发，控制器只能等。两类都要列出：自主触发是「什么都不做也会收到回复」的唯一解释，漏掉它会让控制器
 * 把一条自动触发的回复误判成自己那条消息的回复。
 */
export type SandboxWakeupConditionKind =
  | 'mention'
  | 'quote'
  | 'nickname-prefix'
  | 'nickname-anywhere'
  | 'any-message'
  | 'command'
  | 'random'
  | 'activity-score'
  | 'model-judge'
  | 'custom-decider'

export interface SandboxWakeupCondition {
  kind: SandboxWakeupConditionKind
  /** 照着做就能唤醒机器人的说明，带上昵称、毫秒数与概率的真实取值。 */
  detail: string
}

/**
 * 响应方在某条会话上的处理状态。
 *
 * `conditional` 不是「说不清」的兜底，它只对应一件确定的事：有启用中的路由规则按调用方没给出的那一维
 * （机器人、群、会话、发言者）覆盖了唤醒相关的命名空间，不知道那一维就无从判定它命不命中。
 */
export type SandboxResponderStatus = 'responds' | 'conditional' | 'out-of-scope'

export interface SandboxResponderWakeup {
  responder: SandboxResponderKind
  status: SandboxResponderStatus
  /** 非 `responds` 时说明原因，`conditional` 说明还差哪一维。 */
  statusReason?: string
  /** 生效的对话引擎（`chat.engine.id`）：agent、character、coding、setup 或 off。 */
  engine: string
  /** 生效的激活判定器（`chat.activation.use`），按判定顺序。 */
  deciders: string[]
  /** 昵称唤醒用的字面量：`chat.activation.rule.botNames` 加上会话预设的 `nick`。 */
  nicknames: string[]
  /** 生效的会话预设（`chat.preset.preset`）。 */
  presetName?: string
  conditions: SandboxWakeupCondition[]
  /** 会让唤醒落空或回复迟到的已知陷阱。 */
  caveats: string[]
}

export interface SandboxWakeupScope {
  conversationType: 'direct' | 'group'
  /** 被测服务归档这类会话用的键：群聊是群号，私聊是发言者账号；没指定会话时缺席。 */
  conversationKey?: string
  /** 接收消息的被测机器人；没指定会话时缺席。 */
  botId?: string
  responders: SandboxResponderWakeup[]
}

export interface SandboxWakeupRules {
  /** 当前已加载的响应方。 */
  loaded: SandboxResponderKind[]
  scopes: SandboxWakeupScope[]
  /** 可以直接放进提示词的指引，与 `scopes` 派生自同一次读取。 */
  guidance: string
}

/**
 * 要解析唤醒规则的一条会话。字段与沙盒投递入站消息时构造的 Session 一一对应
 * （`inbound-delivery.ts`：频道 ID 按 adapter-onebot 的格式，群聊带群号，用户是发言者），因此解析出来的规则就是真实
 * 投递时被测服务看到的那一份。
 */
export interface SandboxWakeupTarget {
  conversationType: 'direct' | 'group'
  conversationKey?: string
  /** 接收消息的被测机器人账号，即路由身份的 selfId。 */
  botId?: string
  /** 路由身份的 channelId：根会话是裸群号或 `private:<对方账号>`，会话实例用实例自己的 ID（v2 按频道区分路由）。 */
  channelId?: string
  /** 群号，即路由身份的 guildId。 */
  guildId?: string
  /** 发言者账号，即路由身份的 userId。 */
  userId?: string
}

/** 唤醒规则的读取口：装配注入读被测运行时的实现，测试注入假运行时。 */
export interface SandboxWakeupReader {
  /** 省略 `targets` 时同时给出私聊与群聊两份通用规则。 */
  read(targets?: readonly SandboxWakeupTarget[]): SandboxWakeupRules
}

// —— 被测运行时 ——

/** ChatLuna v2 路由身份（`@chatluna/satori` 的 `RouteIdentity`）。 */
export interface SandboxRouteIdentity {
  platform: string
  selfId: string
  isDirect: boolean
  guildId?: string
  channelId?: string
  userId: string
}

export interface SandboxRoutingRule {
  id: string
  name?: string
  enabled?: boolean
  filter?: unknown
  values?: Record<string, unknown>
}

export interface SandboxActivationDecider {
  id: string
  label?: string
  /** 只在这些引擎上生效；缺席表示所有引擎。 */
  engines?: readonly string[]
}

/** 被测 ChatLuna v2 运行时里沙盒真正用到的那一小块。 */
export interface ChatLunaChatRuntime {
  /** 按路由身份解析当前生效的规则值，各命名空间已经补齐默认值（`ctx.chat.binding(identity).resolution.values`）。 */
  resolve(identity: SandboxRouteIdentity): Readonly<Record<string, unknown>>
  /** 已注册的激活判定器（`ctx.chat.activationDeciders()`）。 */
  deciders(): readonly SandboxActivationDecider[]
  /** 全部路由规则（`ctx.routing.rules()`），用来判断有没有按调用方没给出的那一维写的覆盖。 */
  rules(): readonly SandboxRoutingRule[]
  /** 按预设 ID 取它的 `nick`；预设没加载或没配昵称时是空数组。 */
  readPresetNicknames(presetId: string): string[]
}

export interface SandboxResponderRuntimes {
  chat?: ChatLunaChatRuntime
}

/**
 * 从一个 Koishi 上下文解析 ChatLuna v2 的对话服务、路由服务与预设服务。
 *
 * 读运行时而不是读 chatluna.yml：路由规则可以在 WebUI 里热更新，唤醒规则要答的是「现在发一条消息会怎样」。
 * 对话服务与路由服务缺一不可；预设服务缺席时只是读不到预设昵称。
 */
export function readSandboxResponderRuntimes(host: unknown): SandboxResponderRuntimes {
  const chat = findChatLunaRuntime(host, 'chat', (service) => (
    typeof service.binding === 'function' && typeof service.activationDeciders === 'function' ? service : undefined
  ))
  const routing = findChatLunaRuntime(host, 'routing', (service) => (typeof service.rules === 'function' ? service : undefined))
  if (!chat || !routing) return {}
  const presets = findChatLunaRuntime(host, 'presets', (service) => (typeof service.get === 'function' ? service : undefined))
  return {
    chat: {
      resolve: (identity) => {
        const binding = readRecord((chat.binding as (identity: SandboxRouteIdentity) => unknown).call(chat, identity))
        return readRecord(readRecord(binding?.resolution)?.values) ?? {}
      },
      deciders: () => readDeciders((chat.activationDeciders as () => unknown).call(chat)),
      rules: () => readRules((routing.rules as () => unknown).call(routing)),
      readPresetNicknames: (presetId) => {
        if (!presets) return []
        try {
          const preset = readRecord((presets.get as (id: string) => unknown).call(presets, presetId))
          return readStrings(readRecord(preset?.data)?.nick)
        } catch {
          // 读不到昵称只该让指引少一句话，不该让整次唤醒规则读取失败。
          return []
        }
      },
    },
  }
}

function readDeciders(value: unknown): SandboxActivationDecider[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = readRecord(item)
    const id = readString(record?.id)
    if (!id) return []
    const label = readString(record?.label)
    const engines = Array.isArray(record?.engines) ? readStrings(record.engines) : undefined
    return [{ id, ...(label ? { label } : {}), ...(engines ? { engines } : {}) }]
  })
}

function readRules(value: unknown): SandboxRoutingRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = readRecord(item)
    const id = readString(record?.id)
    if (!id) return []
    const name = readString(record?.name)
    return [{
      id,
      ...(name ? { name } : {}),
      enabled: record?.enabled !== false,
      filter: record?.filter,
      values: readRecord(record?.values) ?? {},
    }]
  })
}

// —— 读取器 ——

/** 没指定会话时要答的两类会话。v2 的内置规则按这一维分开（`global` 与 `global-private`）。 */
const ALL_TARGETS: readonly SandboxWakeupTarget[] = [
  { conversationType: 'direct' },
  { conversationType: 'group' },
]

const PLATFORM = 'onebot'

export class SandboxChatLunaWakeup implements SandboxWakeupReader {
  /** 运行时每次现取：被测服务可以随时重载，持有引用会让规则停在重载前的那一份配置上。 */
  constructor(private readonly resolveRuntimes: () => SandboxResponderRuntimes) {}

  read(targets?: readonly SandboxWakeupTarget[]): SandboxWakeupRules {
    const { chat } = this.resolveRuntimes()
    const scopes = (targets?.length ? targets : ALL_TARGETS).map((target): SandboxWakeupScope => ({
      conversationType: target.conversationType,
      ...(target.conversationKey ? { conversationKey: target.conversationKey } : {}),
      ...(target.botId ? { botId: target.botId } : {}),
      responders: chat ? [readChatWakeup(chat, target)] : [],
    }))
    return { loaded: chat ? ['chatluna'] : [], scopes, guidance: describeWakeupGuidance(scopes) }
  }
}

// —— ChatLuna v2 对话管线 ——

/** 与唤醒有关的路由命名空间：覆盖了其中任何一个的规则都会改变「怎么唤醒、多久回复」。 */
const WAKEUP_NAMESPACES = ['chat.activation', 'chat.engine', 'chat.preset', 'chat.merge', 'chat.proactive'] as const

/** v2 内置规则，按会话种类无条件生效，不构成「要更多信息才能判定」的覆盖。 */
const BUILTIN_RULES = new Set(['global', 'global-private'])

function readChatWakeup(runtime: ChatLunaChatRuntime, target: SandboxWakeupTarget): SandboxResponderWakeup {
  const direct = target.conversationType === 'direct'
  const values = runtime.resolve(toRouteIdentity(target))
  const engine = readRecord(values['chat.engine']) ?? {}
  const engineId = readString(engine.id) ?? 'agent'
  const mode = readString(engine.mode) ?? 'normal'
  const activation = readRecord(values['chat.activation']) ?? {}
  const registered = new Map(runtime.deciders().map((decider) => [decider.id, decider]))
  // 与 `_runDeciders` 一致：没注册的 ID 与不适用于当前引擎的判定器都会被跳过。
  const deciders = readStrings(activation.use).filter((id) => {
    const decider = registered.get(id)
    return decider && (!decider.engines || decider.engines.includes(engineId))
  })
  const presetName = readString(readRecord(values['chat.preset'])?.preset)
  const rule = readRecord(activation.rule) ?? {}
  const nicknames = [...new Set([...readStrings(rule.botNames), ...(presetName ? runtime.readPresetNicknames(presetName) : [])])]
  const base = { responder: 'chatluna' as const, engine: engineId, deciders, nicknames, ...(presetName ? { presetName } : {}) }

  const gate = readEngineGate(engineId, mode, deciders)
  if (gate) {
    // 不会回复时一条唤醒条件都不列：那份清单会被读成「照着做就能唤醒」。命令仍然可用的情况单独列出。
    const conditions = mode === 'commands' ? [commandCondition(direct)] : []
    return { ...base, status: 'out-of-scope', statusReason: gate, conditions, caveats: [] }
  }

  const conditions: SandboxWakeupCondition[] = []
  const caveats: string[] = []
  for (const id of deciders) {
    if (id === 'rule') {
      readRuleConditions(rule, direct, nicknames, conditions, caveats)
    } else if (id === 'activity') {
      const config = readRecord(activation.activity) ?? {}
      conditions.push({
        kind: 'activity-score',
        detail: `按群聊热度、话题与提及自主插话（activity 判定器：基础概率 ${formatPercent(readNumber(config.chance, 0.3))}，每小时最多 ${readNumber(config.hourlyLimit, 30)} 次，两次至少间隔 30 秒）`,
      })
    } else if (id === 'judge') {
      const config = readRecord(activation.judge) ?? {}
      conditions.push({
        kind: 'model-judge',
        detail: `前面的判定都没唤醒时，由模型判断要不要接话（judge 判定器：意愿阈值 ${readNumber(config.minUrge, 0.55)}，两次至少间隔 ${readNumber(config.minInterval, 60000)} 毫秒，每天 ${readNumber(config.dailyBudget, 200)} 次预算）`,
      })
    } else {
      const label = registered.get(id)?.label
      conditions.push({ kind: 'custom-decider', detail: `第三方激活判定器 ${id}${label ? `（${label}）` : ''}，判定口径由注册它的插件决定` })
    }
  }
  // Koishi 命令在激活判定之前就被分走（`session.argv.command`），不受上面任何一条约束；chat 模式会连命令一起静音。
  if (mode !== 'chat') conditions.push(commandCondition(direct))
  caveats.push(...readFlowCaveats(values, engineId, direct, deciders))

  const pending = readPendingOverride(runtime.rules(), target)
  return {
    ...base,
    status: pending ? 'conditional' : 'responds',
    ...(pending ? { statusReason: pending } : {}),
    conditions,
    caveats,
  }
}

/** 沙盒投递入站消息时的路由身份；调用方没给出的维度留空，只会命中不按那一维限定的规则。 */
function toRouteIdentity(target: SandboxWakeupTarget): SandboxRouteIdentity {
  return {
    platform: PLATFORM,
    selfId: target.botId ?? '',
    isDirect: target.conversationType === 'direct',
    ...(target.guildId ? { guildId: target.guildId } : {}),
    ...(target.channelId ? { channelId: target.channelId } : {}),
    userId: target.userId ?? '',
  }
}

/** 引擎层面就不会回复的几种情况；返回原因，会回复时返回 undefined。 */
function readEngineGate(engineId: string, mode: string, deciders: readonly string[]): string | undefined {
  if (engineId === 'off') return 'chat.engine 为 off，ChatLuna 不处理本会话的消息'
  if (mode === 'commands') return 'chat.engine.mode 为 commands：ChatLuna 只记录不回复，只有 Koishi 命令会响应'
  if (mode === 'silent') return 'chat.engine.mode 为 silent：ChatLuna 与 Koishi 命令都不回复'
  if (!deciders.length) return 'chat.activation.use 里没有一个已注册且适用于当前引擎的激活判定器，消息都不会唤醒 ChatLuna'
}

function commandCondition(direct: boolean): SandboxWakeupCondition {
  return {
    kind: 'command',
    detail: direct
      ? 'Koishi 命令（例如 `help`）不经激活判定，直接由命令插件回复'
      : 'Koishi 命令不经激活判定，直接由命令插件回复；群聊里通常要先 @ 机器人，例如 `<at id="机器人ID"/> help`',
  }
}

/**
 * `rule` 判定器的唤醒条件，顺序与 `decideActivation` 一致。
 *
 * 私聊开着 privateChatWithoutCommand 时有问必答，后面几项根本走不到；关掉它时私聊与群聊走同一份判定，
 * 并且与 v1 的 chatluna-character 不同，私聊里的 @ 同样算数。消息内含昵称只在「昵称开头」开着时才判定。
 */
function readRuleConditions(
  rule: Record<string, unknown>,
  direct: boolean,
  nicknames: readonly string[],
  conditions: SandboxWakeupCondition[],
  caveats: string[],
): void {
  const source = describeNicknames(nicknames)
  if (direct && readFlag(rule.privateChatWithoutCommand, true)) {
    conditions.push({ kind: 'any-message', detail: '私聊里任何一条消息都会唤醒，不必 @ 也不必带昵称（privateChatWithoutCommand 已开启）' })
  } else {
    if (readFlag(rule.allowAtReply, true)) conditions.push({ kind: 'mention', detail: '在 content 里任意位置带 `<at id="机器人ID"/>`' })
    if (readFlag(rule.allowQuoteReply, true)) conditions.push({ kind: 'quote', detail: '用 replyToMessageId 引用机器人自己发过的消息' })
    const byPrefix = readFlag(rule.isNickname, true)
    if (byPrefix) {
      conditions.push({ kind: 'nickname-prefix', detail: `消息以昵称开头${source}` })
      if (readFlag(rule.isNickNameWithContent, false)) conditions.push({ kind: 'nickname-anywhere', detail: `消息任意位置包含昵称${source}` })
      if (!nicknames.length) caveats.push('昵称唤醒已开启，但 botNames 与预设 nick 都是空的，昵称这条路走不通')
    }
    const random = readPercent(rule.randomReplyFrequency)
    if (random > 0) conditions.push({ kind: 'random', detail: `其余条件都不满足时，每条消息有 ${formatPercent(random)} 概率被随机回复（randomReplyFrequency）` })
    if (direct) caveats.push('privateChatWithoutCommand 已关闭：私聊里既不 @、不引用、也不带昵称的消息不会唤醒')
  }
  const cooldown = readNumber(rule.msgCooldown, 0)
  if (cooldown > 0) caveats.push(`msgCooldown 为 ${cooldown} 毫秒：距上次唤醒不足这段时间的消息只会被记录，不会回复`)
}

/** 判定之后影响「多久回复、会不会自己说话」的设置：合并方式、引擎自带的沉默机制与主动发言。 */
function readFlowCaveats(values: Readonly<Record<string, unknown>>, engineId: string, direct: boolean, deciders: readonly string[]): string[] {
  const caveats: string[] = []
  // 合并插件没装时这个命名空间不存在，回复立即发出。
  const merge = Object.hasOwn(values, 'chat.merge') ? readRecord(values['chat.merge']) : undefined
  const mergeMode = merge ? (direct ? readString(merge.directMode) ?? readString(merge.mode) : readString(merge.mode)) : undefined
  if (merge && mergeMode === 'settle') {
    caveats.push(`chat.merge 为「等待发送完毕」：发言者静默 ${readNumber(merge.quiet, 2500)} 毫秒后才回复，连续发送时最长等 ${readNumber(merge.max, 15000)} 毫秒；等待超时不要短于此`)
  }
  if (deciders.includes('activity') || deciders.includes('judge')) {
    caveats.push('activity 与 judge 是自主判定：同样的消息这次唤醒、下次不唤醒都正常，回复也可能延后发出')
  }
  if (engineId === 'character') {
    caveats.push('character 引擎：直接对机器人说闭嘴类的话会让它沉默一段时间，预设作息里的睡眠时段只有 @、引用、私聊与昵称能唤醒，模型也可以选择不回复')
  }
  if (engineId === 'setup') {
    caveats.push('本会话路由到 setup 引擎（主人私聊、人设尚未设置完成），回复是设置向导而不是正常对话')
  }
  const proactive = Object.hasOwn(values, 'chat.proactive') ? readRecord(values['chat.proactive']) : undefined
  const initiatives = proactive ? ['silence', 'followUp', 'topic', 'rhythm'].filter((key) => proactive[key] === true) : []
  if (initiatives.length) {
    caveats.push(`chat.proactive 开着 ${initiatives.join('、')}：机器人可能在没人唤醒时自己发消息，等待回复时用 cursorBefore 与 authorId 区分`)
  }
  return caveats
}

/**
 * 有没有启用中的路由规则按调用方没给出的那一维覆盖了唤醒相关的命名空间。
 *
 * 没给出机器人、会话或发言者时，解析用的身份在那一维上是空的，按那一维写的规则一条都不会命中——答案
 * 因此只对「不命中那些规则」成立，要明说还差哪一维，而不是把全局规则当成这条会话的答案。按消息内容写的
 * 规则（content、at-me、quote-me）同样取决于具体消息，一并提示。
 */
function readPendingOverride(rules: readonly SandboxRoutingRule[], target: SandboxWakeupTarget): string | undefined {
  const missing = new Set<string>()
  if (!target.botId) missing.add('self')
  if (!target.channelId) {
    missing.add('guild')
    missing.add('channel')
  }
  if (!target.userId) missing.add('user')
  if (missing.has('self') || missing.has('channel') || missing.has('user')) missing.add('route')
  const pending = rules.flatMap((rule) => {
    if (rule.enabled === false || BUILTIN_RULES.has(rule.id)) return []
    const namespaces = WAKEUP_NAMESPACES.filter((ns) => rule.values && Object.hasOwn(rule.values, ns))
    if (!namespaces.length) return []
    const fields = collectPredicateFields(rule.filter)
    const unresolved = [...fields].filter((field) => missing.has(field) || field === 'content')
    return unresolved.length ? [{ rule, namespaces, unresolved }] : []
  })
  if (!pending.length) return undefined
  const params = new Set(pending.flatMap(({ unresolved }) => unresolved.map((field) => PARAMETER_OF_FIELD[field] ?? field)))
  const names = pending.map(({ rule, namespaces }) => `「${rule.name ?? rule.id}」（${namespaces.join('、')}）`)
  return `路由规则 ${names.join('、')} 按${[...params].join('、')}限定，本次读取没有这些信息，命中时以那些规则为准`
}

const PARAMETER_OF_FIELD: Record<string, string> = {
  self: '接收的机器人（botId）',
  guild: '会话（conversationId）',
  channel: '会话（conversationId）',
  route: '会话、机器人与发言者',
  user: '发言者（operatorId）',
  content: '消息内容',
}

/** 谓词里引用到的作用域维度；消息内容类谓词记作 `content`。 */
function collectPredicateFields(predicate: unknown, fields = new Set<string>()): Set<string> {
  const record = readRecord(predicate)
  if (!record) return fields
  const kind = record.kind
  if (kind === 'scope' && typeof record.field === 'string') fields.add(record.field)
  if (kind === 'content' || kind === 'at-me' || kind === 'quote-me') fields.add('content')
  if (kind === 'not') collectPredicateFields(record.operand, fields)
  if ((kind === 'and' || kind === 'or') && Array.isArray(record.operands)) {
    for (const operand of record.operands) collectPredicateFields(operand, fields)
  }
  return fields
}

// —— 指引 ——

/**
 * 把结构化事实渲染成一段可以直接放进提示词的指引。
 *
 * 它与 `scopes` 派生自同一次读取，因此不可能出现「结构化事实说 A、文案说 B」。不会响应时也要留一句原因：
 * 外部测试控制器需要知道「等不到回复」是配置使然而不是被测服务的缺陷，否则它会把一次正常的沉默报成 Bug，
 * 或者反复重试同一条注定唤不醒的消息。
 */
function describeWakeupGuidance(scopes: readonly SandboxWakeupScope[]): string {
  const sentences = scopes.flatMap((scope) => describeWakeupScope(scope))
  if (!sentences.length) {
    return '当前实例没有加载 ChatLuna v2 的对话服务（@chatluna/chat 与 @chatluna/routing）：被测机器人不会因为消息内容回复，只有 Koishi 命令会响应。'
  }
  return `${sentences.join('')}用 get_wakeup_rules 可以取到本会话的完整判定。`
}

function describeWakeupScope(scope: SandboxWakeupScope): string[] {
  const label = `${scope.conversationType === 'direct' ? '私聊' : '群聊'}${scope.botId ? `（机器人 ${scope.botId}）` : ''}`
  return scope.responders.flatMap((responder) => {
    const engine = `${responder.engine} 引擎`
    if (responder.status === 'out-of-scope') {
      const commands = responder.conditions.length ? `可用：${responder.conditions.map(({ detail }) => detail).join('；')}。` : ''
      return [`${label}里 ChatLuna 不会回复：${responder.statusReason}。${commands}`]
    }
    const uncertain = responder.status === 'conditional' ? `（${responder.statusReason}）` : ''
    return [
      `${label}由 ChatLuna（${engine}，激活判定器 ${responder.deciders.join('、')}）响应${uncertain}，可用：${responder.conditions.map(({ detail }) => detail).join('；')}。`,
      ...responder.caveats.map((caveat) => `注意：${caveat}。`),
    ]
  })
}

// —— 取值 ——
// 缺省值一律照抄被测服务的 schema 默认值：解析结果已经补齐默认值，这里的缺省只在形状不对时兜底。

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

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function readPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

function formatPercent(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`
}

function describeNicknames(nicknames: readonly string[]): string {
  return nicknames.length
    ? `（昵称：${nicknames.map((name) => `「${name}」`).join('、')}）`
    : '（botNames 与预设 nick 当前都是空的）'
}

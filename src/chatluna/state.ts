import type { Context } from 'cordis'
import { readStepThought } from './thinking'
import type {
  SandboxChatLunaState,
  SandboxMessageChatLuna,
  SandboxMessageTraceReference,
} from '../types'

/**
 * 把 Session 上的 channelId 解析成沙盒会话 ID：根会话的 channelId 是 adapter-onebot 格式（裸群号、
 * `private:<账号>`），与会话 ID 不同。不是沙盒机器人可见的会话时返回 undefined，不建立映射。
 */
type ResolveTarget = (botParticipantId: string, channelId: string) => string | undefined
type ArchiveResult = (
  botParticipantId: string,
  conversationId: string,
  result: SandboxMessageChatLuna,
  messageIds: readonly string[],
) => void

interface ChatLunaEventRegistrar {
  (event: 'chat/receive', listener: (session: unknown, result: { sessionId: string }) => void): () => void
  (event: 'chatluna/agent-status', listener: (payload: { agent: ChatLunaAgentPayload, status: string }) => void): () => void
  (event: 'chatluna/agent-step', listener: (payload: { agent: ChatLunaAgentPayload, step: ChatLunaStepPayload }) => void): () => void
  (event: 'chatluna/span-start' | 'chatluna/span-end', listener: (payload: { span?: ChatLunaSpanPayload }) => void): () => void
}

/** ChatLuna v2 agent 事件里本模块读取的字段；事件类型来自宿主，这里只做结构化读取。 */
interface ChatLunaAgentPayload {
  session?: { id?: unknown }
  /** ChatLuna 打开会话时写入的路由位置；channel 是打开这份会话的 Session 或唤醒目标的 channelId。 */
  options?: { location?: { selfId?: unknown, channel?: unknown } }
}

interface ChatLunaStepPayload {
  content?: unknown
  usage?: { inputTokens?: unknown, cacheReadTokens?: unknown, cacheWriteTokens?: unknown, outputTokens?: unknown, totalTokens?: unknown }
  trace?: { attributes?: Record<string, unknown> }
}

/** `@chatluna/trace` 的 span 快照里本模块读取的字段；step span 带 turn、step 属性与 agent 会话 ID。 */
interface ChatLunaSpanPayload {
  spanKind?: unknown
  session?: unknown
  attributes?: Record<string, unknown>
}

interface SandboxChatLunaTarget {
  botParticipantId: string
  conversationId: string
}

/** 一个 agent 会话正在进行的回合。 */
interface ActiveTurn {
  key: string
  startedAt: number
  thoughts: string[]
  replyMessageIds: string[]
}

/** 回合已结束、回复还在渲染队列里没发完时挂起的结果；之后发出的每一段依次接手。 */
interface PendingResult {
  result: SandboxMessageChatLuna
  replyMessageIds: string[]
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function readSessionTarget(session: unknown): { botParticipantId: string, channelId: string } | undefined {
  const value = readRecord(session)
  const botParticipantId = readString(value?.selfId)
  const channelId = readString(value?.channelId)
  if (!botParticipantId || !channelId) return
  return { botParticipantId, channelId }
}

function readAgentSessionId(agent: ChatLunaAgentPayload | undefined): string | undefined {
  return readString(agent?.session?.id)
}

function createStateKey(botParticipantId: string, conversationId: string) {
  return `${botParticipantId}\u0000${conversationId}`
}

/**
 * 机器人的等待态、用量、思考与回复出处，全部由 ChatLuna v2 的三个事件推动。
 *
 * `chat/receive` 给出「agent 会话 ID → 机器人 + 会话」映射，之后的 `agent-status`（busy / idle）与
 * `agent-step` 只带会话 ID；唤醒的回合没有 `chat/receive`，映射改由 agent 自己的路由位置补上。v2 的会话键含机器人 selfId，因此一个 agent 会话只对应一个机器人会话，
 * 并发的机器人与会话各自按会话 ID 收尾，互不串联。
 */
export class SandboxChatLunaStateStore {
  private states = new Map<string, SandboxChatLunaState>()
  /** agent 会话 ID → 进行中的回合。 */
  private turns = new Map<string, ActiveTurn>()
  /** ChatLuna v2 会话 ID → 沙盒里的机器人与会话；由 `chat/receive` 建立。 */
  private agentTargets = new Map<string, SandboxChatLunaTarget>()
  /** 此刻处于 busy 的 agent 会话，不论映射是否已建立。 */
  private busySessions = new Set<string>()
  /** 每个机器人会话最近一步模型调用的 trace 位置；新回复按它标注出处。 */
  private latestTraces = new Map<string, SandboxMessageTraceReference>()
  /** 每个机器人会话正在进行的那一步；`reply` 等工具在这一步当中发出回复，此时 agent-step 还没到。 */
  private runningTraces = new Map<string, SandboxMessageTraceReference>()
  /** 机器人会话 → 已结束回合还没落到回复上的结果。 */
  private pendingResults = new Map<string, PendingResult>()
  private disposers: Array<() => void> = []

  constructor(
    private ctx: Context,
    private resolveTarget: ResolveTarget,
    private onChange: () => void = () => {},
    private archiveResult: ArchiveResult = () => {},
  ) {
    const on = this.ctx.on.bind(this.ctx) as unknown as ChatLunaEventRegistrar
    // v2 的 dispatch 先唤醒 agent（同步发出 busy）再发 `chat/receive`，会话第一次被唤醒时 busy 先到、
    // 映射后到。busy 不论映射与否都先记下，映射晚到时若 agent 仍在 busy 就当场开始回合。
    this.disposers.push(on('chat/receive', (session, result) => {
      const source = readSessionTarget(session)
      const sessionId = readString(result?.sessionId)
      const conversationId = source && this.resolveTarget(source.botParticipantId, source.channelId)
      if (!source || !sessionId || !conversationId) return
      const target = { botParticipantId: source.botParticipantId, conversationId }
      this.agentTargets.set(sessionId, target)
      if (this.busySessions.has(sessionId) && !this.turns.has(sessionId)) this.begin(sessionId, target)
    }))
    this.disposers.push(on('chatluna/agent-status', ({ agent, status }) => {
      const sessionId = readAgentSessionId(agent)
      if (!sessionId) return
      if (status === 'busy') this.busySessions.add(sessionId)
      else this.busySessions.delete(sessionId)
      const target = this.targetOf(sessionId, agent)
      if (!target) return
      if (status === 'busy') this.begin(sessionId, target)
      else this.finish(sessionId)
    }))
    this.disposers.push(on('chatluna/agent-step', ({ agent, step }) => {
      const sessionId = readAgentSessionId(agent)
      const target = sessionId ? this.targetOf(sessionId, agent) : undefined
      if (!sessionId || !target) return
      this.recordStep(sessionId, target, step)
    }))
    // 工具模式下回复由 `reply` 工具在这一步当中发出，早于 agent-step；step span 的起止让发消息时能拿到这一步。
    // 文本模式的回复在这一步结束后经渲染队列发出，落回 latestTraces。trace 插件未加载时两个事件都不会来。
    this.disposers.push(on('chatluna/span-start', ({ span }) => {
      const located = this.locateStepSpan(span)
      if (located) this.runningTraces.set(located.key, located.trace)
    }))
    this.disposers.push(on('chatluna/span-end', ({ span }) => {
      const located = this.locateStepSpan(span)
      if (!located) return
      const running = this.runningTraces.get(located.key)
      if (running?.turn === located.trace.turn && running.step === located.trace.step) this.runningTraces.delete(located.key)
      this.latestTraces.set(located.key, located.trace)
    }))
  }

  /**
   * agent 会话对应的机器人会话。`chat.wake` 唤醒的回合不经过 `chat/receive`，会话第一次被唤醒时还没有
   * 映射，这时按 agent 打开时记下的路由位置补上，否则唤醒发出的回复没有出处。
   */
  private targetOf(sessionId: string, agent: ChatLunaAgentPayload | undefined): SandboxChatLunaTarget | undefined {
    const known = this.agentTargets.get(sessionId)
    if (known) return known
    const location = readRecord(readRecord(agent?.options)?.location)
    const botParticipantId = readString(location?.selfId)
    const channelId = readString(location?.channel)
    const conversationId = botParticipantId && channelId ? this.resolveTarget(botParticipantId, channelId) : undefined
    if (!botParticipantId || !conversationId) return
    const target = { botParticipantId, conversationId }
    this.agentTargets.set(sessionId, target)
    return target
  }

  private locateStepSpan(span: ChatLunaSpanPayload | undefined): { key: string, trace: SandboxMessageTraceReference } | undefined {
    if (span?.spanKind !== 'step') return
    const sessionId = readString(span.session)
    const target = sessionId ? this.agentTargets.get(sessionId) : undefined
    const turn = readNumber(span.attributes?.turn)
    const step = readNumber(span.attributes?.step)
    if (!sessionId || !target || !turn || !step) return
    return { key: createStateKey(target.botParticipantId, target.conversationId), trace: { sessionId, turn, step } }
  }

  /**
   * 机器人此刻发出的回复出自哪一步模型调用：有正在进行的一步就是它，否则是最近完成的一步。
   * 会话里出现新的用户消息后清空最近完成的一步，命令回复不会沿用上一轮。
   */
  traceFor(botParticipantId: string, conversationId: string): SandboxMessageTraceReference | undefined {
    const key = createStateKey(botParticipantId, conversationId)
    const trace = this.runningTraces.get(key) ?? this.latestTraces.get(key)
    return trace && { ...trace }
  }

  /**
   * 会话出现新的用户消息：上一轮的 trace 与挂起结果都不再属于之后的机器人消息，命令回复不会沿用上一轮。
   */
  clearReplyContext(conversationId: string): void {
    for (const map of [this.latestTraces, this.pendingResults]) {
      for (const key of map.keys()) {
        if (key.endsWith(`\u0000${conversationId}`)) map.delete(key)
      }
    }
  }

  getStates(): SandboxChatLunaState[] {
    return structuredClone([...this.states.values()])
  }

  /**
   * 记下本轮发出的回复。回合进行中只记 ID，回合结束时归档到最后一段；回合已结束（回复晚于 idle
   * 发出）时这一段立即接手挂起的结果，前一段上的随之移除，结果始终只在最新一段上。
   */
  recordReplyMessage(botParticipantId: string, conversationId: string, messageId: string): void {
    const key = createStateKey(botParticipantId, conversationId)
    for (const turn of this.turns.values()) {
      if (turn.key === key && !turn.replyMessageIds.includes(messageId)) turn.replyMessageIds.push(messageId)
    }
    const pending = this.pendingResults.get(key)
    if (!pending || pending.replyMessageIds.includes(messageId)) return
    pending.replyMessageIds.push(messageId)
    this.archiveResult(botParticipantId, conversationId, pending.result, pending.replyMessageIds)
  }

  clear(): void {
    this.states.clear()
    this.turns.clear()
    this.agentTargets.clear()
    this.busySessions.clear()
    this.latestTraces.clear()
    this.runningTraces.clear()
    this.pendingResults.clear()
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.clear()
  }

  deleteByBotParticipant(botParticipantId: string): void {
    this.deleteWhere(({ botParticipantId: id }) => id === botParticipantId)
  }

  deleteByConversationIds(conversationIds: ReadonlySet<string>): void {
    this.deleteWhere(({ conversationId }) => conversationIds.has(conversationId))
  }

  /**
   * 开始一个回合。上一轮没收到 idle（上游报错中断）时直接重开：用量、思考与计时都从这一轮算起。
   * 同一个机器人会话换了 agent 会话（v2 重置会话后会话 ID 会变）时，旧会话的回合一并作废。
   */
  private begin(sessionId: string, target: SandboxChatLunaTarget): void {
    const key = createStateKey(target.botParticipantId, target.conversationId)
    for (const [id, turn] of this.turns) {
      if (turn.key === key) this.turns.delete(id)
    }
    this.pendingResults.delete(key)
    this.runningTraces.delete(key)
    this.turns.set(sessionId, { key, startedAt: Date.now(), thoughts: [], replyMessageIds: [] })
    this.states.set(key, { ...target, thinking: true, updatedAt: new Date().toISOString() })
    // 等待态是不落场景快照的瞬时状态，必须单独广播，否则聊天页面要等下一条消息才刷新，届时思考早已结束。
    this.onChange()
  }

  private recordStep(sessionId: string, target: SandboxChatLunaTarget, step: ChatLunaStepPayload): void {
    const key = createStateKey(target.botParticipantId, target.conversationId)
    const attributes = step?.trace?.attributes
    const turnNumber = readNumber(attributes?.turn)
    const stepNumber = readNumber(attributes?.step)
    if (turnNumber && stepNumber) this.latestTraces.set(key, { sessionId, turn: turnNumber, step: stepNumber })
    const turn = this.turns.get(sessionId)
    const state = this.states.get(key)
    if (!turn || turn.key !== key || !state?.thinking) return
    const thought = readStepThought(step)
    if (thought) turn.thoughts.push(thought)
    if (!step?.usage) return
    // v2 的 inputTokens 只是未命中缓存的部分，缓存读写另记；按 v2 计费的 billedInputTokens 口径三项相加。
    // 每一步都把整段上下文重发一遍，输入取最后一步（与 trace 页的「已用上下文」一致），输出是各步新生成的，累加。
    const inputTokens = readNumber(step.usage.inputTokens) + readNumber(step.usage.cacheReadTokens) + readNumber(step.usage.cacheWriteTokens)
    const outputTokens = (state.usage?.outputTokens ?? 0) + readNumber(step.usage.outputTokens)
    state.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
    state.updatedAt = new Date().toISOString()
  }

  /**
   * v2 的回复经异步渲染队列发出，character 引擎还会按句分段、带节奏地发，后面几段常常晚于 agent
   * 转为 idle。此时还没有回复就把结果挂起，交给之后发出的回复；不回退到「最后一条机器人消息」，
   * 否则思考与用量会贴到上一轮的回复上。
   */
  private finish(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    this.turns.delete(sessionId)
    this.runningTraces.delete(turn.key)
    const state = this.states.get(turn.key)
    if (!state) return
    state.thinking = false
    state.updatedAt = new Date().toISOString()
    const thought = turn.thoughts.join('\n\n')
    if (thought || state.usage) {
      const result: SandboxMessageChatLuna = {
        thought,
        ...(thought ? { thoughtDurationMs: Math.max(0, Date.now() - turn.startedAt) } : {}),
        ...(state.usage ? { usage: { ...state.usage } } : {}),
      }
      this.pendingResults.set(turn.key, { result, replyMessageIds: [...turn.replyMessageIds] })
      if (turn.replyMessageIds.length) this.archiveResult(state.botParticipantId, state.conversationId, result, turn.replyMessageIds)
    }
    this.onChange()
  }

  private deleteWhere(predicate: (target: SandboxChatLunaTarget) => boolean): void {
    for (const [key, state] of this.states) {
      if (predicate(state)) this.states.delete(key)
    }
    for (const [sessionId, turn] of this.turns) {
      if (!this.states.has(turn.key)) this.turns.delete(sessionId)
    }
    for (const [sessionId, target] of this.agentTargets) {
      if (predicate(target)) this.agentTargets.delete(sessionId)
    }
    for (const map of [this.latestTraces, this.runningTraces, this.pendingResults]) {
      for (const key of [...map.keys()]) {
        const [botParticipantId = '', conversationId = ''] = key.split('\u0000')
        if (predicate({ botParticipantId, conversationId })) map.delete(key)
      }
    }
  }
}

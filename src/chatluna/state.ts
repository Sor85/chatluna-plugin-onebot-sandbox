import type { Context } from 'cordis'
import { readStepThought } from './thinking'
import type {
  SandboxChatLunaState,
  SandboxMessageChatLuna,
  SandboxMessageTraceReference,
} from '../types'

type ValidateTarget = (botParticipantId: string, conversationId: string) => boolean
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
}

/** ChatLuna v2 agent 事件里本模块读取的字段；事件类型来自宿主，这里只做结构化读取。 */
interface ChatLunaAgentPayload {
  session?: { id?: unknown }
}

interface ChatLunaStepPayload {
  content?: unknown
  toolCalls?: unknown
  usage?: { inputTokens?: unknown, outputTokens?: unknown, totalTokens?: unknown }
  trace?: { attributes?: Record<string, unknown> }
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

function readSessionTarget(session: unknown): SandboxChatLunaTarget | undefined {
  const value = readRecord(session)
  const bot = readRecord(value?.bot)
  const channel = readRecord(value?.channel)
  const botParticipantId = readString(value?.selfId) ?? readString(bot?.selfId)
  const conversationId = readString(value?.channelId) ?? readString(channel?.id)
  if (!botParticipantId || !conversationId) return
  return { botParticipantId, conversationId }
}

function readAgentSessionId(agent: ChatLunaAgentPayload | undefined): string | undefined {
  const id = agent?.session?.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

function createStateKey(botParticipantId: string, conversationId: string) {
  return `${botParticipantId}\u0000${conversationId}`
}

/**
 * 机器人的等待态、用量、思考与回复出处，全部由 ChatLuna v2 的三个事件推动。
 *
 * `chat/receive` 给出「agent 会话 ID → 机器人 + 会话」映射，之后的 `agent-status`（busy / idle）与
 * `agent-step` 只带会话 ID。v2 的会话键含机器人 selfId，因此一个 agent 会话只对应一个机器人会话，
 * 并发的机器人与会话各自按会话 ID 收尾，互不串联。
 */
export class SandboxChatLunaStateStore {
  private states = new Map<string, SandboxChatLunaState>()
  /** agent 会话 ID → 进行中的回合。 */
  private turns = new Map<string, ActiveTurn>()
  /** ChatLuna v2 会话 ID → 沙盒里的机器人与会话；由 `chat/receive` 建立。 */
  private agentTargets = new Map<string, SandboxChatLunaTarget>()
  /** 每个机器人会话最近一步模型调用的 trace 位置；新回复按它标注出处。 */
  private latestTraces = new Map<string, SandboxMessageTraceReference>()
  /** 机器人会话 → 已结束回合还没落到回复上的结果。 */
  private pendingResults = new Map<string, PendingResult>()
  private disposers: Array<() => void> = []

  constructor(
    private ctx: Context,
    private validateTarget: ValidateTarget,
    private onChange: () => void = () => {},
    private archiveResult: ArchiveResult = () => {},
  ) {
    const on = this.ctx.on.bind(this.ctx) as unknown as ChatLunaEventRegistrar
    this.disposers.push(on('chat/receive', (session, result) => {
      const target = readSessionTarget(session)
      const sessionId = readString(result?.sessionId)
      if (target && sessionId && this.validateTarget(target.botParticipantId, target.conversationId)) this.agentTargets.set(sessionId, target)
    }))
    this.disposers.push(on('chatluna/agent-status', ({ agent, status }) => {
      const sessionId = readAgentSessionId(agent)
      const target = sessionId ? this.agentTargets.get(sessionId) : undefined
      if (!sessionId || !target) return
      if (status === 'busy') this.begin(sessionId, target)
      else this.finish(sessionId)
    }))
    this.disposers.push(on('chatluna/agent-step', ({ agent, step }) => {
      const sessionId = readAgentSessionId(agent)
      const target = sessionId ? this.agentTargets.get(sessionId) : undefined
      if (!sessionId || !target) return
      this.recordStep(sessionId, target, step)
    }))
  }

  /** 机器人此刻发出的回复出自哪一步模型调用；会话里出现新的用户消息后清空，命令回复不会沿用上一轮。 */
  traceFor(botParticipantId: string, conversationId: string): SandboxMessageTraceReference | undefined {
    const trace = this.latestTraces.get(createStateKey(botParticipantId, conversationId))
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
    this.latestTraces.clear()
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
    const inputTokens = readNumber(step.usage.inputTokens)
    const outputTokens = readNumber(step.usage.outputTokens)
    const totalTokens = readNumber(step.usage.totalTokens) || inputTokens + outputTokens
    state.usage = {
      inputTokens: (state.usage?.inputTokens ?? 0) + inputTokens,
      outputTokens: (state.usage?.outputTokens ?? 0) + outputTokens,
      totalTokens: (state.usage?.totalTokens ?? 0) + totalTokens,
    }
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
    for (const map of [this.latestTraces, this.pendingResults]) {
      for (const key of [...map.keys()]) {
        const [botParticipantId = '', conversationId = ''] = key.split('\u0000')
        if (predicate({ botParticipantId, conversationId })) map.delete(key)
      }
    }
  }
}

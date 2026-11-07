import { requestAt, type MessageEntry, type SessionEntry, type SessionStore } from '@chatluna/session'
import { findChatLunaRuntime, readRecord, SandboxChatLunaError } from './runtime'

/**
 * 被测机器人的模型调用：读 ChatLuna v2 会话日志里每一步的请求与响应，与 trace 页同源。
 *
 * 一步模型调用在会话日志里落成一条 assistant 消息（`meta.turn`、`meta.step` 标出位置），请求由
 * `@chatluna/session` 的 `requestAt` 按那条消息之前的 prompt 标记与历史消息重建——trace 页的「请求」
 * 面板用的也是它。因此这里给出的是 v2 归一化后的请求与响应，不是供应商的原始 HTTP 报文。
 *
 * 会话日志由 v2 管理，沙盒不另存一份：存储与保留策略都跟随 v2，读不到就是 v2 已经没有这份记录。
 */

/** 一步模型调用的位置与摘要，供挑选要展开的那一步。 */
export interface SandboxModelCallSummary {
  /** 会话日志里这一步 assistant 消息的序号，展开时按它取请求。 */
  seq: number
  turn: number
  step: number
  time: number
  text: string
  toolCalls: string[]
  usage?: unknown
  finish?: unknown
  timing?: unknown
}

export interface SandboxModelCallRequestOptions {
  /** 只给请求里最后这么多条消息；省略时给全部。 */
  lastMessages?: number
  /** 带上工具的完整参数 schema；默认只给名字与说明。 */
  includeToolSchemas?: boolean
}

export interface SandboxModelCallDetail extends SandboxModelCallSummary {
  request?: {
    config: unknown
    system?: string
    tools: unknown[]
    messageCount: number
    messages: unknown[]
  }
  /** 请求重建失败的原因；响应照常给出。 */
  requestError?: string
  response: {
    content: unknown
    raw?: unknown
  }
}

export interface SandboxModelCallReader {
  /** 会话里的全部模型调用，按时间正序；会话不存在时为 undefined。 */
  list(sessionId: string): Promise<SandboxModelCallSummary[] | undefined>
  /** 某一步的请求与响应；会话或这一步不存在时为 undefined。 */
  get(sessionId: string, seq: number, options?: SandboxModelCallRequestOptions): Promise<SandboxModelCallDetail | undefined>
}

const PREVIEW_LENGTH = 200
/** 超过这个长度、且只由 Base64 字符组成的字符串按内联媒体处理，不原样返回。 */
const INLINE_DATA_THRESHOLD = 4096

function isMessageEntry(entry: SessionEntry | undefined): entry is MessageEntry {
  return entry?.kind === 'message'
}

function readBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    const record = readRecord(block)
    return record ? [record] : []
  })
}

function blocksText(content: unknown): string {
  return readBlocks(content)
    .flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return [block.text]
      if (block.type === 'envelope') return [blocksText(block.content)]
      return []
    })
    .filter(Boolean)
    .join('\n')
}

function toSummary(entry: MessageEntry): SandboxModelCallSummary | undefined {
  const meta = entry.message.meta
  if (entry.message.role !== 'assistant' || typeof meta?.turn !== 'number' || typeof meta.step !== 'number') return
  const text = blocksText(entry.message.content)
  return {
    seq: entry.n,
    turn: meta.turn,
    step: meta.step,
    time: entry.time,
    text: text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text,
    toolCalls: readBlocks(entry.message.content).flatMap((block) => (
      block.type === 'tool-call' && typeof block.toolName === 'string' ? [block.toolName] : []
    )),
    ...(meta.usage === undefined ? {} : { usage: meta.usage }),
    ...(meta.finish === undefined ? {} : { finish: meta.finish }),
    ...(meta.timing === undefined ? {} : { timing: meta.timing }),
  }
}

/**
 * 把内联媒体换成占位：一张图的 Base64 就能撑满调用方的上下文，而排查请求时只需要知道那里有一张图。
 */
export function elideInlineData(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > INLINE_DATA_THRESHOLD && /^[A-Za-z0-9+/=\r\n]+$/.test(value)
      ? `[内联数据已省略，${value.length} 字符]`
      : value
  }
  if (Array.isArray(value)) return value.map(elideInlineData)
  const record = readRecord(value)
  if (!record) return value
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, elideInlineData(item)]))
}

/**
 * 默认读本插件所在实例里的 v2 会话日志。
 *
 * 进行中的会话先问 agent 自己的会话句柄：它持有正在写入的那份存储；已关闭的会话读 `session_store`。
 * 两者都按名称现取，理由同 `findChatLunaRuntime`。
 */
export class SandboxChatLunaModelCalls implements SandboxModelCallReader {
  constructor(private host: unknown) {}

  private storeOf(sessionId: string): SessionStore {
    const agents = findChatLunaRuntime(this.host, 'agents', (service) => (typeof service.get === 'function' ? service : undefined))
    const agent = readRecord(agents ? (agents.get as (id: string) => unknown).call(agents, sessionId) : undefined)
    const session = readRecord(agent?.session)
    if (typeof session?.getStore === 'function') return (session.getStore as () => SessionStore).call(session)
    const store = findChatLunaRuntime(this.host, 'session_store', (service) => (
      typeof service.read === 'function' && typeof service.head === 'function' ? service : undefined
    ))
    if (!store) throw new SandboxChatLunaError('unavailable', 'ChatLuna 的会话存储没有加载，读不到模型调用')
    return store as unknown as SessionStore
  }

  private async readEntries(sessionId: string, store: SessionStore): Promise<MessageEntry[] | undefined> {
    const id = sessionId as Parameters<SessionStore['read']>[0]
    if (!(await store.head(id))) return undefined
    return (await store.read(id, { kind: 'message' })).filter(isMessageEntry)
  }

  async list(sessionId: string): Promise<SandboxModelCallSummary[] | undefined> {
    const entries = await this.readEntries(sessionId, this.storeOf(sessionId))
    return entries?.flatMap((entry) => toSummary(entry) ?? [])
  }

  async get(sessionId: string, seq: number, options: SandboxModelCallRequestOptions = {}): Promise<SandboxModelCallDetail | undefined> {
    const store = this.storeOf(sessionId)
    const id = sessionId as Parameters<SessionStore['read']>[0]
    if (!(await store.head(id))) return undefined
    const [entry] = await store.read(id, { from: seq, before: seq + 1 })
    if (!isMessageEntry(entry)) return undefined
    const summary = toSummary(entry)
    if (!summary) return undefined
    const response = {
      content: elideInlineData(entry.message.content),
      ...(entry.message.meta?.raw === undefined ? {} : { raw: elideInlineData(entry.message.meta.raw) }),
    }
    try {
      const request = await requestAt(store, id, seq)
      const messages = options.lastMessages === undefined ? request.messages : request.messages.slice(-options.lastMessages)
      return {
        ...summary,
        request: {
          config: request.config,
          ...(request.system === undefined ? {} : { system: request.system }),
          tools: (request.tools ?? []).map((tool) => (
            options.includeToolSchemas ? tool : { name: tool.name, ...(tool.description ? { description: tool.description } : {}) }
          )),
          messageCount: request.messages.length,
          messages: messages.map(elideInlineData),
        },
        response,
      }
    } catch (error) {
      return { ...summary, requestError: error instanceof Error ? error.message : String(error), response }
    }
  }
}

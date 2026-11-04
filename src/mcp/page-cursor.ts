import { requireString } from './arguments'
import { SandboxMcpError } from './types'

/**
 * 分页游标：四个 list 工具对外唯一的翻页位置。
 *
 * 三族记录的排序键真的不一样——OneBot 调试记录只有每个记录域各自独立的 `sequence`，模型请求记录
 * 在单记录域用 `sequence`、跨记录域用 `createdAt` + `id`，会话列表与测试调用记录整份在内存里、
 * 只有偏移。把这些差异写进对外声明就一定会出现「哪个参数有效取决于另一个参数的取值」，而那是
 * 收敛前最坏的一处：`scope: 'all'` 时 `beforeSequence` 被静默置空，翻页翻不动却不报错，消费者
 * 一直拿到同一页。
 *
 * 因此对外只有一个不透明字符串，编码内容按记录种类各自决定，不追求统一的载荷。种类标记让「把
 * 调试记录的游标传给模型请求工具」这种误用被认出来并报 `invalid_arguments`，而不是当成一个碰巧
 * 能解析的游标。游标里刻意不藏可长期使用的语义：纪元或表结构变化时它就该失效。
 */

/** 一族记录的分页游标种类。它标的是记录种类而不是工具，因此同一族记录的读取工具共用一种。 */
export const SANDBOX_PAGE_CURSOR_KINDS = [
  'conversations',
  'onebot-debug-records',
  'model-request-records',
  'test-call-records',
] as const

export type SandboxPageCursorKind = typeof SANDBOX_PAGE_CURSOR_KINDS[number]

/** 按偏移续页：会话列表与测试调用记录整份可见，偏移就是它们今天的续页字段。 */
export interface SandboxOffsetPageCursor {
  offset: number
}

/** 按记录域内序号续页。序号是每个记录域各自独立的计数，因此它只在单记录域读取时有意义。 */
export interface SandboxSequencePageCursor {
  sequence: number
}

/** 按时间与记录标识续页，用于联邦读取：序号跨记录域不可比，时间加标识可比。 */
export interface SandboxTimePageCursor {
  createdAt: string
  id: string
}

/**
 * 每种记录各自的游标载荷。
 *
 * 模型请求记录是唯一有两种载荷的一族，因为它的两条读取路径（单记录域与联邦）排序键不同；哪一种
 * 载荷配哪种 `scope` 由工具执行体判定，不在本模块——本模块只保证解析出来的载荷形状是完整的。
 */
export interface SandboxPageCursorPayloads {
  conversations: SandboxOffsetPageCursor
  'onebot-debug-records': SandboxSequencePageCursor
  'model-request-records': SandboxSequencePageCursor | SandboxTimePageCursor
  'test-call-records': SandboxOffsetPageCursor
}

/** 记录种类的中文名，只用于误用时的错误消息——错误本身就该是文档。 */
const PAGE_CURSOR_LABELS: Record<SandboxPageCursorKind, string> = {
  conversations: '会话列表',
  'onebot-debug-records': 'OneBot 调试记录',
  'model-request-records': '模型请求记录',
  'test-call-records': '测试调用记录',
}

const UNREADABLE_RECOVERY = '请原样传回上一页结果里的 nextPageCursor；游标由服务端编码，不要自己拼。'

export function encodePageCursor<K extends SandboxPageCursorKind>(
  kind: K,
  payload: SandboxPageCursorPayloads[K],
): string {
  return Buffer.from(JSON.stringify({ kind, ...payload }), 'utf8').toString('base64url')
}

/**
 * 取参数里的分页游标；省略即 undefined，其余一切非法形态都显式失败。
 *
 * 伪造与截断的游标必须报错而不是当成「从头开始」：后者会让消费者以为自己在续页，实际每次都拿到
 * 第一页，与 `scope: 'all'` 收敛前的失败形态一模一样。
 */
export function readPageCursor<K extends SandboxPageCursorKind>(
  args: Record<string, unknown>,
  kind: K,
): SandboxPageCursorPayloads[K] | undefined {
  if (args.pageCursor === undefined) return undefined
  const encoded = requireString(args.pageCursor, 'pageCursor')
  const decoded = decodePageCursorBody(encoded)
  const declared = decoded.kind
  if (!isPageCursorKind(declared)) throw unreadablePageCursor()
  if (declared !== kind) {
    throw new SandboxMcpError(
      'invalid_arguments',
      `pageCursor 是${PAGE_CURSOR_LABELS[declared]}的分页位置，不能用于${PAGE_CURSOR_LABELS[kind]}`,
      false,
      '请传回本工具上一页返回的 nextPageCursor。',
    )
  }
  return requirePageCursorPayload(kind, decoded)
}

/** 序号载荷与时间载荷的判别。两种载荷只有模型请求记录会同时出现，判别写在这里一份。 */
export function isSequencePageCursor(
  payload: SandboxSequencePageCursor | SandboxTimePageCursor,
): payload is SandboxSequencePageCursor {
  return 'sequence' in payload
}

function decodePageCursorBody(encoded: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw unreadablePageCursor()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadablePageCursor()
  return parsed as Record<string, unknown>
}

function isPageCursorKind(value: unknown): value is SandboxPageCursorKind {
  return typeof value === 'string' && (SANDBOX_PAGE_CURSOR_KINDS as readonly string[]).includes(value)
}

/** 每种记录各自怎么读自己的载荷。表与载荷类型同键，因此新增一种记录漏写读取器过不了类型检查。 */
const PAGE_CURSOR_PAYLOAD_READERS: {
  [K in SandboxPageCursorKind]: (decoded: Record<string, unknown>) => SandboxPageCursorPayloads[K] | undefined
} = {
  conversations: readOffsetPayload,
  'onebot-debug-records': readSequencePayload,
  // 两种载荷都合法：单记录域给序号，联邦给时间加标识。带了 sequence 键就按序号读，因此一个
  // 序号写坏的游标报的是无法解析，而不是掉进时间载荷再报缺 createdAt。
  'model-request-records': (decoded) => ('sequence' in decoded ? readSequencePayload(decoded) : readTimePayload(decoded)),
  'test-call-records': readOffsetPayload,
}

/**
 * 校验载荷字段齐全。
 *
 * 截断的游标经 base64url 解码后往往仍是一段合法 JSON 的前缀，因此「能解析」不等于「能用」：
 * 少一个字段就按无法解析拒绝，而不是拿 undefined 去查库。
 */
function requirePageCursorPayload<K extends SandboxPageCursorKind>(
  kind: K,
  decoded: Record<string, unknown>,
): SandboxPageCursorPayloads[K] {
  const read = PAGE_CURSOR_PAYLOAD_READERS[kind] as (
    decoded: Record<string, unknown>,
  ) => SandboxPageCursorPayloads[K] | undefined
  const payload = read(decoded)
  if (!payload) throw unreadablePageCursor()
  return payload
}

function readOffsetPayload(decoded: Record<string, unknown>): SandboxOffsetPageCursor | undefined {
  const { offset } = decoded
  return Number.isInteger(offset) && (offset as number) >= 0 ? { offset: offset as number } : undefined
}

function readSequencePayload(decoded: Record<string, unknown>): SandboxSequencePageCursor | undefined {
  const { sequence } = decoded
  return Number.isInteger(sequence) && (sequence as number) >= 1 ? { sequence: sequence as number } : undefined
}

function readTimePayload(decoded: Record<string, unknown>): SandboxTimePageCursor | undefined {
  const { createdAt, id } = decoded
  if (typeof createdAt !== 'string' || !createdAt || typeof id !== 'string' || !id) return undefined
  return { createdAt, id }
}

function unreadablePageCursor(): SandboxMcpError {
  return new SandboxMcpError('invalid_arguments', 'pageCursor 无法解析', false, UNREADABLE_RECOVERY)
}

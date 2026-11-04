import { createHash } from 'node:crypto'
import { LARGE_BASE64_CHAR_THRESHOLD } from '../onebot-debug'
import type { SandboxTestCallRecord, SandboxTestCallRecordListItem, SandboxTestCallTransport, SandboxMcpError } from './types'

const SENSITIVE_KEY_PATTERN = /authorization|access[_-]?token|(?:^|_)token$|secret|password|cookie|private[_-]?key|confirmation[_-]?token|data[_-]?base64/i
const BASE64_BODY_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * 测试调用记录的每页条数，与另外三个 list 工具取同一组数值。
 *
 * 记录页本身是共享类型（Console 与 WebQQ 的测试调用记录页读它），因此分页发生在测试控制端点
 * 自己那一侧：本模块只声明数值，切页由工具执行体做。保留上限 500 条时一次全返回的旧行为随
 * 分页一起消失，那正是补上限的理由。
 */
export const DEFAULT_TEST_CALL_PAGE_SIZE = 50
export const MAX_TEST_CALL_PAGE_SIZE = 200

export interface ListSandboxTestCallRecordsInput {
  tool?: string
  credentialName?: string
  /** 按承载调用的协议表述筛选；省略时同时返回 MCP 与 HTTP 两种来路的记录。 */
  transport?: SandboxTestCallTransport
  spaceId?: string
  testRunId?: string
  /** 按调用结果筛选；省略时两种结果都返回。 */
  status?: SandboxTestCallRecordListItem['status']
  /** 按创建时间正序或倒序，默认倒序。 */
  order?: 'asc' | 'desc'
}

export interface SandboxTestCallRecordsPage {
  records: SandboxTestCallRecordListItem[]
}

export function redactTestCallValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[已脱敏]'
  // 与 OneBot 调试记录同口径：只脱敏凭证类键，content/message/text 逐字保留。
  if (typeof value === 'string') return foldLargeBase64(value)
  if (Array.isArray(value)) return value.map((item) => redactTestCallValue(item, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactTestCallValue(entryValue, entryKey),
  ]))
}

export function resolveTestCallSpaceId(args: Record<string, unknown>, result?: unknown): string | undefined {
  if (typeof args.spaceId === 'string' && args.spaceId.trim()) return args.spaceId
  if (result && typeof result === 'object') {
    const spaceId = Reflect.get(result, 'spaceId')
    if (typeof spaceId === 'string' && spaceId.trim()) return spaceId
  }
}

export function toTestCallRecordListItem(record: SandboxTestCallRecord): SandboxTestCallRecordListItem {
  return {
    id: record.id,
    createdAt: record.createdAt,
    credentialName: record.credentialName,
    transport: record.transport,
    ...(record.sourceIp ? { sourceIp: record.sourceIp } : {}),
    tool: record.tool,
    ...(record.testRunId ? { testRunId: record.testRunId } : {}),
    ...(record.spaceId ? { spaceId: record.spaceId } : {}),
    durationMs: record.durationMs,
    status: record.status,
    affected: [...record.affected],
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  }
}

export function presentTestCallRecord(record: SandboxTestCallRecord): SandboxTestCallRecord {
  return {
    ...toTestCallRecordListItem(record),
    arguments: structuredClone(record.arguments),
    result: structuredClone(record.result),
    error: record.error ? structuredClone(record.error) : undefined,
  }
}

export function matchesTestCallRecordFilter(record: SandboxTestCallRecord, input: ListSandboxTestCallRecordsInput = {}): boolean {
  if (input.tool && record.tool !== input.tool) return false
  if (input.credentialName && record.credentialName !== input.credentialName) return false
  if (input.transport && record.transport !== input.transport) return false
  if (input.spaceId && record.spaceId !== input.spaceId) return false
  if (input.testRunId && record.testRunId !== input.testRunId) return false
  if (input.status && record.status !== input.status) return false
  return true
}

export function summarizeTestCallError(error: SandboxMcpError): NonNullable<SandboxTestCallRecord['error']> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    recovery: error.recovery,
    ...(error.details === undefined ? {} : { details: redactTestCallValue(error.details) }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  }
}

function foldLargeBase64(value: string): unknown {
  const trimmed = value.trim()
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,(.+)$/s)
  if (dataUrl && dataUrl[2].length > LARGE_BASE64_CHAR_THRESHOLD && isBase64Body(dataUrl[2])) {
    return summarizeLargeValue('data-url', dataUrl[2], dataUrl[1].trim().toLowerCase() || undefined)
  }
  if (trimmed.startsWith('base64://')) {
    const body = trimmed.slice('base64://'.length)
    if (body.length > LARGE_BASE64_CHAR_THRESHOLD && isBase64Body(body)) {
      return summarizeLargeValue('base64', body)
    }
    return value
  }
  if (trimmed.length > LARGE_BASE64_CHAR_THRESHOLD && isBase64Body(trimmed)) {
    return summarizeLargeValue('base64', trimmed)
  }
  return value
}

function summarizeLargeValue(encoding: 'base64' | 'data-url', body: string, mimeType?: string) {
  const byteLength = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
  return {
    kind: 'large-value',
    encoding,
    ...(mimeType ? { mimeType } : {}),
    charCount: body.length,
    byteLength: Math.max(0, byteLength),
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

function isBase64Body(value: string): boolean {
  if (value.length < 16 || value.length % 4 !== 0) return false
  return BASE64_BODY_PATTERN.test(value)
}

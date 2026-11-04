import type { SandboxModelRequestRecord, SandboxModelRequestUsage } from '../types'

interface ModelRequestStoreLike {
  getRawRecords(input?: { limit?: number }): Promise<SandboxModelRequestRecord[]>
  update(recordId: string, input: { chatlunaRequestId?: string }): unknown
}

export interface ChatLunaUsageListRow {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedTokens: number
  reasoningTokens: number
  estimated?: boolean
  model: string
  createdAt: Date | string
  ttftMs?: number | null
  totalMs?: number | null
  tps?: number | null
  requestId?: string | null
}

export interface ChatLunaUsageLookup {
  list(input?: {
    start?: Date | string
    end?: Date | string
    model?: string
    pageSize?: number
    listSortBy?: 'createdAt'
    listDesc?: boolean
  }): Promise<{ rows: ChatLunaUsageListRow[] }>
}

export interface ChatLunaModelUsageEvent {
  model?: string
  createdAt?: Date | string
  context?: { requestId?: string }
}

const USAGE_MATCH_WINDOW_MS = 60_000

export function toSandboxModelRequestUsage(row: ChatLunaUsageListRow): SandboxModelRequestUsage {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cachedTokens: row.cachedTokens,
    totalTokens: row.totalTokens,
    ...(row.ttftMs != null ? { ttftMs: row.ttftMs } : {}),
    ...(row.totalMs != null ? { totalMs: row.totalMs } : {}),
    ...(row.tps != null ? { tps: row.tps } : {}),
    ...(row.estimated !== undefined ? { estimated: row.estimated } : {}),
    source: 'chatluna-usage',
  }
}

export async function linkChatLunaUsageRequest(
  stores: ModelRequestStoreLike[],
  payload: ChatLunaModelUsageEvent,
): Promise<string | undefined> {
  const requestId = payload.context?.requestId?.trim()
  if (!requestId) return
  const createdAt = payload.createdAt ? Date.parse(String(payload.createdAt)) : Date.now()
  let best: { store: ModelRequestStoreLike, record: SandboxModelRequestRecord, score: number } | undefined
  for (const store of stores) {
    for (const record of await store.getRawRecords({ limit: 50 })) {
      if (record.chatlunaRequestId) continue
      const delta = Math.abs(Date.parse(record.createdAt) - createdAt)
      if (!Number.isFinite(delta) || delta > USAGE_MATCH_WINDOW_MS) continue
      const modelScore = modelsOverlap(record.model, payload.model) ? 0 : 10_000
      const score = delta + modelScore
      if (!best || score < best.score) best = { store, record, score }
    }
  }
  if (!best) return
  best.store.update(best.record.id, { chatlunaRequestId: requestId })
  return best.record.id
}

export async function lookupChatLunaUsage(
  service: ChatLunaUsageLookup | undefined,
  record: Pick<SandboxModelRequestRecord, 'createdAt' | 'durationMs' | 'model' | 'chatlunaRequestId'>,
): Promise<SandboxModelRequestUsage | undefined> {
  if (!service) return
  const createdAt = Date.parse(record.createdAt)
  if (!Number.isFinite(createdAt)) return
  const listed = await service.list({
    start: new Date(createdAt - 30_000),
    end: new Date(createdAt + Math.max(record.durationMs, 0) + 30_000),
    pageSize: 50,
    listSortBy: 'createdAt',
    listDesc: true,
  })
  const rows = listed.rows ?? []
  const matched = record.chatlunaRequestId
    ? rows.find((row) => row.requestId === record.chatlunaRequestId)
    : undefined
  const row = matched ?? pickClosestUsageRow(rows, record)
  return row ? toSandboxModelRequestUsage(row) : undefined
}

function pickClosestUsageRow(
  rows: ChatLunaUsageListRow[],
  record: Pick<SandboxModelRequestRecord, 'createdAt' | 'model'>,
): ChatLunaUsageListRow | undefined {
  const createdAt = Date.parse(record.createdAt)
  let best: { row: ChatLunaUsageListRow, score: number } | undefined
  for (const row of rows) {
    const delta = Math.abs(Date.parse(String(row.createdAt)) - createdAt)
    if (!Number.isFinite(delta) || delta > USAGE_MATCH_WINDOW_MS) continue
    const score = delta + (modelsOverlap(record.model, row.model) ? 0 : 10_000)
    if (!best || score < best.score) best = { row, score }
  }
  return best?.row
}

function modelsOverlap(left?: string, right?: string): boolean {
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

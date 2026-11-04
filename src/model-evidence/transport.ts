import { source } from './shared'
import type { ModelEvidenceDiagnostic, ModelEvidenceTransport } from './types'

/** 一个待语义解释的响应 payload。`streaming` 说明它来自 SSE 分片而不是完整响应体。 */
export interface ResponsePayload {
  path: readonly string[]
  value: unknown
  streaming: boolean
}

export interface ResponseTransportEvidence {
  transport: ModelEvidenceTransport
  payloads: ResponsePayload[]
  diagnostics: ModelEvidenceDiagnostic[]
}

const DONE_MARKER = '[DONE]'

export function parseResponseTransport(
  raw: string | undefined,
  format: 'json' | 'text' | 'sse' | undefined,
): ResponseTransportEvidence {
  if (raw === undefined || raw === '') {
    return { transport: { kind: 'empty' }, payloads: [], diagnostics: [] }
  }
  if (format === 'sse') return parseSse(raw)
  if (format === 'text') {
    return { transport: { kind: 'text', value: raw }, payloads: [{ path: [], value: raw, streaming: false }], diagnostics: [] }
  }
  try {
    const value = JSON.parse(raw) as unknown
    return { transport: { kind: 'json', value }, payloads: [{ path: [], value, streaming: false }], diagnostics: [] }
  } catch {
    // 声明为 JSON 却解析失败是损坏证据，不是纯文本响应：保留原文并显式报告。
    return {
      transport: { kind: 'text', value: raw },
      payloads: [],
      diagnostics: format === 'json'
        ? [{ code: 'response-body-malformed', severity: 'error', source: source('response', [], raw) }]
        : [],
    }
  }
}

function parseSse(raw: string): ResponseTransportEvidence {
  const events: Array<Record<string, unknown>> = []
  const payloads: ResponsePayload[] = []
  const diagnostics: ModelEvidenceDiagnostic[] = []

  for (const block of raw.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    if (!block.trim()) continue
    const data: string[] = []
    let event = 'message'
    let id: string | undefined
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const separator = line.indexOf(':')
      const field = separator < 0 ? line : line.slice(0, separator)
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
      if (field === 'data') data.push(value)
      else if (field === 'event') event = value || 'message'
      else if (field === 'id') id = value
    }
    const rawData = data.join('\n')
    if (!rawData && event === 'message' && id === undefined) continue

    const index = events.length
    let parsed: unknown = rawData
    let malformed = false
    if (rawData !== DONE_MARKER) {
      try {
        parsed = JSON.parse(rawData)
      } catch {
        // 非 JSON data 仍按 SSE 原文保留，让其他事件继续可复盘。
        malformed = true
      }
    }
    events.push({ ...(id !== undefined ? { id } : {}), event, data: parsed })
    if (rawData === DONE_MARKER) continue
    if (malformed) {
      diagnostics.push({
        code: 'response-body-malformed',
        severity: 'error',
        source: source('response', [String(index), 'data'], rawData),
      })
      continue
    }
    payloads.push({ path: [String(index), 'data'], value: parsed, streaming: true })
  }

  return { transport: { kind: 'sse', value: events }, payloads, diagnostics }
}

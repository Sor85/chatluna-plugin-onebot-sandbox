import {
  evidenceId,
  isRecord,
  normalizeToolOutput,
  readCallId,
  readCallObjectId,
  readToolName,
  source,
  stringifyValue,
  stringValue,
} from './shared'
import { parseResponseTransport, type ResponsePayload } from './transport'
import { mergeUsage, normalizeUsageCandidate } from './usage'
import type {
  ModelEvidenceDiagnostic,
  ModelEvidenceResponseEvent,
  ModelEvidenceResponseEventKind,
  ModelEvidenceSource,
  ModelEvidenceTransport,
} from './types'

export interface ResponseEvidence {
  transport: ModelEvidenceTransport
  events: ModelEvidenceResponseEvent[]
  diagnostics: ModelEvidenceDiagnostic[]
}

/** 已知协议里 delta 是增量，snapshot 是当前累计快照；两者的合并规则完全不同。 */
type Accumulation = 'delta' | 'snapshot'

interface EventDraft {
  kind: ModelEvidenceResponseEventKind
  /** 语义槽位。相同槽位的分片会被合并，且不含 transport 分片下标，保证刷新后身份稳定。 */
  slot: readonly string[]
  source: ModelEvidenceSource
  text?: string
  textAccumulation?: Accumulation
  name?: string
  callId?: string
  arguments?: string
  argumentsAccumulation?: Accumulation
  usage?: Record<string, unknown>
  /** 工具结果按调用标识、名称和内容去重，避免累计快照重复出现。 */
  dedupeKey?: string
}

interface MutableEvent {
  kind: ModelEvidenceResponseEventKind
  slot: readonly string[]
  text?: string
  name?: string
  callId?: string
  arguments?: string
  usage?: Record<string, unknown>
  sources: ModelEvidenceSource[]
  sourceKeys: Set<string>
}

const ANTHROPIC_EVENT_TYPES = new Set([
  'message', 'message_start', 'message_delta', 'message_stop',
  'content_block_start', 'content_block_delta', 'content_block_stop', 'ping',
])

const AI_SDK_PART_TYPES = new Set([
  'text', 'text-start', 'text-delta', 'text-end',
  'reasoning', 'reasoning-start', 'reasoning-delta', 'reasoning-end',
  'tool-input-start', 'tool-input-delta', 'tool-call', 'tool-result', 'tool-output',
  'finish', 'finish-step', 'error',
])

export function projectResponseEvidence(
  raw: string | undefined,
  format: 'json' | 'text' | 'sse' | undefined,
): ResponseEvidence {
  const { transport, payloads, diagnostics } = parseResponseTransport(raw, format)
  const collector = createCollector()
  for (const payload of payloads) projectPayload(payload, payload.value, payload.path, collector, diagnostics)
  return { transport, events: collector.events(), diagnostics }
}

interface Collector {
  collect: (draft: EventDraft) => void
  events: () => ModelEvidenceResponseEvent[]
}

function createCollector(): Collector {
  const order: string[] = []
  const byKey = new Map<string, MutableEvent>()
  const dedupe = new Map<string, string>()

  return {
    collect: (draft) => {
      const key = draft.dedupeKey !== undefined
        ? dedupe.get(draft.dedupeKey) ?? `${draft.kind}|${draft.slot.join('.')}`
        : `${draft.kind}|${draft.slot.join('.')}`
      if (draft.dedupeKey !== undefined && !dedupe.has(draft.dedupeKey)) dedupe.set(draft.dedupeKey, key)

      let event = byKey.get(key)
      if (!event) {
        event = { kind: draft.kind, slot: draft.slot, sources: [], sourceKeys: new Set() }
        byKey.set(key, event)
        order.push(key)
      }
      const sourceKey = draft.source.path.join('.')
      if (!event.sourceKeys.has(sourceKey)) {
        event.sourceKeys.add(sourceKey)
        event.sources.push(draft.source)
      }
      if (draft.text !== undefined) {
        event.text = accumulate(event.text, draft.text, draft.textAccumulation ?? 'snapshot')
      }
      if (draft.arguments !== undefined) {
        event.arguments = accumulate(event.arguments, draft.arguments, draft.argumentsAccumulation ?? 'snapshot')
      }
      if (draft.name && !event.name) event.name = draft.name
      if (draft.callId && !event.callId) event.callId = draft.callId
      if (draft.usage) event.usage = mergeUsage(event.usage, draft.usage)
    },
    events: () => order.flatMap((key) => {
      const event = byKey.get(key)
      if (!event) return []
      const normalizedUsage = event.usage ? normalizeUsageCandidate(event.usage) : undefined
      return [{
        evidenceId: evidenceId('response', event.kind, event.slot),
        kind: event.kind,
        ...(event.text !== undefined ? { text: event.text } : {}),
        ...(event.name !== undefined ? { name: event.name } : {}),
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
        ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(normalizedUsage ? { normalizedUsage } : {}),
        sources: event.sources,
      }]
    }),
  }
}

function accumulate(existing: string | undefined, incoming: string, mode: Accumulation): string {
  if (existing === undefined) return incoming
  if (mode === 'delta') return `${existing}${incoming}`
  // 累计快照：内容相同直接去重，否则以最新快照为准。
  if (incoming === existing) return existing
  return incoming
}

interface PayloadContext {
  path: readonly string[]
  streaming: boolean
  collect: (draft: EventDraft) => void
}

function projectPayload(
  payload: ResponsePayload,
  value: unknown,
  path: readonly string[],
  collector: Collector,
  diagnostics: ModelEvidenceDiagnostic[],
): void {
  if (typeof value === 'string') {
    if (!value) return
    // 非结构化正文本身就是可见输出，保留为 TEXT 证据而不是判定为空响应。
    collector.collect({
      kind: 'content',
      slot: ['body'],
      text: value,
      textAccumulation: 'snapshot',
      source: source('response', path, value),
    })
    return
  }
  if (!isRecord(value)) {
    unknownPayload(value, path, collector, diagnostics, 'response-payload-unsupported')
    return
  }

  const context: PayloadContext = { path, streaming: payload.streaming, collect: collector.collect }
  const matched = ADAPTERS.filter(adapter => adapter.matches(value))
  if (matched.length > 1) {
    // 同一节点被多个同等可信 adapter 匹配：不能合并重复推测结果。
    unknownPayload(value, path, collector, diagnostics, 'response-payload-ambiguous')
    collectUsage(value, path, collector)
    return
  }
  if (matched.length === 1) {
    matched[0]!.project(value, context, payload, collector, diagnostics)
    collectUsage(value, path, collector)
    return
  }
  const usageOnly = collectUsage(value, path, collector)
  if (!usageOnly) unknownPayload(value, path, collector, diagnostics, 'response-payload-unsupported')
}

function unknownPayload(
  value: unknown,
  path: readonly string[],
  collector: Collector,
  diagnostics: ModelEvidenceDiagnostic[],
  code: 'response-payload-unsupported' | 'response-payload-ambiguous',
): void {
  collector.collect({ kind: 'unknown', slot: ['unknown', ...path], source: source('response', path, value) })
  diagnostics.push({ code, severity: 'warning', source: source('response', path, value) })
}

function collectUsage(value: Record<string, unknown>, path: readonly string[], collector: Collector): boolean {
  let found = false
  for (const field of ['usage', 'usageMetadata'] as const) {
    const usage = value[field]
    if (!isRecord(usage)) continue
    found = true
    collector.collect({
      kind: 'usage',
      slot: ['usage'],
      usage,
      source: source('response', [...path, field], usage),
    })
  }
  return found
}

interface ResponseAdapter {
  matches: (payload: Record<string, unknown>) => boolean
  project: (
    payload: Record<string, unknown>,
    context: PayloadContext,
    origin: ResponsePayload,
    collector: Collector,
    diagnostics: ModelEvidenceDiagnostic[],
  ) => void
}

const openAiChatAdapter: ResponseAdapter = {
  matches: payload => Array.isArray(payload.choices),
  project: (payload, context) => {
    for (const [index, choice] of (payload.choices as unknown[]).entries()) {
      if (!isRecord(choice)) continue
      const choicePath = [...context.path, 'choices', String(index)]
      const container = isRecord(choice.message)
        ? { field: 'message', value: choice.message, accumulation: 'snapshot' as const }
        : isRecord(choice.delta)
          ? { field: 'delta', value: choice.delta, accumulation: 'delta' as const }
          : undefined
      if (container) {
        const base = [...choicePath, container.field]
        // 思考先于正文：与响应卡片的排版一致，轨迹和分析页看到同样的顺序。
        for (const field of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
          const text = stringValue(container.value[field])
          if (!text) continue
          context.collect({
            kind: 'reasoning',
            slot: ['choices', String(index), 'reasoning'],
            text,
            textAccumulation: container.accumulation,
            source: source('response', [...base, field], container.value[field]),
          })
        }
        addTextValue(context, container.value.content, [...base, 'content'], ['choices', String(index), 'content'], 'content', container.accumulation)
        if (Array.isArray(container.value.tool_calls)) {
          for (const [callIndex, call] of container.value.tool_calls.entries()) {
            if (!isRecord(call)) continue
            const fn = isRecord(call.function) ? call.function : call
            // 流式分片只有 index 稳定：后续分片常常不再带 id，用 id 做槽位会把同一次调用拆成两条。
            const slotKey = typeof call.index === 'number' ? String(call.index) : String(callIndex)
            context.collect({
              kind: 'tool-call',
              slot: ['choices', String(index), 'tool_calls', slotKey],
              ...(readToolName(fn) ? { name: readToolName(fn) } : {}),
              ...(readCallObjectId(call) ? { callId: readCallObjectId(call) } : {}),
              ...(fn.arguments === undefined ? {} : { arguments: stringifyArguments(fn.arguments), argumentsAccumulation: container.accumulation }),
              source: source('response', [...base, 'tool_calls', String(callIndex)], call),
            })
          }
        }
        if (isRecord(container.value.function_call)) {
          const call = container.value.function_call
          context.collect({
            kind: 'tool-call',
            slot: ['choices', String(index), 'function_call'],
            ...(readToolName(call) ? { name: readToolName(call) } : {}),
            ...(call.arguments === undefined ? {} : { arguments: stringifyArguments(call.arguments), argumentsAccumulation: container.accumulation }),
            source: source('response', [...base, 'function_call'], call),
          })
        }
      }
      for (const field of ['finish_reason', 'native_finish_reason'] as const) {
        const finish = stringValue(choice[field])
        if (!finish) continue
        context.collect({
          kind: 'finish-reason',
          slot: ['choices', String(index), field],
          text: finish,
          source: source('response', [...choicePath, field], choice[field]),
        })
      }
    }
  },
}

const anthropicAdapter: ResponseAdapter = {
  matches: payload => Array.isArray(payload.content)
    || isRecord(payload.content_block)
    || (isRecord(payload.delta) && typeof payload.delta.type === 'string')
    || ANTHROPIC_EVENT_TYPES.has(String(payload.type))
    || typeof payload.stop_reason === 'string',
  project: (payload, context, origin, collector, diagnostics) => {
    // message_start 是包装事件；显式委托子 payload，而不是在同一层猜测语义。
    if (isRecord(payload.message)) {
      projectPayload(origin, payload.message, [...context.path, 'message'], collector, diagnostics)
    }
    if (Array.isArray(payload.content)) {
      for (const [index, block] of payload.content.entries()) {
        if (!isRecord(block)) continue
        const blockPath = [...context.path, 'content', String(index)]
        const slot = ['content', String(index)]
        const type = String(block.type ?? '')
        if (type === 'text') {
          const text = stringValue(block.text)
          if (text) context.collect({ kind: 'content', slot, text, source: source('response', [...blockPath, 'text'], block.text) })
          continue
        }
        if (type === 'thinking') {
          const text = stringValue(block.thinking)
          if (text) context.collect({ kind: 'reasoning', slot, text, source: source('response', [...blockPath, 'thinking'], block.thinking) })
          continue
        }
        if (type === 'tool_use') {
          context.collect({
            kind: 'tool-call',
            slot,
            ...(readToolName(block) ? { name: readToolName(block) } : {}),
            ...(stringValue(block.id) ? { callId: stringValue(block.id) } : {}),
            ...(block.input === undefined ? {} : { arguments: stringifyArguments(block.input) }),
            source: source('response', blockPath, block),
          })
          continue
        }
        if (type === 'tool_result') {
          collectToolResult(context, block, blockPath, slot, block.content)
        }
      }
    }
    if (isRecord(payload.content_block)) {
      const blockSlot = ['content_block', typeof payload.index === 'number' ? String(payload.index) : '0']
      const block = payload.content_block
      if (String(block.type ?? '') === 'tool_use') {
        context.collect({
          kind: 'tool-call',
          slot: blockSlot,
          ...(readToolName(block) ? { name: readToolName(block) } : {}),
          ...(stringValue(block.id) ? { callId: stringValue(block.id) } : {}),
          source: source('response', [...context.path, 'content_block'], block),
        })
      }
    }
    if (isRecord(payload.delta)) {
      const delta = payload.delta
      const blockSlot = ['content_block', typeof payload.index === 'number' ? String(payload.index) : '0']
      const deltaPath = [...context.path, 'delta']
      if (delta.type === 'text_delta' && stringValue(delta.text)) {
        context.collect({ kind: 'content', slot: blockSlot, text: String(delta.text), textAccumulation: 'delta', source: source('response', [...deltaPath, 'text'], delta.text) })
      }
      if (delta.type === 'thinking_delta' && stringValue(delta.thinking)) {
        context.collect({ kind: 'reasoning', slot: blockSlot, text: String(delta.thinking), textAccumulation: 'delta', source: source('response', [...deltaPath, 'thinking'], delta.thinking) })
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        context.collect({ kind: 'tool-call', slot: blockSlot, arguments: delta.partial_json, argumentsAccumulation: 'delta', source: source('response', [...deltaPath, 'partial_json'], delta.partial_json) })
      }
      const stop = stringValue(delta.stop_reason)
      if (stop) context.collect({ kind: 'finish-reason', slot: ['stop_reason'], text: stop, source: source('response', [...deltaPath, 'stop_reason'], delta.stop_reason) })
    }
    const stop = stringValue(payload.stop_reason)
    if (stop) {
      context.collect({ kind: 'finish-reason', slot: ['stop_reason'], text: stop, source: source('response', [...context.path, 'stop_reason'], payload.stop_reason) })
    }
  },
}

const geminiAdapter: ResponseAdapter = {
  matches: payload => Array.isArray(payload.candidates),
  project: (payload, context) => {
    for (const [index, candidate] of (payload.candidates as unknown[]).entries()) {
      if (!isRecord(candidate)) continue
      const candidatePath = [...context.path, 'candidates', String(index)]
      if (isRecord(candidate.content) && Array.isArray(candidate.content.parts)) {
        for (const [partIndex, part] of candidate.content.parts.entries()) {
          if (!isRecord(part)) continue
          const partPath = [...candidatePath, 'content', 'parts', String(partIndex)]
          const reasoning = part.thought === true
          if (typeof part.text === 'string' && part.text) {
            // Gemini 流式把正文按分片下发，非流式则每个 part 是独立快照。
            context.collect({
              kind: reasoning ? 'reasoning' : 'content',
              slot: context.streaming
                ? ['candidates', String(index), reasoning ? 'thought' : 'content']
                : ['candidates', String(index), 'parts', String(partIndex)],
              text: part.text,
              textAccumulation: context.streaming ? 'delta' : 'snapshot',
              source: source('response', [...partPath, 'text'], part.text),
            })
          }
          if (isRecord(part.functionCall)) {
            const call = part.functionCall
            context.collect({
              kind: 'tool-call',
              slot: ['candidates', String(index), 'parts', String(partIndex)],
              ...(readToolName(call) ? { name: readToolName(call) } : {}),
              ...(stringValue(call.id) ? { callId: stringValue(call.id) } : {}),
              ...(call.args === undefined ? {} : { arguments: stringifyArguments(call.args) }),
              source: source('response', [...partPath, 'functionCall'], call),
            })
          }
        }
      }
      const finish = stringValue(candidate.finishReason)
      if (finish) {
        context.collect({
          kind: 'finish-reason',
          slot: ['candidates', String(index), 'finishReason'],
          text: finish,
          source: source('response', [...candidatePath, 'finishReason'], candidate.finishReason),
        })
      }
    }
  },
}

const responsesAdapter: ResponseAdapter = {
  matches: payload => Array.isArray(payload.output)
    || (typeof payload.type === 'string' && payload.type.startsWith('response.')),
  project: (payload, context, origin, collector, diagnostics) => {
    const type = stringValue(payload.type)
    if (type) {
      if (type.endsWith('.output_text.delta') && stringValue(payload.delta)) {
        context.collect({ kind: 'content', slot: ['output_text'], text: String(payload.delta), textAccumulation: 'delta', source: source('response', [...context.path, 'delta'], payload.delta) })
      }
      if (type.endsWith('.reasoning_summary_text.delta') && stringValue(payload.delta)) {
        context.collect({ kind: 'reasoning', slot: ['reasoning_summary_text'], text: String(payload.delta), textAccumulation: 'delta', source: source('response', [...context.path, 'delta'], payload.delta) })
      }
      if (type.endsWith('.function_call_arguments.delta')) {
        const itemId = stringValue(payload.item_id)
        context.collect({
          kind: 'tool-call',
          slot: ['item', itemId ?? 'function_call'],
          ...(readToolName(payload) ? { name: readToolName(payload) } : {}),
          ...(itemId ? { callId: itemId } : {}),
          ...(typeof payload.delta === 'string' ? { arguments: payload.delta, argumentsAccumulation: 'delta' as const } : {}),
          source: source('response', [...context.path, 'delta'], payload.delta),
        })
      }
      // response.completed 等事件把完整响应包在 response 里；显式委托而不是重复扫描。
      if (isRecord(payload.response)) {
        projectPayload(origin, payload.response, [...context.path, 'response'], collector, diagnostics)
      }
    }
    if (!Array.isArray(payload.output)) return
    for (const [index, item] of payload.output.entries()) {
      if (!isRecord(item)) continue
      const itemPath = [...context.path, 'output', String(index)]
      const slot = ['output', String(index)]
      const itemType = stringValue(item.type)
      if (itemType === 'message') {
        addTextValue(context, item.content, itemPath, slot, 'content', 'snapshot')
        continue
      }
      if (itemType === 'reasoning') {
        addTextValue(context, item.summary, itemPath, slot, 'reasoning', 'snapshot')
        continue
      }
      if (itemType === 'function_call') {
        context.collect({
          kind: 'tool-call',
          slot,
          ...(readToolName(item) ? { name: readToolName(item) } : {}),
          ...(stringValue(item.call_id) ? { callId: stringValue(item.call_id) } : {}),
          ...(item.arguments === undefined ? {} : { arguments: stringifyArguments(item.arguments) }),
          source: source('response', itemPath, item),
        })
        continue
      }
      if (itemType === 'function_call_output') {
        collectToolResult(context, item, itemPath, slot, item.output ?? item.result ?? item.content)
      }
    }
  },
}

const aiSdkAdapter: ResponseAdapter = {
  matches: payload => typeof payload.type === 'string' && AI_SDK_PART_TYPES.has(payload.type),
  project: (payload, context) => {
    const type = String(payload.type)
    const id = stringValue(payload.id) ?? stringValue(payload.toolCallId) ?? '0'
    if (type === 'text' || type === 'text-delta') {
      const text = stringValue(payload.text) ?? stringValue(payload.delta)
      if (text) {
        context.collect({
          kind: 'content',
          slot: ['text', id],
          text,
          textAccumulation: type === 'text-delta' ? 'delta' : 'snapshot',
          source: source('response', context.path, payload),
        })
      }
      return
    }
    if (type === 'reasoning' || type === 'reasoning-delta') {
      const text = stringValue(payload.text) ?? stringValue(payload.delta)
      if (text) {
        context.collect({
          kind: 'reasoning',
          slot: ['reasoning', id],
          text,
          textAccumulation: type === 'reasoning-delta' ? 'delta' : 'snapshot',
          source: source('response', context.path, payload),
        })
      }
      return
    }
    if (type === 'tool-input-delta') {
      context.collect({
        kind: 'tool-call',
        slot: ['tool', id],
        ...(typeof payload.delta === 'string' ? { arguments: payload.delta, argumentsAccumulation: 'delta' as const } : {}),
        source: source('response', context.path, payload),
      })
      return
    }
    if (type === 'tool-input-start' || type === 'tool-call') {
      const args = payload.input ?? payload.args ?? payload.arguments
      context.collect({
        kind: 'tool-call',
        slot: ['tool', id],
        ...(readToolName(payload) ? { name: readToolName(payload) } : {}),
        ...(readCallId(payload) ? { callId: readCallId(payload) } : {}),
        ...(args === undefined ? {} : { arguments: stringifyArguments(args) }),
        source: source('response', context.path, payload),
      })
      return
    }
    if (type === 'tool-result' || type === 'tool-output') {
      collectToolResult(context, payload, context.path, ['tool-result', id], payload.output ?? payload.result ?? payload.content)
      return
    }
    if (type === 'finish' || type === 'finish-step') {
      const reason = stringValue(payload.finishReason) ?? stringValue(payload.finish_reason)
      if (reason) {
        context.collect({ kind: 'finish-reason', slot: ['finishReason'], text: reason, source: source('response', context.path, payload) })
      }
    }
  },
}

const ADAPTERS: readonly ResponseAdapter[] = [
  openAiChatAdapter,
  responsesAdapter,
  anthropicAdapter,
  geminiAdapter,
  aiSdkAdapter,
]

function collectToolResult(
  context: PayloadContext,
  raw: Record<string, unknown>,
  path: readonly string[],
  slot: readonly string[],
  output: unknown,
): void {
  const callId = readCallId(raw)
  const name = readToolName(raw)
  const text = normalizeToolOutput(output)
  context.collect({
    kind: 'tool-result',
    slot,
    text,
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    dedupeKey: JSON.stringify(['tool-result', callId ?? '', name ?? '', text]),
    source: source('response', path, raw),
  })
}

function addTextValue(
  context: PayloadContext,
  value: unknown,
  path: readonly string[],
  slot: readonly string[],
  kind: 'content' | 'reasoning',
  accumulation: Accumulation,
): void {
  if (typeof value === 'string') {
    if (value) context.collect({ kind, slot, text: value, textAccumulation: accumulation, source: source('response', path, value) })
    return
  }
  if (!Array.isArray(value)) return
  const text = value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (!isRecord(item)) return []
    const part = stringValue(item.text) ?? stringValue(item.output_text) ?? stringValue(item.content)
    return part ? [part] : []
  }).join('')
  if (text) context.collect({ kind, slot, text, textAccumulation: accumulation, source: source('response', path, value) })
}

function stringifyArguments(value: unknown): string {
  return typeof value === 'string' ? value : stringifyValue(value)
}

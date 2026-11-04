import {
  evidenceId,
  isRecord,
  normalizeContentParts,
  normalizeGeminiPart,
  normalizeToolOutput,
  readCallId,
  readCallObjectId,
  readToolName,
  semanticText,
  source,
  stringifyValue,
  stringValue,
} from './shared'
import type {
  ModelEvidenceContentPart,
  ModelEvidenceDiagnostic,
  ModelEvidenceMessage,
  ModelEvidenceMessageRole,
  ModelEvidenceSource,
  ModelEvidenceToolCall,
  ModelEvidenceToolDefinition,
} from './types'

export interface RequestEvidence {
  messages: ModelEvidenceMessage[]
  toolDefinitions: ModelEvidenceToolDefinition[]
  diagnostics: ModelEvidenceDiagnostic[]
}

/** 顶层 System 字段。它们与主要会话容器正交，各自保留独立边界。 */
const SYSTEM_FIELDS = ['system', 'systemInstruction', 'system_instruction', 'instructions'] as const

/** 主要会话容器的确定性结构优先级。多个同时存在时只取第一个并报告歧义。 */
const PRIMARY_CONTAINERS = ['messages', 'contents', 'input'] as const

const ANTHROPIC_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'tool_use', 'tool_result'])

export function projectRequestEvidence(body: unknown): RequestEvidence {
  const evidence: RequestEvidence = { messages: [], toolDefinitions: [], diagnostics: [] }
  if (body === undefined) return evidence
  if (!isRecord(body)) {
    evidence.diagnostics.push(unsupported([], body))
    return evidence
  }

  let systemCount = 0
  for (const [field, value] of Object.entries(body)) {
    if (!isSystemField(field) || value === undefined || value === null) continue
    systemCount += projectSystemField(field, value, evidence)
  }

  const containers = PRIMARY_CONTAINERS.filter(name => isPrimaryContainer(name, body[name]))
  const [primary, ...ambiguous] = containers
  for (const name of ambiguous) {
    // 两套会话上下文不能静默拼接：只投影确定的那一个，其余以歧义诊断暴露给调用方。
    evidence.diagnostics.push({
      code: 'request-container-ambiguous',
      severity: 'warning',
      source: source('request', [name], body[name]),
    })
  }
  if (primary === 'messages') projectMessagesContainer(body.messages as unknown[], evidence)
  else if (primary === 'contents') projectGeminiContents(body.contents as unknown[], evidence)
  else if (primary === 'input') projectResponsesInput(body.input, evidence)

  for (const [field, value] of Object.entries(body)) {
    if (field === 'tools' || field === 'functions') collectToolDefinitions(field, value, evidence.toolDefinitions)
  }

  if (!primary && !systemCount) evidence.diagnostics.push(unsupported([], body))
  return evidence
}

function unsupported(path: readonly string[], value: unknown): ModelEvidenceDiagnostic {
  return { code: 'request-body-unsupported', severity: 'warning', source: source('request', path, value) }
}

function isSystemField(field: string): boolean {
  return (SYSTEM_FIELDS as readonly string[]).includes(field)
}

function isPrimaryContainer(name: typeof PRIMARY_CONTAINERS[number], value: unknown): boolean {
  // Responses 的 input 允许是数组、单条字符串或单个 item 对象，三种都是同一个会话容器。
  if (name === 'input') return Array.isArray(value) || typeof value === 'string' || isRecord(value)
  return Array.isArray(value)
}

function projectSystemField(field: string, value: unknown, evidence: RequestEvidence): number {
  const container = isRecord(value) && Array.isArray(value.parts)
    ? { values: value.parts, path: [field, 'parts'] }
    : Array.isArray(value)
      ? { values: value, path: [field] }
      : undefined
  if (!container) {
    evidence.messages.push(createMessage('system', normalizeContentParts(value), [field], value))
    return 1
  }
  for (const [index, item] of container.values.entries()) {
    // 顶层 system 数组与 systemInstruction.parts 都是独立原始证据；合并会让边界、搜索和定位失去单条身份。
    evidence.messages.push(createMessage('system', normalizeContentParts(item), [...container.path, String(index)], item))
  }
  return container.values.length
}

function projectMessagesContainer(list: readonly unknown[], evidence: RequestEvidence): void {
  for (const [index, value] of list.entries()) {
    const path = ['messages', String(index)]
    if (!isRecord(value)) {
      evidence.diagnostics.push(unsupported(path, value))
      continue
    }
    if (Array.isArray(value.parts)) {
      projectTypedPartsMessage(value, path, evidence)
      continue
    }
    projectRoleMessage(value, path, evidence)
  }
}

function projectRoleMessage(value: Record<string, unknown>, path: string[], evidence: RequestEvidence): void {
  const role = stringValue(value.role)?.toLowerCase() ?? 'user'
  const blocks = Array.isArray(value.content) ? value.content : undefined
  const anthropic = Boolean(blocks?.some(block => isRecord(block) && ANTHROPIC_BLOCK_TYPES.has(String(block.type))))

  if (role === 'assistant' || anthropic) {
    projectBlockMessage(value, path, role === 'assistant' ? 'assistant' : normalizeRole(role), blocks, evidence)
    return
  }
  if (role === 'tool' || role === 'function' || value.tool_call_id !== undefined) {
    const parts = normalizeContentParts(value.content ?? value.output)
    evidence.messages.push(createToolResultMessage(parts, path, value))
    return
  }
  evidence.messages.push(createMessage(
    normalizeRole(role),
    normalizeContentParts(value.content),
    path,
    value,
    explicitReasoning(value),
    projectToolCallFields(value, path),
  ))
}

function projectBlockMessage(
  value: Record<string, unknown>,
  path: string[],
  role: ModelEvidenceMessageRole,
  blocks: readonly unknown[] | undefined,
  evidence: RequestEvidence,
): void {
  if (!blocks) {
    evidence.messages.push(createMessage(
      role,
      normalizeContentParts(value.content),
      path,
      value,
      explicitReasoning(value),
      projectToolCallFields(value, path),
    ))
    return
  }

  const segments = createSegmentWriter(evidence, role, path, 'content', value)
  for (const text of explicitReasoning(value)) segments.addReasoning(text)
  for (const call of projectToolCallFields(value, path)) segments.addToolCall(call)
  for (const [index, block] of blocks.entries()) {
    const blockPath = [...path, 'content', String(index)]
    if (!isRecord(block)) {
      segments.push(index, block, normalizeContentParts(block))
      continue
    }
    const type = String(block.type ?? '')
    if (type === 'thinking' || type === 'redacted_thinking') {
      segments.open(index, block)
      segments.addReasoning(stringValue(block.thinking) ?? stringValue(block.data))
      continue
    }
    if (type === 'tool_use') {
      segments.open(index, block)
      segments.addToolCall(createToolCall(block, blockPath, block.input, { ownsCallId: true }))
      continue
    }
    if (type === 'tool_result') {
      // 工具结果是独立证据平面项；必须切断前后语义分片，不能挪到消息首尾。
      segments.cut(createToolResultMessage(normalizeContentParts(block.content), blockPath, block, { ownsCallId: true }))
      continue
    }
    segments.push(index, block, normalizeContentParts([block]))
  }
  segments.finish()
}

function projectTypedPartsMessage(value: Record<string, unknown>, path: string[], evidence: RequestEvidence): void {
  const role = normalizeRole(stringValue(value.role)?.toLowerCase() ?? 'user')
  const parts = value.parts as readonly unknown[]
  const segments = createSegmentWriter(evidence, role, path, 'parts', value)
  for (const [index, part] of parts.entries()) {
    const partPath = [...path, 'parts', String(index)]
    if (!isRecord(part)) {
      segments.push(index, part, normalizeContentParts(part))
      continue
    }
    const type = stringValue(part.type)?.toLowerCase() ?? ''
    if (type === 'tool-result' || type === 'tool-output') {
      // typed parts 是有序证据流；工具结果前后必须冲刷语义片段，否则顺序会被重排。
      const output = part.output ?? part.result ?? part.content
      segments.cut(createToolResultMessage(
        [{ kind: 'text', value: normalizeToolOutput(output) }],
        partPath,
        part,
      ))
      continue
    }
    if (type === 'reasoning' || type === 'reasoning-part') {
      segments.open(index, part)
      segments.addReasoning(stringValue(part.text))
      continue
    }
    if (type === 'tool-call' || type === 'tool-invocation' || type === 'dynamic-tool') {
      const invocation = isRecord(part.toolInvocation) ? part.toolInvocation : part
      segments.open(index, part)
      segments.addToolCall(createToolCall(
        invocation,
        partPath,
        invocation.input ?? invocation.args ?? invocation.arguments,
      ))
      continue
    }
    segments.push(index, part, normalizeContentParts([part]))
  }
  segments.finish()
}

function projectGeminiContents(list: readonly unknown[], evidence: RequestEvidence): void {
  for (const [index, value] of list.entries()) {
    const path = ['contents', String(index)]
    if (!isRecord(value)) {
      evidence.diagnostics.push(unsupported(path, value))
      continue
    }
    const role: ModelEvidenceMessageRole = value.role === 'model' ? 'assistant' : 'user'
    const parts = Array.isArray(value.parts) ? value.parts : []
    const segments = createSegmentWriter(evidence, role, path, 'parts', value)
    for (const [partIndex, part] of parts.entries()) {
      if (!isRecord(part)) {
        segments.push(partIndex, part, [])
        continue
      }
      if (isRecord(part.functionCall)) {
        const callPath = [...path, 'parts', String(partIndex), 'functionCall']
        segments.open(partIndex, part)
        segments.addToolCall(createToolCall(part.functionCall, callPath, part.functionCall.args ?? {}, { ownsCallId: true }))
        continue
      }
      if (isRecord(part.functionResponse)) {
        const responsePath = [...path, 'parts', String(partIndex), 'functionResponse']
        const response = part.functionResponse.response ?? part.functionResponse
        segments.cut(createToolResultMessage(
          normalizeContentParts(response),
          responsePath,
          part.functionResponse,
          { ownsCallId: true },
        ))
        continue
      }
      segments.push(partIndex, part, normalizeGeminiPart(part))
    }
    segments.finish()
  }
}

function projectResponsesInput(input: unknown, evidence: RequestEvidence): void {
  if (typeof input === 'string') {
    evidence.messages.push(createMessage('user', normalizeContentParts(input), ['input'], input))
    return
  }
  if (isRecord(input)) {
    projectResponsesInputItem(input, ['input'], evidence)
    return
  }
  if (!Array.isArray(input)) return
  for (const [index, value] of input.entries()) {
    const path = ['input', String(index)]
    if (!isRecord(value)) {
      evidence.messages.push(createMessage('user', [{ kind: 'text', value: String(value) }], path, value))
      continue
    }
    projectResponsesInputItem(value, path, evidence)
  }
}

function projectResponsesInputItem(
  value: Record<string, unknown>,
  path: string[],
  evidence: RequestEvidence,
): void {
  {
    const type = stringValue(value.type)
    if (type === 'function_call') {
      evidence.messages.push(createMessage(
        'assistant',
        [],
        path,
        value,
        [],
        [createToolCall(value, path, value.arguments ?? value.args ?? value.input)],
      ))
      return
    }
    if (type === 'function_call_output') {
      evidence.messages.push(createToolResultMessage(
        normalizeContentParts(value.output ?? value.result ?? value.content),
        path,
        value,
      ))
      return
    }
    evidence.messages.push(createMessage(
      normalizeRole(stringValue(value.role)?.toLowerCase() ?? 'user'),
      normalizeContentParts(value.content ?? value.input),
      path,
      value,
      explicitReasoning(value),
      projectToolCallFields(value, path),
    ))
  }
}

interface SegmentWriter {
  addReasoning: (text: string | undefined) => void
  addToolCall: (call: ModelEvidenceToolCall) => void
  open: (index: number, raw: unknown) => void
  push: (index: number, raw: unknown, parts: ModelEvidenceContentPart[]) => void
  /** 冲刷当前语义分片，并把一条独立消息（工具结果）按原始顺序插入。 */
  cut: (message: ModelEvidenceMessage) => void
  finish: () => void
}

type Emission =
  | { type: 'segment', parts: ModelEvidenceContentPart[], reasoning: string[], toolCalls: ModelEvidenceToolCall[], sources: ModelEvidenceSource[] }
  | { type: 'message', message: ModelEvidenceMessage }

/**
 * 分片写入器：把一条原始消息按工具结果边界切成若干语义分片。
 *
 * 只产生一个分片且没有被切断时使用整条消息的路径与原始值；
 * 一旦被切分，分片为每个贡献它的原始项各留一条来源（真实路径 + 原始值只读引用），
 * 而不是合成一个新数组当成“原始值”；证据身份取第一条来源的路径，仍能回到确切原文位置。
 * 分片与工具结果按原始出现顺序交错写回，不会被挪到消息首尾。
 */
function createSegmentWriter(
  evidence: RequestEvidence,
  role: ModelEvidenceMessageRole,
  path: string[],
  container: 'content' | 'parts',
  value: Record<string, unknown>,
): SegmentWriter {
  const emissions: Emission[] = []
  let parts: ModelEvidenceContentPart[] = []
  let reasoning: string[] = []
  let toolCalls: ModelEvidenceToolCall[] = []
  let sources: ModelEvidenceSource[] = []

  const open = (index: number, item: unknown) => {
    sources.push(source('request', [...path, container, String(index)], item))
  }

  const flush = () => {
    if (!parts.length && !reasoning.length && !toolCalls.length) return
    emissions.push({ type: 'segment', parts, reasoning, toolCalls, sources })
    parts = []
    reasoning = []
    toolCalls = []
    sources = []
  }

  return {
    addReasoning: (text) => {
      if (text) reasoning.push(text)
    },
    addToolCall: (call) => {
      // 消息级 tool_calls 不对应任何内容分片，它的原始来源就是整条消息本身。
      if (!sources.length) sources.push(source('request', path, value))
      toolCalls.push(call)
    },
    open,
    push: (index, item, incoming) => {
      open(index, item)
      parts.push(...incoming)
    },
    cut: (message) => {
      flush()
      emissions.push({ type: 'message', message })
    },
    finish: () => {
      flush()
      const single = emissions.length === 1 && emissions[0]?.type === 'segment'
      for (const emission of emissions) {
        if (emission.type === 'message') {
          evidence.messages.push(emission.message)
          continue
        }
        const segmentSources = single ? [source('request', path, value)] : emission.sources
        evidence.messages.push(createMessageFromSources(
          role,
          emission.parts,
          segmentSources[0]?.path ?? path,
          segmentSources.length ? segmentSources : [source('request', path, value)],
          emission.reasoning,
          emission.toolCalls,
        ))
      }
    },
  }
}

function normalizeRole(role: string): ModelEvidenceMessageRole {
  if (role === 'assistant') return 'assistant'
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'tool' || role === 'function') return 'tool'
  return 'user'
}

function explicitReasoning(value: Record<string, unknown>): string[] {
  return [value.reasoning_content, value.reasoning]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function projectToolCallFields(value: Record<string, unknown>, path: string[]): ModelEvidenceToolCall[] {
  const calls: ModelEvidenceToolCall[] = []
  for (const field of ['tool_calls', 'toolCalls'] as const) {
    const list = value[field]
    if (!Array.isArray(list)) continue
    for (const [index, item] of list.entries()) {
      if (!isRecord(item)) continue
      const callPath = [...path, field, String(index)]
      const fn = isRecord(item.function) ? item.function : item
      calls.push(createToolCall(item, callPath, fn.arguments ?? fn.input ?? fn.args, { nameCarrier: fn, ownsCallId: true }))
    }
  }
  if (isRecord(value.function_call)) {
    calls.push(createToolCall(value.function_call, [...path, 'function_call'], value.function_call.arguments))
  }
  return calls
}

interface CallIdOptions {
  /** 工具名可能挂在内层 function 对象上，而不是调用记录本身。 */
  nameCarrier?: Record<string, unknown>
  /**
   * raw 本身就是工具调用/工具结果对象时置为 true，此时它的 `id` 就是调用标识。
   * Responses item、AI SDK part 和消息记录的 `id` 是条目标识，必须保持默认值，
   * 否则会按条目 id 推断出不存在的调用配对。
   */
  ownsCallId?: boolean
}

function createToolCall(
  raw: Record<string, unknown>,
  path: readonly string[],
  argumentsValue: unknown,
  options: CallIdOptions = {},
): ModelEvidenceToolCall {
  const nameCarrier = options.nameCarrier ?? raw
  const callId = options.ownsCallId ? readCallObjectId(raw) : readCallId(raw)
  const name = readToolName(nameCarrier) ?? readToolName(raw) ?? '工具调用'
  const args = argumentsValue === undefined
    ? undefined
    : typeof argumentsValue === 'string' ? argumentsValue : stringifyValue(argumentsValue)
  return {
    evidenceId: evidenceId('request', 'tool-call', path),
    name,
    ...(callId ? { callId } : {}),
    ...(args !== undefined ? { arguments: args } : {}),
    sources: [source('request', path, raw)],
  }
}

function createToolResultMessage(
  parts: ModelEvidenceContentPart[],
  path: readonly string[],
  raw: Record<string, unknown> | unknown,
  options: Pick<CallIdOptions, 'ownsCallId'> = {},
): ModelEvidenceMessage {
  const record = isRecord(raw) ? raw : {}
  const callId = options.ownsCallId ? readCallObjectId(record) : readCallId(record)
  const toolName = readToolName(record)
  return {
    evidenceId: evidenceId('request', 'message', path),
    role: 'tool',
    text: semanticText(parts),
    contentParts: parts,
    toolCalls: [],
    ...(callId ? { toolCallId: callId } : {}),
    ...(toolName ? { toolName } : {}),
    sources: [source('request', path, raw)],
  }
}

function createMessage(
  role: ModelEvidenceMessageRole,
  parts: ModelEvidenceContentPart[],
  path: readonly string[],
  raw: unknown,
  reasoning: readonly string[] = [],
  toolCalls: ModelEvidenceToolCall[] = [],
): ModelEvidenceMessage {
  return createMessageFromSources(role, parts, path, [source('request', path, raw)], reasoning, toolCalls)
}

function createMessageFromSources(
  role: ModelEvidenceMessageRole,
  parts: ModelEvidenceContentPart[],
  idPath: readonly string[],
  sources: readonly ModelEvidenceSource[],
  reasoning: readonly string[] = [],
  toolCalls: ModelEvidenceToolCall[] = [],
): ModelEvidenceMessage {
  const reasoningText = reasoning.filter(Boolean).join('\n')
  return {
    evidenceId: evidenceId('request', 'message', idPath),
    role,
    text: semanticText(parts),
    contentParts: parts,
    ...(reasoningText ? { reasoning: reasoningText } : {}),
    toolCalls,
    sources,
  }
}

function collectToolDefinitions(field: string, value: unknown, target: ModelEvidenceToolDefinition[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (!isRecord(item)) continue
      if (Array.isArray(item.functionDeclarations)) {
        for (const [declarationIndex, declaration] of item.functionDeclarations.entries()) {
          if (!isRecord(declaration)) continue
          target.push(createToolDefinition(declaration, [field, String(index), 'functionDeclarations', String(declarationIndex)]))
        }
        continue
      }
      const definition = isRecord(item.function) ? item.function : item
      target.push(createToolDefinition(definition, [field, String(index), ...(isRecord(item.function) ? ['function'] : [])]))
    }
    return
  }
  if (!isRecord(value)) return
  // AI SDK 用工具名做键；Object.entries 的插入顺序就是原始声明顺序。
  for (const [name, definition] of Object.entries(value)) {
    if (!isRecord(definition)) continue
    target.push(createToolDefinition({ name, ...definition }, [field, name]))
  }
}

function createToolDefinition(value: Record<string, unknown>, path: readonly string[]): ModelEvidenceToolDefinition {
  const parameters = value.parameters ?? value.input_schema ?? value.inputSchema ?? value.parametersJsonSchema
  const schema = isRecord(parameters) ? parameters : undefined
  const properties = isRecord(schema?.properties) ? schema.properties : undefined
  const requiredFields = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    evidenceId: evidenceId('request', 'tool-definition', path),
    name: stringValue(value.name) ?? '未命名工具',
    description: stringValue(value.description) ?? '',
    ...(parameters !== undefined ? { parameters } : {}),
    propertyCount: properties ? Object.keys(properties).length : 0,
    requiredFields,
    sources: [source('request', path, value)],
  }
}

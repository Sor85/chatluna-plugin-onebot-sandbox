import type { SandboxModelRequestDetail, SandboxModelRequestUsage } from '../../src/types'
import type { SandboxEvidenceKind } from '../../src/evidence-kind'
import {
  countMessageCharacters,
  projectModelEvidence,
  type ModelEvidenceContentPart,
  type ModelEvidenceMessage,
  type ModelEvidenceProjection,
  type ModelEvidenceSource,
} from '../../src/model-evidence'

/** 请求消息卡片能落在哪些基础证据种类上。tool 角色的消息就是请求里携带的工具结果。 */
export type ModelConversationMessageKind = Extract<
  SandboxEvidenceKind,
  'system' | 'user' | 'assistant' | 'tool-result'
>
export type ModelConversationSource = 'request' | 'response'
export type ModelConversationFormat = 'json' | 'sse' | 'text'

export type ModelConversationContentPart = ModelEvidenceContentPart

export interface ModelConversationToolCall {
  evidenceId: string
  id?: string
  name: string
  arguments?: string
  /** 卡片头部字符数。工具调用独立成卡后与正文折叠按钮共用同一口径，都数参数字符串本身。 */
  characters: number
}

export interface ModelConversationMessage {
  evidenceId: string
  /** 卡片显示序号。跨视图定位一律使用 evidenceId，序号只是给人看的。 */
  index: number
  kind: ModelConversationMessageKind
  source: ModelConversationSource
  content: string
  contentParts: readonly ModelConversationContentPart[]
  reasoning?: string
  toolCalls: readonly ModelConversationToolCall[]
  toolCallId?: string
  /** 与请求组成图共用的字符数度量，保证同一条证据在两个视图显示同一个数字。 */
  characters: number
  raw: unknown
  path: readonly string[]
  searchText: string
}

export interface ModelConversationTool {
  evidenceId: string
  name: string
  description: string
  parameters?: unknown
  propertyCount: number
  requiredFields: readonly string[]
  raw: unknown
  path: readonly string[]
  searchText: string
}

export interface ModelConversationToolResult {
  evidenceId: string
  id?: string
  name?: string
  content: string
  characters: number
  raw: unknown
  path: readonly string[]
}

export interface ModelConversationResponse {
  source: 'response'
  status: 'pending' | 'complete' | 'empty' | 'unavailable' | 'error'
  statusMessage?: string
  content: string[]
  reasoning: string[]
  toolCalls: ModelConversationToolCall[]
  toolResults: ModelConversationToolResult[]
  finishReasons: string[]
  usage?: SandboxModelRequestUsage
  /** 归属响应卡片整体的证据身份：正文、思考、结束原因、用量与未识别事件。 */
  cardEvidenceIds: string[]
  unrecognizedCount: number
  raw: unknown
  format?: ModelConversationFormat
  searchText: string
}

export interface ModelRequestConversation {
  messages: ModelConversationMessage[]
  response?: ModelConversationResponse
  tools: ModelConversationTool[]
  parseError?: string
  searchText: string
}

/**
 * 模型请求对话视图 adapter。
 *
 * 只把共享模型证据投影映射成卡片模型、搜索文本和可渲染状态；
 * 不读取任何协议特定字段，协议知识全部留在 `src/model-evidence`。
 */
export function parseModelRequestConversationDetail(detail: SandboxModelRequestDetail): ModelRequestConversation {
  const projection = projectModelEvidence({
    requestBody: detail.requestBody,
    ...(detail.responseBodyRaw !== undefined ? { responseBodyRaw: detail.responseBodyRaw } : {}),
    ...(detail.responseBodyFormat ? { responseBodyFormat: detail.responseBodyFormat } : {}),
  })
  const conversation = buildConversation(projection)
  const response = buildResponse(projection, detail)
  return { ...conversation, response, searchText: `${conversation.searchText}\n${response.searchText}` }
}

export function parseModelResponseConversation(
  record: Pick<SandboxModelRequestDetail, 'responseBodyRaw' | 'responseBodyFormat' | 'responseBodyStatus' | 'responseBodyError' | 'usage'>,
): ModelConversationResponse {
  return buildResponse(
    projectModelEvidence({
      ...(record.responseBodyRaw !== undefined ? { responseBodyRaw: record.responseBodyRaw } : {}),
      ...(record.responseBodyFormat ? { responseBodyFormat: record.responseBodyFormat } : {}),
    }),
    record,
  )
}

function buildConversation(projection: ModelEvidenceProjection): ModelRequestConversation {
  const messages = projection.requestMessages.map((message, index) => createMessage(message, index))
  const tools = projection.toolDefinitions.map(definition => ({
    evidenceId: definition.evidenceId,
    name: definition.name,
    description: definition.description,
    ...(definition.parameters !== undefined ? { parameters: definition.parameters } : {}),
    propertyCount: definition.propertyCount,
    requiredFields: definition.requiredFields,
    raw: sourceValue(definition.sources),
    path: sourcePath(definition.sources),
    searchText: `${definition.name}\n${definition.description}\n${JSON.stringify(definition.parameters ?? '')}`,
  }))
  const result: ModelRequestConversation = {
    messages,
    tools,
    searchText: [...messages, ...tools].map(item => item.searchText).join('\n'),
  }
  const unsupported = projection.diagnostics.find(({ code }) => code === 'request-body-unsupported')
  if (unsupported && !messages.length && !tools.length) {
    // 诊断自带原始来源；用它区分“不是对象”和“是对象但结构不认识”，不需要再读一次请求体。
    result.parseError = isObjectEvidence(unsupported.source.value)
      ? '未识别请求体中的对话结构'
      : '请求体不是可解析的对象'
  }
  return result
}

function createMessage(message: ModelEvidenceMessage, index: number): ModelConversationMessage {
  const toolCalls = message.toolCalls.map(call => ({
    evidenceId: call.evidenceId,
    ...(call.callId ? { id: call.callId } : {}),
    name: call.name,
    ...(call.arguments !== undefined ? { arguments: call.arguments } : {}),
    characters: call.arguments?.length ?? 0,
  }))
  // 投影的消息角色描述协议识别结果；卡片按基础证据种类归类，因此 tool 角色落在工具结果这一档。
  const kind: ModelConversationMessageKind = message.role === 'tool' ? 'tool-result' : message.role
  return {
    evidenceId: message.evidenceId,
    index,
    kind,
    source: 'request',
    content: message.text,
    contentParts: message.contentParts,
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    toolCalls,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    characters: countMessageCharacters(message),
    raw: sourceValue(message.sources),
    path: sourcePath(message.sources),
    searchText: [
      message.role,
      message.text,
      message.reasoning ?? '',
      message.toolCallId ?? '',
      ...toolCalls.flatMap(call => [call.name, call.arguments ?? '']),
    ].join('\n'),
  }
}

function buildResponse(
  projection: ModelEvidenceProjection,
  record: Pick<SandboxModelRequestDetail, 'responseBodyRaw' | 'responseBodyFormat' | 'responseBodyStatus' | 'responseBodyError' | 'usage'>,
): ModelConversationResponse {
  const empty = (status: ModelConversationResponse['status'], statusMessage: string): ModelConversationResponse => ({
    source: 'response',
    status,
    statusMessage,
    content: [],
    reasoning: [],
    toolCalls: [],
    toolResults: [],
    finishReasons: [],
    cardEvidenceIds: [],
    unrecognizedCount: 0,
    ...(record.usage ? { usage: record.usage } : {}),
    raw: record.responseBodyRaw,
    ...(record.responseBodyFormat ? { format: record.responseBodyFormat } : {}),
    searchText: statusMessage,
  })
  // 生命周期事实由模型请求记录决定；证据投影不覆盖 pending / error / unavailable。
  if (record.responseBodyStatus === 'pending') return empty('pending', '响应仍在采集中')
  if (record.responseBodyStatus === 'error') return empty('error', record.responseBodyError || '响应采集失败')
  if (record.responseBodyStatus === 'unavailable' || record.responseBodyRaw === undefined) return empty('unavailable', '响应不可用')

  const malformedBody = projection.diagnostics.some(({ code, source }) => (
    code === 'response-body-malformed' && source.path.length === 0
  ))
  if (malformedBody) {
    return { ...empty('error', '响应 JSON 解析失败'), raw: record.responseBodyRaw, format: record.responseBodyFormat ?? 'json' }
  }

  const content: string[] = []
  const reasoning: string[] = []
  const toolCalls: ModelConversationToolCall[] = []
  const toolResults: ModelConversationToolResult[] = []
  const finishReasons: string[] = []
  const cardEvidenceIds: string[] = []
  let unrecognizedCount = 0
  let usageCandidate: SandboxModelRequestUsage | undefined

  for (const event of projection.responseEvents) {
    if (event.kind === 'content') {
      if (event.text) content.push(event.text)
      cardEvidenceIds.push(event.evidenceId)
      continue
    }
    if (event.kind === 'reasoning') {
      if (event.text) reasoning.push(event.text)
      cardEvidenceIds.push(event.evidenceId)
      continue
    }
    if (event.kind === 'finish-reason') {
      if (event.text && !finishReasons.includes(event.text)) finishReasons.push(event.text)
      cardEvidenceIds.push(event.evidenceId)
      continue
    }
    if (event.kind === 'usage') {
      if (event.normalizedUsage) usageCandidate = { ...event.normalizedUsage, source: 'response' }
      cardEvidenceIds.push(event.evidenceId)
      continue
    }
    if (event.kind === 'unknown') {
      unrecognizedCount += 1
      cardEvidenceIds.push(event.evidenceId)
      continue
    }
    if (event.kind === 'tool-call') {
      toolCalls.push({
        evidenceId: event.evidenceId,
        ...(event.callId ? { id: event.callId } : {}),
        name: event.name ?? '工具调用',
        ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
        characters: event.arguments?.length ?? 0,
      })
      continue
    }
    toolResults.push({
      evidenceId: event.evidenceId,
      ...(event.callId ? { id: event.callId } : {}),
      ...(event.name ? { name: event.name } : {}),
      content: event.text ?? '',
      characters: event.text?.length ?? 0,
      raw: sourceValue(event.sources),
      path: sourcePath(event.sources),
    })
  }

  // ADR-0059：标准化 ChatLuna 用量优先，响应体用量只是缺失时的候选。
  const usage = record.usage ?? usageCandidate
  const hasContent = Boolean(
    content.length || reasoning.length || toolCalls.length || toolResults.length
    || finishReasons.length || usage || unrecognizedCount,
  )
  const statusMessage = hasContent ? undefined : '响应没有可展示的结构化内容'
  const transport = projection.responseTransport
  return {
    source: 'response',
    status: hasContent ? 'complete' : 'empty',
    ...(statusMessage ? { statusMessage } : {}),
    content,
    reasoning,
    toolCalls,
    toolResults,
    finishReasons,
    ...(usage ? { usage } : {}),
    cardEvidenceIds,
    unrecognizedCount,
    raw: transport.value ?? record.responseBodyRaw,
    ...(resolveFormat(record.responseBodyFormat, transport.kind) ? { format: resolveFormat(record.responseBodyFormat, transport.kind) } : {}),
    searchText: [
      statusMessage ?? '',
      content,
      reasoning,
      toolCalls.map(call => `${call.name} ${call.arguments ?? ''}`),
      toolResults.map(result => `${result.name ?? ''} ${result.content}`),
      finishReasons,
    ].flat().join('\n'),
  }
}

function resolveFormat(
  declared: ModelConversationFormat | undefined,
  transport: ModelEvidenceProjection['responseTransport']['kind'],
): ModelConversationFormat | undefined {
  if (declared) return declared
  return transport === 'empty' ? undefined : transport
}

function sourceValue(sources: readonly ModelEvidenceSource[]): unknown {
  return sources[0]?.value
}

function sourcePath(sources: readonly ModelEvidenceSource[]): readonly string[] {
  return sources[0]?.path ?? []
}

function isObjectEvidence(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

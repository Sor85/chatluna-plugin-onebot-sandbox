/**
 * 模型证据投影的对外契约。
 *
 * 这里只描述“从原始模型证据能证明什么”，不描述任何展示目标、DOM、排序或交互状态。
 * 调用方（模型请求轨迹、模型请求对话视图）只依赖本文件的类型和 `projectModelEvidence` 一个入口。
 */

/** 证据所属区域。请求体与响应原文是两份独立的权威事实，不建立跨区域总顺序。 */
export type ModelEvidenceRegion = 'request' | 'response'

/**
 * 一条规范项的原始来源。
 *
 * `path` 是原始结构路径（对象键或数组下标），`value` 是原始子树的只读引用；
 * 投影不深拷贝原始请求和响应，避免大响应被重复放大。
 */
export interface ModelEvidenceSource {
  region: ModelEvidenceRegion
  path: readonly string[]
  value: unknown
}

export type ModelEvidenceContentPartKind = 'text' | 'image' | 'file' | 'audio' | 'video' | 'other'

export interface ModelEvidenceContentPart {
  kind: ModelEvidenceContentPartKind
  value: string
  mimeType?: string
}

export type ModelEvidenceMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 请求体中的工具调用证据。只有存在显式调用标识时才带 `callId`。 */
export interface ModelEvidenceToolCall {
  evidenceId: string
  name: string
  callId?: string
  arguments?: string
  sources: readonly ModelEvidenceSource[]
}

export interface ModelEvidenceMessage {
  evidenceId: string
  role: ModelEvidenceMessageRole
  /** 语义正文：文本与无法归类的分片，按原始顺序拼接。 */
  text: string
  contentParts: readonly ModelEvidenceContentPart[]
  reasoning?: string
  toolCalls: readonly ModelEvidenceToolCall[]
  /** 工具结果消息的显式调用标识。缺失时不得按名称或位置推断配对。 */
  toolCallId?: string
  toolName?: string
  sources: readonly ModelEvidenceSource[]
}

export interface ModelEvidenceToolDefinition {
  evidenceId: string
  name: string
  description: string
  parameters?: unknown
  propertyCount: number
  requiredFields: readonly string[]
  sources: readonly ModelEvidenceSource[]
}

export type ModelEvidenceResponseEventKind =
  | 'content'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'finish-reason'
  | 'usage'
  | 'unknown'

export interface ModelEvidenceUsageCandidate {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
  totalTokens?: number
}

export interface ModelEvidenceResponseEvent {
  evidenceId: string
  kind: ModelEvidenceResponseEventKind
  /** content / reasoning / finish-reason 的文本事实。 */
  text?: string
  name?: string
  callId?: string
  arguments?: string
  /** 响应体中的原始用量对象，仅作为候选证据。 */
  usage?: Record<string, unknown>
  normalizedUsage?: ModelEvidenceUsageCandidate
  sources: readonly ModelEvidenceSource[]
}

export type ModelEvidenceDiagnosticCode =
  | 'request-body-unsupported'
  | 'request-container-ambiguous'
  | 'response-body-malformed'
  | 'response-payload-unsupported'
  | 'response-payload-ambiguous'

export type ModelEvidenceDiagnosticSeverity = 'info' | 'warning' | 'error'

/** 结构化诊断只表达代码、严重程度和来源，不包含任何页面文案。 */
export interface ModelEvidenceDiagnostic {
  code: ModelEvidenceDiagnosticCode
  severity: ModelEvidenceDiagnosticSeverity
  source: ModelEvidenceSource
}

export type ModelEvidenceTransportKind = 'json' | 'sse' | 'text' | 'empty'

/** 响应 transport 解析结果。原始 JSON / SSE / TEXT 查看能力直接消费 `value`。 */
export interface ModelEvidenceTransport {
  kind: ModelEvidenceTransportKind
  value?: unknown
}

/** 投影入口接收的证据切片：只有请求体、响应原文和响应 transport 格式。 */
export interface ModelEvidenceSlice {
  requestBody?: unknown
  responseBodyRaw?: string
  responseBodyFormat?: 'json' | 'text' | 'sse'
}

export interface ModelEvidenceProjection {
  requestMessages: readonly ModelEvidenceMessage[]
  toolDefinitions: readonly ModelEvidenceToolDefinition[]
  responseEvents: readonly ModelEvidenceResponseEvent[]
  responseTransport: ModelEvidenceTransport
  diagnostics: readonly ModelEvidenceDiagnostic[]
}

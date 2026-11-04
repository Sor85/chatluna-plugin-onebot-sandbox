import type {
  SandboxModelRequestDetail,
  SandboxModelRequestPromptCompositionGranularity,
  SandboxModelRequestPromptCompositionItem,
  SandboxModelRequestPromptKind,
  SandboxModelRequestRecord,
  SandboxModelRequestStatus,
  SandboxModelRequestTrajectory,
  SandboxModelRequestTrajectoryKind,
  SandboxModelRequestTrajectoryRow,
  SandboxModelRequestVariable,
} from './types'
import { presentModelRequestListItem, type SandboxModelRequestStore } from './model-request'
import { normalizeEvidencePreviewText } from './evidence-preview-text'
import { deriveModelRequestVariables, modelRequestVariableStatusLabel } from './model-request-variables'
import { sandboxEvidenceAggregate } from './evidence-kind'
import {
  sandboxEvidenceReadingGroup,
  sandboxEvidenceReadingRank,
  type SandboxEvidenceReadingGroup,
} from './evidence-reading-order'
import {
  aggregateModelRequestComposition,
  resolveModelRequestCompositionGranularity,
  type ModelRequestCompositionSlot,
} from './model-request-composition'
import {
  countMessageCharacters,
  countToolCallCharacters,
  countToolDefinitionCharacters,
  projectModelEvidence,
  type ModelEvidenceMessage,
  type ModelEvidenceProjection,
} from './model-evidence'

interface BuildSandboxModelRequestTrajectoryOptions {
  record: SandboxModelRequestDetail
  mode: 'request' | 'conversation'
  /** 会话模式下同会话的原始记录，按 sequence 正序；缺省表示无法聚合，只呈现当前请求。 */
  conversationRecords?: readonly SandboxModelRequestRecord[]
  /** 会话模式下要下发事件行的请求标识；被读取的那条请求恒为展开。 */
  expandedRequestIds?: readonly string[]
}

interface ProjectedRow {
  /** 这一行落在哪一档。只用于排序，不下发给客户端——账本行的档位由种类与来源现算即可。 */
  group: SandboxEvidenceReadingGroup
  evidenceId: string
  kind: SandboxModelRequestTrajectoryKind
  preview: string
  callId?: string
  toolName?: string
  variableId?: string
  variableName?: string
  variablePresetName?: string
  variableStatus?: SandboxModelRequestVariable['status']
  variableValue?: string
}

const CONVERSATION_RECORD_LIMIT = 200
const TRAJECTORY_PREVIEW_LENGTH = 180
/** 组成图的工具交互档。合并了哪两种基础证据由证据种类 module 声明，这里只引用聚合身份。 */
const TOOL_INTERACTION_KIND = sandboxEvidenceAggregate('tool-interaction').id

/**
 * 读取会话模式需要的同会话记录。记录库的读取是异步的，而轨迹投影本身是纯函数；
 * 这个薄封装是唯一需要 Store 的地方，投影因此保持可单测、可复用。
 */
export async function readSandboxModelRequestConversationRecords(
  record: Pick<SandboxModelRequestDetail, 'entities'>,
  store: SandboxModelRequestStore | undefined,
): Promise<SandboxModelRequestRecord[] | undefined> {
  const conversationId = record.entities.conversationId
  if (!store || !conversationId) return
  return store.getRawRecords({ conversationId, order: 'asc', limit: CONVERSATION_RECORD_LIMIT })
}

export async function buildSandboxModelRequestTrajectoryFromStore(options: {
  record: SandboxModelRequestDetail
  mode: 'request' | 'conversation'
  store?: SandboxModelRequestStore
  expandedRequestIds?: readonly string[]
}): Promise<SandboxModelRequestTrajectory> {
  const conversationRecords = options.mode === 'conversation'
    ? await readSandboxModelRequestConversationRecords(options.record, options.store)
    : undefined
  return buildSandboxModelRequestTrajectory({
    record: options.record,
    mode: options.mode,
    ...(conversationRecords ? { conversationRecords } : {}),
    ...(options.expandedRequestIds ? { expandedRequestIds: options.expandedRequestIds } : {}),
  })
}

export function buildSandboxModelRequestTrajectory(
  options: BuildSandboxModelRequestTrajectoryOptions,
): SandboxModelRequestTrajectory {
  const sourceRecords = options.mode === 'conversation' && options.conversationRecords
    ? options.conversationRecords
    : [options.record]
  const records = sourceRecords.map(record => presentModelRequestListItem(record))
  const expandedRequestIds = resolveExpandedRequestIds(options, sourceRecords)
  const rows: SandboxModelRequestTrajectoryRow[] = []
  const promptComposition: SandboxModelRequestPromptCompositionItem[] = []
  const slots: ModelRequestCompositionSlot[] = []
  const timeSpan = resolveTimeSpan(sourceRecords)
  let index = 1
  let eventTotal = 0

  for (const record of sourceRecords) {
    // 轨迹只负责会话聚合、请求边界、时间与组成统计；协议语义全部来自共享模型证据投影。
    const projection = projectModelEvidence({
      requestBody: record.requestBody,
      ...(record.responseBodyStatus === 'complete' && record.responseBodyRaw !== undefined
        ? { responseBodyRaw: record.responseBodyRaw, responseBodyFormat: record.responseBodyFormat }
        : {}),
    })
    // 变量派生只读投影的请求消息，因此可以直接复用这一份投影。会话模式下每条记录都要派生变量，
    // 经由详情投影绕一圈会让同一条记录被重复投影三次、重复派生变量两次。
    const variables = record.requestBody !== undefined && record.presetSnapshots?.length
      ? deriveModelRequestVariables(record.presetSnapshots, projection)
      : []
    const expanded = expandedRequestIds.has(record.id)

    rows.push({
      id: `${record.id}:request`,
      index: index++,
      kind: 'request',
      preview: requestPreview(record),
      durationMs: record.durationMs,
      startedAt: record.createdAt,
      requestId: record.id,
      status: record.status,
    })

    // 折叠的请求同样要走完投影：事件总数与组成占比是整段轨迹的事实，不随展开与否变化。
    // 折叠省掉的是行对象与它们的预览文本，也就是账本载荷本身。
    //
    // 请求行与响应行必须合成一份再排：响应整体是阅读顺序里的一档，先铺完请求行再追加响应行
    // 会让响应排到工具往返之后，与分析导航给出的先后相反。
    for (const { source, row } of orderTrajectoryEvents([
      ...projectRequestRows(projection, variables).map(row => ({ source: 'request' as const, row })),
      ...projectResponseRows(projection).map(row => ({ source: 'response' as const, row })),
    ])) {
      const rowIndex = index++
      eventTotal += 1
      if (!expanded) continue
      const { group, ...cells } = row
      rows.push({
        id: `${record.id}:${row.evidenceId}`,
        index: rowIndex,
        requestId: record.id,
        source,
        ...cells,
      })
    }
    const composition = projectPromptComposition(projection, variables)
    for (const item of composition) {
      promptComposition.push(options.mode === 'conversation' ? { ...item, requestId: record.id } : item)
    }
    slots.push({
      timeShare: timeSpan > 0 ? Math.max(record.durationMs, record.status === 'pending' ? 0 : 1) / timeSpan : 0,
      segmentCount: composition.length,
    })
  }

  // 单请求轨迹恒为逐条证据：横轴按占比铺满一整条，分段数也就是这一条请求自己的段数。
  const granularity = options.mode === 'conversation'
    ? resolveModelRequestCompositionGranularity(slots)
    : 'evidence'

  return {
    mode: options.mode,
    ...(options.record.entities.conversationId
      ? { conversationId: options.record.entities.conversationId }
      : {}),
    records,
    rows,
    promptComposition: granularity === 'aggregate'
      ? aggregateModelRequestComposition(promptComposition)
      : promptComposition,
    complete: options.mode === 'request' || !options.conversationRecords || sourceRecords.length < CONVERSATION_RECORD_LIMIT,
    granularity,
    eventTotal,
    expandedRequestIds: [...expandedRequestIds],
  }
}

/**
 * 哪些请求要下发事件行。
 *
 * 单请求模式恒为全展开——账本就是这一条请求的内容，折叠它等于什么都不显示。
 * 会话模式完全按调用方给的清单下发：一次会话里第 N 条请求的请求体本身就包含前 N 轮历史，
 * 逐条全量下发会让账本行数按记录数平方增长（两百条记录约十万行）。
 *
 * 这里不替调用方补上被读取的那条请求。补上会让它永远折不起来：用户点它的箭头，
 * 客户端把它从清单里去掉，服务端又原样加回来，界面纹丝不动。默认展开哪一条属于视图状态，
 * 由详情视图在进入账本时播种一次，因此它既是默认值也可以被折叠。
 */
function resolveExpandedRequestIds(
  options: BuildSandboxModelRequestTrajectoryOptions,
  sourceRecords: readonly SandboxModelRequestRecord[],
): Set<string> {
  if (options.mode === 'request') return new Set(sourceRecords.map(({ id }) => id))
  const requested = new Set(options.expandedRequestIds ?? [])
  return new Set(sourceRecords.filter(({ id }) => requested.has(id)).map(({ id }) => id))
}

/**
 * 整段轨迹的时间跨度，与视图铺时间轴用的口径一致：最早开始到最晚结束，至少 1 毫秒。
 * 粒度判据要按时间槽占比算，因此跨度必须在这里量一次，而不是让视图算完再回传。
 */
function resolveTimeSpan(records: readonly SandboxModelRequestRecord[]): number {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const record of records) {
    const recordStart = Date.parse(record.createdAt)
    if (Number.isNaN(recordStart)) continue
    start = Math.min(start, recordStart)
    end = Math.max(end, recordStart + Math.max(record.durationMs, 1))
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(end - start, 1)
}

/**
 * 账本事件按阅读顺序排列。
 *
 * 排序必须稳定：同一档内的先后就是投影顺序，也就是请求体里的原始位次。工具调用跟着发起它的
 * 那条 assistant 消息落在同一档，因此稳定排序会让它紧跟在那条消息之后。
 */
function orderTrajectoryEvents<T extends { row: ProjectedRow }>(events: readonly T[]): T[] {
  return [...events].sort((left, right) => (
    sandboxEvidenceReadingRank(left.row.group) - sandboxEvidenceReadingRank(right.row.group)
  ))
}

function projectRequestRows(
  projection: ModelEvidenceProjection,
  variables: readonly SandboxModelRequestVariable[],
): ProjectedRow[] {
  const rows: ProjectedRow[] = projection.toolDefinitions.map(definition => ({
    group: 'tool' as const,
    evidenceId: definition.evidenceId,
    kind: 'tool-definition' as const,
    preview: `工具定义 · ${definition.name}`,
    toolName: definition.name,
  }))
  for (const message of projection.requestMessages) {
    rows.push(...messageRows(message))
  }
  for (const variable of variables) {
    rows.push({
      group: 'variable',
      evidenceId: `variable:${variable.id}`,
      kind: 'variable',
      preview: `${variable.name} · ${variable.status === 'observed' ? compactText(variable.value ?? '') || '空值' : modelRequestVariableStatusLabel(variable.status)}`,
      variableId: variable.id,
      variableName: variable.name,
      variablePresetName: variable.presetName,
      variableStatus: variable.status,
      ...(variable.value !== undefined ? { variableValue: variable.value } : {}),
    })
  }
  return rows
}

function messageRows(message: ModelEvidenceMessage): ProjectedRow[] {
  const rows: ProjectedRow[] = []
  if (message.role === 'tool') {
    rows.push({
      group: 'tool',
      evidenceId: message.evidenceId,
      kind: 'tool-result',
      preview: `${message.toolName ?? '工具结果'} · ${compactText(message.text) || '无输出'}`,
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.toolCallId ? { callId: message.toolCallId } : {}),
    })
    return rows
  }
  const group = sandboxEvidenceReadingGroup({ kind: message.role })
  const reasoning = message.reasoning ? compactText(message.reasoning) : ''
  const text = compactText(message.text)
  if (text || reasoning) {
    rows.push({
      group,
      evidenceId: message.evidenceId,
      kind: message.role,
      preview: text || `思考 · ${reasoning}`,
    })
  }
  for (const call of message.toolCalls) {
    rows.push({
      // 工具调用跟着发起它的那条消息：导航把它列在那条消息之后，账本必须给出同一个先后。
      group,
      evidenceId: call.evidenceId,
      kind: 'tool-call',
      preview: `${call.name} · ${compactText(call.arguments ?? '') || '无参数'}`,
      toolName: call.name,
      ...(call.callId ? { callId: call.callId } : {}),
    })
  }
  return rows
}

/** 响应侧证据整体是阅读顺序里的一档，不按 assistant / tool-call / tool-result 拆开排。 */
const RESPONSE_GROUP = sandboxEvidenceReadingGroup({ kind: 'response', source: 'response' })

function projectResponseRows(projection: ModelEvidenceProjection): ProjectedRow[] {
  return projection.responseEvents.flatMap<ProjectedRow>((event) => {
    if (event.kind === 'reasoning') {
      return [{ group: RESPONSE_GROUP, evidenceId: event.evidenceId, kind: 'assistant', preview: `思考 · ${compactText(event.text ?? '')}` }]
    }
    if (event.kind === 'content') {
      return [{ group: RESPONSE_GROUP, evidenceId: event.evidenceId, kind: 'assistant', preview: compactText(event.text ?? '') }]
    }
    if (event.kind === 'tool-call') {
      return [{
        group: RESPONSE_GROUP,
        evidenceId: event.evidenceId,
        kind: 'tool-call',
        preview: `${event.name ?? '工具调用'} · ${compactText(event.arguments ?? '') || '无参数'}`,
        ...(event.name ? { toolName: event.name } : {}),
        ...(event.callId ? { callId: event.callId } : {}),
      }]
    }
    if (event.kind === 'tool-result') {
      return [{
        group: RESPONSE_GROUP,
        evidenceId: event.evidenceId,
        kind: 'tool-result',
        preview: `${event.name ?? '工具结果'} · ${compactText(event.text ?? '') || '无输出'}`,
        ...(event.name ? { toolName: event.name } : {}),
        ...(event.callId ? { callId: event.callId } : {}),
      }]
    }
    return []
  })
}

function projectPromptComposition(
  projection: ModelEvidenceProjection,
  variables: readonly SandboxModelRequestVariable[],
): SandboxModelRequestPromptCompositionItem[] {
  const sequence: SandboxModelRequestPromptCompositionItem[] = []
  const variablesByEvidenceId = groupObservedVariablesByEvidenceId(variables)
  for (const message of projection.requestMessages) {
    // 请求消息里的工具结果与工具调用成对出现，组成图按字符占比把它们统计为同一档工具交互；
    // 合并规则本身由证据种类 module 的工具交互聚合声明。
    const kind: SandboxModelRequestPromptKind = message.role === 'tool' ? TOOL_INTERACTION_KIND : message.role
    const messageCharacters = countMessageCharacters(message)
    if (kind === 'system' || kind === 'user') {
      pushMessageComposition(sequence, kind, message.evidenceId, messageCharacters, variablesByEvidenceId.get(message.evidenceId) ?? [])
    } else {
      push(sequence, kind, message.evidenceId, messageCharacters)
    }
    for (const call of message.toolCalls) {
      push(sequence, TOOL_INTERACTION_KIND, call.evidenceId, countToolCallCharacters(call))
    }
  }

  const tools = projection.toolDefinitions.map(definition => ({
    kind: 'tool-definition' as const,
    evidenceId: definition.evidenceId,
    characters: Math.max(countToolDefinitionCharacters(definition), 1),
  }))

  // 工具声明不是对话轮次，但属于请求前缀。变量片段仍使用原请求消息的角色，
  // 因此和 leading system/user 一起自然保留在工具声明之前。
  let split = 0
  while (split < sequence.length && (sequence[split]!.kind === 'system' || sequence[split]!.kind === 'user')) {
    split += 1
  }
  return [...sequence.slice(0, split), ...tools, ...sequence.slice(split)]
}

function groupObservedVariablesByEvidenceId(
  variables: readonly SandboxModelRequestVariable[],
): Map<string, SandboxModelRequestVariable[]> {
  const grouped = new Map<string, SandboxModelRequestVariable[]>()
  for (const variable of variables) {
    if (variable.status !== 'observed' || !variable.evidenceId || !variable.range) continue
    if (variable.range.end <= variable.range.start) continue
    const items = grouped.get(variable.evidenceId) ?? []
    items.push(variable)
    grouped.set(variable.evidenceId, items)
  }
  for (const items of grouped.values()) {
    items.sort((left, right) => left.range!.start - right.range!.start || left.range!.end - right.range!.end)
  }
  return grouped
}

function pushMessageComposition(
  target: SandboxModelRequestPromptCompositionItem[],
  kind: 'system' | 'user',
  evidenceId: string,
  characters: number,
  variables: readonly SandboxModelRequestVariable[],
): void {
  if (!variables.length || characters <= 0) {
    push(target, kind, evidenceId, characters)
    return
  }

  let offset = 0
  for (const variable of variables) {
    const range = variable.range!
    if (range.start < offset || range.start > characters || range.end > characters) continue
    push(target, kind, evidenceId, range.start - offset)
    target.push({
      // 模型请求变量在组成图中统一投影到 User 轨道，和工具定义一样按变量逐段展示。
      kind: 'user',
      evidenceId: `variable:${variable.id}`,
      characters: range.end - range.start,
      variableId: variable.id,
      variableName: variable.name,
    })
    offset = range.end
  }
  push(target, kind, evidenceId, characters - offset)
}

function push(
  target: SandboxModelRequestPromptCompositionItem[],
  kind: SandboxModelRequestPromptKind,
  evidenceId: string,
  count: number,
): void {
  if (count > 0) target.push({ kind, evidenceId, characters: count })
}

function requestPreview(record: SandboxModelRequestRecord): string {
  const provider = record.provider || '未知渠道'
  const model = record.model || '未知模型'
  if (record.status === 'pending') return `${provider} / ${model} · 进行中`
  if (record.status === 'error') return `${provider} / ${model} · 请求失败`
  return `${provider} / ${model} · ${record.durationMs} ms`
}

function compactText(value: string): string {
  const normalized = normalizeEvidencePreviewText(value, TRAJECTORY_PREVIEW_LENGTH)
  return normalized.length > TRAJECTORY_PREVIEW_LENGTH ? `${normalized.slice(0, 177)}…` : normalized
}

export function statusLabel(status: SandboxModelRequestStatus): string {
  if (status === 'pending') return '进行中'
  if (status === 'error') return '错误'
  return '已完成'
}

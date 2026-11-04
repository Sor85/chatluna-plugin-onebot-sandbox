import type {
  SandboxModelRequestDetail,
  SandboxModelRequestStatus,
  SandboxModelRequestVariable,
} from '../../src/types'
import {
  sandboxEvidenceLabels,
  type SandboxEvidenceKind,
} from '../../src/evidence-kind'
import {
  SANDBOX_EVIDENCE_READING_ORDER,
  sandboxEvidenceReadingGroup,
  type SandboxEvidenceReadingGroup,
} from '../../src/evidence-reading-order'
import { normalizeEvidencePreviewText } from '../../src/evidence-preview-text'
import { modelRequestVariableStatusLabel } from '../../src/model-request-variables'
import type {
  ModelConversationMessage,
  ModelRequestConversation,
} from './conversation'

export interface ModelRequestAnalysisNavigationItem {
  id: string
  kind: SandboxEvidenceKind
  label: string
  index?: number
  preview: string
  /** 与轨迹行、组成分段共享的模型证据投影身份。响应分组头部本身不是一条证据，因此可缺省。 */
  evidenceId?: string
  target: string
  searchText: string
}

export interface ModelRequestAnalysisNavigationGroup {
  key: SandboxEvidenceReadingGroup
  label: string
  count: number
  items: ModelRequestAnalysisNavigationItem[]
}

export interface ModelRequestAnalysisBoundary {
  label: string
  status: SandboxModelRequestStatus
  model?: string
  provider?: string
  durationMs: number
  target: string
}

export interface ModelRequestAnalysisNavigation {
  boundary: ModelRequestAnalysisBoundary
  groups: ModelRequestAnalysisNavigationGroup[]
  /** evidenceId → 分析视图定位目标。跨视图定位只依赖这张表，不再重算角色内序号。 */
  targets: Record<string, string>
  /** 导航项 id → 已归一化的搜索文本。右侧卡片的命中判定也读这张表，两侧不可能派生出两套口径。 */
  searchTexts: Record<string, string>
  searchText: string
}

export const MODEL_ANALYSIS_RESPONSE_TARGET = 'model-analysis-response'
export const MODEL_ANALYSIS_TOOLS_TARGET = 'model-analysis-tools'

export function modelAnalysisVariableTargetId(variableId: string): string {
  return modelAnalysisTargetId(`variable:${variableId}`)
}

export function normalizeAnalysisQuery(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase('zh-CN') ?? ''
}

/** 返回阅读探针当前经过的具体导航目标，用于同步左侧条目。 */
export function resolveActiveAnalysisTarget(
  positions: readonly { target: string, top: number }[],
  scrollerTop: number,
  scrollerHeight: number,
): string | undefined {
  const probeTop = analysisProbeTop(scrollerTop, scrollerHeight)
  let active: string | undefined
  for (const position of positions) {
    if (position.top > probeTop) break
    active = position.target
  }
  return active
}

function analysisProbeTop(scrollerTop: number, scrollerHeight: number): number {
  return scrollerTop + Math.min(120, Math.max(0, scrollerHeight) * 0.25)
}

/**
 * 把模型证据身份编码成分析视图的 DOM 目标。
 *
 * evidenceId 已经是确定性的，这里只做 DOM id 允许字符的收敛，不引入第二套排序或序号规则。
 */
export function modelAnalysisTargetId(evidenceId: string): string {
  return `model-analysis-${evidenceId.replace(/[^\w:.-]+/g, '_')}`
}

export function buildModelRequestAnalysisNavigation(
  conversation: ModelRequestConversation,
  detail: Pick<SandboxModelRequestDetail, 'sequence' | 'status' | 'model' | 'provider' | 'durationMs' | 'variables'>,
): ModelRequestAnalysisNavigation {
  const grouped = new Map<SandboxEvidenceReadingGroup, ModelRequestAnalysisNavigationItem[]>()
  const targets: Record<string, string> = {}
  const searchTexts: Record<string, string> = {}
  const add = (key: SandboxEvidenceReadingGroup, item: ModelRequestAnalysisNavigationItem) => {
    const items = grouped.get(key) ?? []
    const searchText = normalizeAnalysisQuery(item.searchText)
    items.push({ ...item, searchText })
    grouped.set(key, items)
    searchTexts[item.id] = searchText
    if (item.evidenceId) targets[item.evidenceId] = item.target
  }

  for (const message of conversation.messages) {
    const group = sandboxEvidenceReadingGroup({ kind: message.kind })
    add(group, messageNavigationItem(message))
    for (const call of message.toolCalls) {
      add(group, {
        id: call.evidenceId,
        kind: 'tool-call',
        label: sandboxEvidenceLabels('tool-call').badge,
        index: message.index,
        preview: call.name,
        evidenceId: call.evidenceId,
        target: modelAnalysisTargetId(call.evidenceId),
        searchText: `${call.name}\n${call.id ?? ''}\n${call.arguments ?? ''}`,
      })
    }
  }

  conversation.tools.forEach((tool, index) => add('tool', {
    id: tool.evidenceId,
    kind: 'tool-definition',
    label: sandboxEvidenceLabels('tool-definition').badge,
    preview: tool.name,
    evidenceId: tool.evidenceId,
    // 第一个工具定义定位到 TOOL DEFS 区块头，让整段能力目录一起进入视野。
    target: index === 0 ? MODEL_ANALYSIS_TOOLS_TARGET : modelAnalysisTargetId(tool.evidenceId),
    searchText: tool.searchText,
  }))

  for (const variable of detail.variables ?? []) {
    add('variable', variableNavigationItem(variable))
  }

  const response = conversation.response
  if (response) {
    add('response', {
      id: 'response',
      kind: 'response',
      label: sandboxEvidenceLabels('response').badge,
      preview: compactAnalysisText(response.content.join('\n') || response.statusMessage || '本次响应'),
      target: MODEL_ANALYSIS_RESPONSE_TARGET,
      searchText: response.searchText,
    })
    // 正文、思考、结束原因和用量都落在同一张响应卡片上。
    for (const evidenceId of response.cardEvidenceIds) targets[evidenceId] = MODEL_ANALYSIS_RESPONSE_TARGET
    for (const call of response.toolCalls) {
      add('response', {
        id: call.evidenceId,
        kind: 'tool-call',
        label: sandboxEvidenceLabels('tool-call').badge,
        preview: call.name,
        evidenceId: call.evidenceId,
        target: modelAnalysisTargetId(call.evidenceId),
        searchText: `${call.name}\n${call.id ?? ''}\n${call.arguments ?? ''}`,
      })
    }
    for (const result of response.toolResults) {
      add('response', {
        id: result.evidenceId,
        kind: 'tool-result',
        label: sandboxEvidenceLabels('tool-result').badge,
        preview: result.name || result.id || '工具结果',
        evidenceId: result.evidenceId,
        target: modelAnalysisTargetId(result.evidenceId),
        searchText: `${result.name ?? ''}\n${result.id ?? ''}\n${result.content}`,
      })
    }
  }

  const groups = SANDBOX_EVIDENCE_READING_ORDER.flatMap((key) => {
    const items = grouped.get(key) ?? []
    return items.length ? [{ key, label: sandboxEvidenceLabels(key).title, count: items.length, items }] : []
  })
  return {
    boundary: {
      label: `请求 ${detail.sequence}`,
      status: detail.status,
      ...(detail.model ? { model: detail.model } : {}),
      ...(detail.provider ? { provider: detail.provider } : {}),
      durationMs: detail.durationMs,
      target: MODEL_ANALYSIS_RESPONSE_TARGET,
    },
    groups,
    targets,
    searchTexts,
    searchText: normalizeAnalysisQuery(conversation.searchText),
  }
}

/**
 * 导航项与右侧卡片共用的命中判定。
 *
 * 搜索文本只在导航项上派生一次，卡片按同一个 id 读回来；
 * 卡片自己重算一份就会出现「导航说有、正文说没有」。
 */
export function matchesAnalysisSearch(
  navigation: Pick<ModelRequestAnalysisNavigation, 'searchTexts'>,
  id: string,
  query: string,
): boolean {
  if (!query) return true
  return Boolean(navigation.searchTexts[id]?.includes(query))
}

/** 轨迹行、组成分段和分析导航共用同一张证据身份表；找不到时退回请求边界。 */
export function resolveAnalysisEvidenceTarget(
  navigation: ModelRequestAnalysisNavigation,
  evidenceId: string | undefined,
): string | undefined {
  if (!evidenceId) return navigation.groups[0]?.items[0]?.target ?? navigation.boundary.target
  return navigation.targets[evidenceId]
}

export function shouldExpandAnalysisText(
  manuallyExpanded: boolean,
  forceExpanded: boolean,
  query: string,
  value: string,
): boolean {
  return manuallyExpanded || forceExpanded || Boolean(query && value.toLocaleLowerCase('zh-CN').includes(query))
}

export function exceedsAnalysisLineLimit(
  renderedHeight: number,
  lineHeight: number,
  maxLines = 12,
): boolean {
  return renderedHeight > lineHeight * maxLines
}

export function compactAnalysisText(value: string, length = 80): string {
  const text = normalizeEvidencePreviewText(value, length)
  if (!text) return '无文本内容'
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text
}

export function isPreviewableConversationImage(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true
  return /^data:image\/(?!svg\+xml)[a-z0-9.+-]+;base64,[a-z\d+/=\s]+$/i.test(value)
}

export function formatEvidencePath(path: readonly string[]): string {
  return path.reduce((result, part) => /^\d+$/.test(part) ? `${result}[${part}]` : result ? `${result}.${part}` : part, '')
}

function variableNavigationItem(variable: SandboxModelRequestVariable): ModelRequestAnalysisNavigationItem {
  const statusText = variable.status === 'observed'
    ? variable.value ?? ''
    : modelRequestVariableStatusLabel(variable.status)
  return {
    id: variable.id,
    kind: 'variable',
    label: sandboxEvidenceLabels('variable').badge,
    preview: variable.name,
    evidenceId: `variable:${variable.id}`,
    target: modelAnalysisVariableTargetId(variable.id),
    searchText: `${variable.name}\n${statusText}\n${variable.presetName}`,
  }
}

function messageNavigationItem(message: ModelConversationMessage): ModelRequestAnalysisNavigationItem {
  return {
    id: message.evidenceId,
    kind: message.kind,
    label: sandboxEvidenceLabels(message.kind).badge,
    index: message.index,
    preview: compactAnalysisText(message.content || message.reasoning || message.toolCalls[0]?.name || '无文本内容'),
    evidenceId: message.evidenceId,
    target: modelAnalysisTargetId(message.evidenceId),
    searchText: message.searchText,
  }
}

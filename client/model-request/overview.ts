import { formatDuration } from '../shared/format-duration'
import type {
  SandboxModelRequestDetail,
  SandboxModelRequestEntities,
  SandboxModelRequestListItem,
  SandboxModelRequestUsage,
  SandboxPresetDocumentKind,
} from '../../src/types'

/**
 * 详情概览与用量格的取词。
 *
 * 三态在这里收敛成一套：字段有值就渲染值；采集到了但内容缺省渲染「未识别」；
 * 整项都没采集到渲染缺省符号。原先六个概览格各写一遍 `x || '未识别'` 或 `x ?? '—'`，
 * 谁用哪一种全凭手写，改一格不会连带另外五格。
 *
 * 模型名称的唯一来源也在这里：它是采集那一刻的记录事实，不允许再从请求体或
 * 请求地址推断第二份。视图只能问这个函数要展示名。
 */
const MODEL_REQUEST_UNIDENTIFIED_TEXT = '未识别'
const MODEL_REQUEST_MISSING_TEXT = '—'

export interface ModelRequestUsageCell {
  label: string
  value: string
}

export interface ModelRequestEntityChip {
  key: keyof SandboxModelRequestEntities
  label: string
  value: string
}

/**
 * 关联实体的项目、顺序与文案。
 *
 * 记录里的 entities 是采集时按赋值先后堆起来的对象，直接遍历会把顺序交给采集实现，
 * 加一个字段就可能让详情页的读法变样。这里按「记录域 → 机器人 → 会话」由外到内排一次；
 * 顺序是展示契约的一部分，因此定义在这里，而不是在模板里手排。
 *
 * 记录域用领域词而不是筛选器上的「空间」：它还包含主模拟 QQ 环境与未归属，
 * 把 `main` 说成空间会和 AI 测试空间混成一个概念。
 */
const MODEL_REQUEST_ENTITY_FIELDS: readonly (readonly [keyof SandboxModelRequestEntities, string])[] = [
  ['scopeId', '记录域'],
  ['botId', '机器人 ID'],
  ['conversationId', '会话 ID'],
]

/** 空串与缺省都算没采集到：`botId=''` 渲染成一个空标签，比不渲染更难看懂。 */
export function buildModelRequestEntityChips(
  entities: SandboxModelRequestEntities,
): ModelRequestEntityChip[] {
  return MODEL_REQUEST_ENTITY_FIELDS.flatMap(([key, label]) => {
    const value = entities[key]
    return value ? [{ key, label, value }] : []
  })
}

/** 模型 ID 与渠道名同一口径：采集到就照原样显示，空串与缺省都算没识别出来。 */
export function formatModelRequestModelName(model: string | undefined): string {
  return model || MODEL_REQUEST_UNIDENTIFIED_TEXT
}

export function formatModelRequestChannelName(provider: string | undefined): string {
  return provider || MODEL_REQUEST_UNIDENTIFIED_TEXT
}

/**
 * 模型请求来源只从运行时预设快照判断：核心 ChatLuna 预设属于主插件，Character 预设
 * 属于 character。没有快照或同时出现两种快照时不猜测来源，避免把渠道地址误当成来源。
 */
export function formatModelRequestSource(
  record: Pick<SandboxModelRequestListItem, 'presetSnapshotSummaries'>
    | Pick<SandboxModelRequestDetail, 'presetSnapshots'>
    | undefined,
): string {
  const kinds = new Set<SandboxPresetDocumentKind>([
    ...(record && 'presetSnapshotSummaries' in record
      ? record.presetSnapshotSummaries?.map(({ kind }) => kind) ?? []
      : []),
    ...(record && 'presetSnapshots' in record
      ? record.presetSnapshots?.map(({ kind }) => kind) ?? []
      : []),
  ])
  if (kinds.size !== 1) return MODEL_REQUEST_UNIDENTIFIED_TEXT
  return kinds.has('character') ? 'character' : '主插件'
}

/** 计数类概览格：0 是有意义的事实，只有整项缺省才退到缺省符号。 */
export function formatModelRequestCount(value: number | undefined): string {
  return value === undefined ? MODEL_REQUEST_MISSING_TEXT : String(value)
}

/**
 * 一条请求的展示标签，用在轨迹账本的请求行与时间分段上。
 * 渠道与模型都没采集到时退回通称，不拼出「 / 」这种半截标签。
 */
export function formatModelRequestLabel(
  request: { provider?: string, model?: string } | undefined,
): string {
  return [request?.provider, request?.model].filter(Boolean).join(' / ') || '模型请求'
}

/** 会话里的第几次请求。序号来自轨迹 records 的原始顺序，账本排序不改它。 */
export function formatModelRequestOrdinal(index: number | undefined): string {
  return index === undefined ? '请求' : `请求 ${index + 1}`
}

export function formatModelRequestTokenCount(value: number | undefined): string {
  return value === undefined ? MODEL_REQUEST_MISSING_TEXT : new Intl.NumberFormat('zh-CN').format(value)
}

export function formatModelRequestTokenRate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return MODEL_REQUEST_MISSING_TEXT
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)} /s`
}

/**
 * 用量格的八项及其顺序。顺序是展示契约的一部分：Token 四项在前、合计居中、
 * 速度与耗时在后，因此由这里定义一次，而不是在模板里手排八个 article。
 */
export function buildModelRequestUsageCells(usage: SandboxModelRequestUsage | undefined): ModelRequestUsageCell[] {
  return [
    { label: '输入', value: formatModelRequestTokenCount(usage?.inputTokens) },
    { label: '输出', value: formatModelRequestTokenCount(usage?.outputTokens) },
    { label: '推理', value: formatModelRequestTokenCount(usage?.reasoningTokens) },
    { label: '缓存', value: formatModelRequestTokenCount(usage?.cachedTokens) },
    { label: '总 Token', value: formatModelRequestTokenCount(usage?.totalTokens) },
    { label: 'TTFT', value: formatModelRequestDuration(usage?.ttftMs) },
    { label: 'TPS', value: formatModelRequestTokenRate(usage?.tps) },
    { label: '总耗时', value: formatModelRequestDuration(usage?.totalMs) },
  ]
}

/** 耗时缺省时要落到缺省符号，不能把 undefined 交给只认数字的耗时格式化。 */
function formatModelRequestDuration(durationMs: number | undefined): string {
  return formatDuration(durationMs ?? Number.NaN)
}

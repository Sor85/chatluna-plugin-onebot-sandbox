import { isRecord } from './shared'
import type { ModelEvidenceUsageCandidate } from './types'

/**
 * 响应体用量候选归一化。
 *
 * 这是协议知识（`prompt_tokens` / `input_tokens` / `promptTokenCount` 各家命名不同），
 * 因此归属共享投影；最终采用哪个用量仍由调用方按 ADR-0059 的优先级决定。
 */
export function normalizeUsageCandidate(usage: Record<string, unknown> | undefined): ModelEvidenceUsageCandidate | undefined {
  if (!usage) return undefined

  const cacheReadTokens = readUsageNumber(usage, ['cache_read_input_tokens']) ?? 0
  const cacheCreationTokens = readUsageNumber(usage, ['cache_creation_input_tokens']) ?? 0
  const cachedTokens = firstUsageNumber(usage, [
    ['prompt_tokens_details', 'cached_tokens'],
    ['input_tokens_details', 'cached_tokens'],
    ['cachedContentTokenCount'],
  ]) ?? (cacheReadTokens + cacheCreationTokens || undefined)
  const reasoningTokens = firstUsageNumber(usage, [
    ['completion_tokens_details', 'reasoning_tokens'],
    ['output_tokens_details', 'reasoning_tokens'],
    ['thoughtsTokenCount'],
    ['reasoning_tokens'],
  ])

  let inputTokens = firstUsageNumber(usage, [
    ['prompt_tokens'],
    ['promptTokenCount'],
  ])
  if (inputTokens === undefined) {
    const uncachedInputTokens = readUsageNumber(usage, ['input_tokens'])
    inputTokens = uncachedInputTokens === undefined
      ? undefined
      : uncachedInputTokens + cacheReadTokens + cacheCreationTokens
  }

  let outputTokens = firstUsageNumber(usage, [
    ['completion_tokens'],
    ['output_tokens'],
    ['candidatesTokenCount'],
  ])
  // OpenAI 的 completion_tokens 含推理，需要拆出可见输出。
  if (outputTokens !== undefined && reasoningTokens !== undefined && 'completion_tokens' in usage) {
    outputTokens = Math.max(0, outputTokens - reasoningTokens)
  }

  const reportedTotal = firstUsageNumber(usage, [
    ['total_tokens'],
    ['totalTokenCount'],
  ])
  // 部分网关把 completion_tokens 报成与 reasoning 相同，可见输出只体现在 total_tokens。
  // 例如输入 14228、推理 406、总计 14852 时，扣减后输出会变成 0，实际可见输出是 218。
  if ((outputTokens === undefined || outputTokens === 0) && inputTokens !== undefined && reportedTotal !== undefined) {
    const impliedVisible = reportedTotal - inputTokens - (reasoningTokens ?? 0)
    if (impliedVisible > 0) outputTokens = impliedVisible
  }

  const totalTokens = reportedTotal ?? sumUsageTokens(inputTokens, outputTokens, reasoningTokens)
  const normalized = { inputTokens, outputTokens, reasoningTokens, cachedTokens, totalTokens }
  return Object.values(normalized).some(value => value !== undefined) ? normalized : undefined
}

/** 流式响应会分批上报用量；后到的残缺片段不得把已知数值覆盖成更小值。 */
export function mergeUsage(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!current) return { ...incoming }
  const merged = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const existing = merged[key]
      merged[key] = typeof existing === 'number' ? Math.max(existing, value) : value
      continue
    }
    if (isRecord(value)) {
      const existing = merged[key]
      merged[key] = isRecord(existing) ? mergeUsage(existing, value) : { ...value }
      continue
    }
    if (value !== undefined) merged[key] = value
  }
  return merged
}

function firstUsageNumber(usage: Record<string, unknown>, paths: readonly (readonly string[])[]): number | undefined {
  for (const path of paths) {
    const value = readUsageNumber(usage, path)
    if (value !== undefined) return value
  }
}

function readUsageNumber(usage: Record<string, unknown>, path: readonly string[]): number | undefined {
  let value: unknown = usage
  for (const key of path) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sumUsageTokens(...values: Array<number | undefined>): number | undefined {
  const available = values.filter((value): value is number => value !== undefined)
  return available.length ? available.reduce((total, value) => total + value, 0) : undefined
}

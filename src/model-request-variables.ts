import { stringify } from 'yaml'
import type { ModelEvidenceProjection } from './model-evidence'
import { matchPresetExpressionEvidence } from './presets/evidence-match'
import { parsePresetSourceDocument } from './presets/source-document'
import type { PresetSourceDocument } from './presets/types'
import type {
  SandboxModelRequestVariable,
  SandboxPresetRuntimeSnapshot,
} from './types'

/**
 * 从运行时预设快照与一份已算好的模型证据投影派生模型请求变量。
 *
 * 本函数只读投影的请求消息，不解释请求体、响应原文或响应 transport 格式，
 * 因此不接收模型请求记录，也不自己决定是否运行投影——那由调用方（模型请求记录的读取投影）决定。
 */
export function deriveModelRequestVariables(
  snapshots: readonly SandboxPresetRuntimeSnapshot[],
  evidence: ModelEvidenceProjection,
): SandboxModelRequestVariable[] {
  const messages = new Map(evidence.requestMessages.map((message) => [message.evidenceId, message]))

  return snapshots.flatMap((snapshot, snapshotIndex) => {
    const document = documentFromRuntimeSnapshot(snapshot)
    return document.expressions
      .filter((expression) => expression.kind === 'value')
      .map((expression): SandboxModelRequestVariable => {
        const matched = matchPresetExpressionEvidence({ document, expression, snapshot, evidence })
        const base = {
          id: `${snapshot.kind}:${snapshotIndex}:${JSON.stringify(expression.path)}#${expression.occurrence}`,
          name: expression.content.trim(),
          presetKind: snapshot.kind,
          presetName: snapshot.presetName,
          path: expression.path,
          occurrence: expression.occurrence,
        }
        if (matched.status !== 'matched') return { ...base, status: matched.status }
        const message = messages.get(matched.evidenceId)
        if (!message || matched.range.start < 0 || matched.range.end < matched.range.start
          || matched.range.end > message.text.length) {
          return { ...base, status: 'not-observed' }
        }
        return {
          ...base,
          status: 'observed',
          value: message.text.slice(matched.range.start, matched.range.end),
          evidenceId: matched.evidenceId,
          range: matched.range,
        }
      })
  })
}

/**
 * 模型请求变量未被唯一证明时的状态说明文案。
 *
 * 轨迹行预览、分析导航项的搜索文本与右侧变量卡片正文共用这一份文案；
 * 任何一侧自己再写一份，搜索这些文案时就会出现一侧命中、另一侧置灰。
 */
export function modelRequestVariableStatusLabel(status: SandboxModelRequestVariable['status']): string {
  if (status === 'ambiguous') return '展开值存在歧义'
  if (status === 'stale') return '预设快照已变化'
  if (status === 'unsupported') return '表达式不支持定位'
  return '未在模型请求中观察到展开值'
}

function documentFromRuntimeSnapshot(snapshot: SandboxPresetRuntimeSnapshot): PresetSourceDocument {
  if (snapshot.kind === 'character') {
    const fields = Object.fromEntries(snapshot.templates.flatMap((template) => (
      (template.path[0] === 'system' || template.path[0] === 'input')
        ? [[template.path[0], template.template]]
        : []
    )))
    return parsePresetSourceDocument('character', stringify(fields))
  }

  const prompts: Array<{ role: string, content: string } | undefined> = []
  let formatUserPrompt: string | undefined
  for (const template of snapshot.templates) {
    if (template.path[0] === 'format_user_prompt') {
      formatUserPrompt = template.template
      continue
    }
    const index = template.path[0] === 'prompts' && typeof template.path[1] === 'number'
      ? template.path[1]
      : undefined
    if (index !== undefined) prompts[index] = { role: template.role, content: template.template }
  }
  return parsePresetSourceDocument('core', stringify({
    prompts: prompts.map((prompt) => prompt ?? {}),
    ...(formatUserPrompt !== undefined ? { format_user_prompt: formatUserPrompt } : {}),
  }))
}

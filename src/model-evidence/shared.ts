import type {
  ModelEvidenceContentPart,
  ModelEvidenceRegion,
  ModelEvidenceSource,
} from './types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function source(region: ModelEvidenceRegion, path: readonly string[], value: unknown): ModelEvidenceSource {
  return { region, path, value }
}

/**
 * 证据身份由区域、语义种类和原始结构路径派生。
 *
 * 不使用角色内序号：同一份原始证据在轨迹、组成图和分析视图里必须得到同一个 id，
 * 而角色内序号会随折叠条件、会话聚合范围和分组顺序变化。
 * 语义种类参与身份，让同一个父节点上的消息与工具调用不会互相覆盖。
 */
export function evidenceId(region: ModelEvidenceRegion, kind: string, path: readonly string[]): string {
  return `${region === 'request' ? 'req' : 'res'}:${kind}:${path.join('.')}`
}

export function semanticText(parts: readonly ModelEvidenceContentPart[]): string {
  return parts
    .filter(part => part.kind === 'text' || part.kind === 'other')
    .map(part => part.value)
    .join('\n')
}

function mediaSource(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  if (typeof value.url === 'string') return value.url
  if (typeof value.data === 'string') {
    const mimeType = stringValue(value.media_type) ?? stringValue(value.mimeType) ?? stringValue(value.mediaType)
    return mimeType ? `data:${mimeType};base64,${value.data}` : value.data
  }
}

/** 通用（OpenAI / Anthropic / AI SDK）内容分片归一化，保留原始顺序与多模态种类。 */
export function normalizeContentParts(value: unknown): ModelEvidenceContentPart[] {
  if (typeof value === 'string') return [{ kind: 'text', value }]
  if (isRecord(value)) {
    if (Array.isArray(value.parts)) return normalizeContentParts(value.parts)
    return normalizeContentParts([value])
  }
  if (!Array.isArray(value)) return value === undefined ? [] : [{ kind: 'other', value: stringifyValue(value) }]
  return value.flatMap((item): ModelEvidenceContentPart[] => {
    if (typeof item === 'string') return [{ kind: 'text', value: item }]
    if (!isRecord(item)) return []
    // Gemini 的多模态字段与 OpenAI 完全不同；按结构识别，避免 inlineData 被当成未知对象。
    if (isRecord(item.inlineData) || isRecord(item.fileData)) return normalizeGeminiPart(item)
    const text = item.text ?? item.output_text ?? item.content
    if (typeof text === 'string') return [{ kind: 'text', value: text }]
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : ''
    const mimeType = stringValue(item.mediaType) ?? stringValue(item.mimeType) ?? stringValue(item.media_type)
    const media = mediaSource(item.image_url ?? item.image ?? item.source ?? item.url ?? item.data)
    if (type.includes('image') || mimeType?.startsWith('image/') || item.image_url || item.image) {
      return [{ kind: 'image', value: media ?? '[图片]', ...(mimeType ? { mimeType } : {}) }]
    }
    if (type.includes('file') || mimeType && !mimeType.startsWith('image/')) {
      return [{ kind: 'file', value: media ?? '[文件]', ...(mimeType ? { mimeType } : {}) }]
    }
    if (type.includes('audio')) return [{ kind: 'audio', value: media ?? '[音频]', ...(mimeType ? { mimeType } : {}) }]
    if (type.includes('video')) return [{ kind: 'video', value: media ?? '[视频]', ...(mimeType ? { mimeType } : {}) }]
    return [{ kind: 'other', value: stringifyValue(item) }]
  })
}

/** Gemini part 归一化：inlineData / fileData 与 OpenAI 的多模态字段完全不同。 */
export function normalizeGeminiPart(value: unknown): ModelEvidenceContentPart[] {
  if (!isRecord(value)) return []
  if (typeof value.text === 'string') return [{ kind: 'text', value: value.text }]
  if (isRecord(value.inlineData)) {
    const mimeType = stringValue(value.inlineData.mimeType)
    const data = typeof value.inlineData.data === 'string' ? value.inlineData.data : ''
    if (mimeType?.startsWith('image/') && mimeType !== 'image/svg+xml') {
      return [{ kind: 'image', value: `data:${mimeType};base64,${data}`, mimeType }]
    }
    return [{
      kind: mimeType?.startsWith('audio/') ? 'audio' : mimeType?.startsWith('video/') ? 'video' : 'file',
      value: data || '[内联文件]',
      ...(mimeType ? { mimeType } : {}),
    }]
  }
  if (isRecord(value.fileData)) {
    const mimeType = stringValue(value.fileData.mimeType)
    const media = stringValue(value.fileData.fileUri) ?? '[文件]'
    return [{
      kind: mimeType?.startsWith('image/')
        ? 'image'
        : mimeType?.startsWith('audio/')
          ? 'audio'
          : mimeType?.startsWith('video/') ? 'video' : 'file',
      value: media,
      ...(mimeType ? { mimeType } : {}),
    }]
  }
  return [{ kind: 'other', value: stringifyValue(value) }]
}

/** AI SDK 工具输出是 typed 值（`{type:'json'|'text', value}`），不能直接 stringify 整个包装。 */
export function normalizeToolOutput(value: unknown): string {
  if (isRecord(value) && value.type === 'json' && 'value' in value) return stringifyValue(value.value)
  if (isRecord(value) && value.type === 'text' && typeof value.value === 'string') return value.value
  return stringifyValue(value ?? '')
}

/**
 * 读取显式调用标识。
 *
 * 只认专门表示“配对到哪次调用”的字段。裸 `id` 不在其中：消息、Responses item 和 AI SDK part
 * 都带自己的条目 id，把条目 id 当调用标识会凭空造出工具调用与工具结果的配对关系，
 * 而领域约定要求缺少显式调用标识时不做任何推断配对。
 */
export function readCallId(value: Record<string, unknown>): string | undefined {
  return stringValue(value.tool_call_id)
    ?? stringValue(value.toolCallId)
    ?? stringValue(value.call_id)
    ?? stringValue(value.callId)
    ?? stringValue(value.tool_use_id)
}

/**
 * 读取工具调用/工具结果对象自身的调用标识。
 *
 * 仅当传入记录本身就是调用或结果对象时才可用：OpenAI `tool_calls[i]`、Anthropic `tool_use`、
 * Gemini `functionCall` / `functionResponse` 的 `id` 就是调用标识本身。
 * 传入消息或 item 包装对象会退化成按条目 id 推断配对，是错误用法。
 */
export function readCallObjectId(value: Record<string, unknown>): string | undefined {
  return readCallId(value) ?? stringValue(value.id)
}

export function readToolName(value: Record<string, unknown>): string | undefined {
  return stringValue(value.name) ?? stringValue(value.toolName) ?? stringValue(value.tool_name)
}

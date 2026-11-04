function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readAttrsText(attrs: Record<string, unknown>) {
  for (const key of ['content', 'text']) {
    const value = attrs[key]
    if (value != null && String(value).trim()) return String(value)
  }
  return ''
}

// ChatLuna 的回复快照在不同链路上分别是字符串、Koishi 元素树或 LangChain 序列化消息，
// 逐层展开这些形状才能拿到仍然带 <think> 的原始文本。
export function readStructuredText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(readStructuredText).join('')
  if (!isRecord(value)) return ''
  if (value.content !== undefined && value.content !== value) return readStructuredText(value.content)
  if (value.text !== undefined) return readStructuredText(value.text)
  if (Array.isArray(value.children)) return readStructuredText(value.children)
  if (isRecord(value.attrs)) return readAttrsText(value.attrs)
  if (isRecord(value.kwargs)) return readStructuredText(value.kwargs)
  if (isRecord(value.lc_kwargs)) return readStructuredText(value.lc_kwargs)
  return ''
}

function isAssistantMessageSnapshot(value: unknown) {
  if (!isRecord(value)) return false
  const role = String(value.role ?? value.type ?? '').trim().toLowerCase()
  if (role === 'assistant' || role === 'ai') return true
  const id = Array.isArray(value.id) ? value.id.map(String).join(':').toLowerCase() : ''
  return id.includes('aimessage') || id.includes('assistantmessage')
}

function readCompletionMessagesText(value: unknown) {
  if (!Array.isArray(value)) return ''
  for (let index = value.length - 1; index >= 0; index--) {
    if (!isAssistantMessageSnapshot(value[index])) continue
    const text = readStructuredText(value[index])
    if (text) return text
  }
  return ''
}

export function readChatLunaResponseText(payload: {
  lastResponseMessage?: unknown
  completionMessages?: unknown
  text?: unknown
}): string {
  const candidates = [
    readStructuredText(payload.lastResponseMessage),
    readStructuredText(payload.text),
    readCompletionMessagesText(payload.completionMessages),
  ].filter(Boolean)
  // lastResponseMessage 有时已是发送出去的清理后文本，<think> 只留在 completionMessages 快照里；
  // 不能被第一个非空候选提前截断。
  return candidates.find((text) => parseThinkContent(text)) || candidates[0] || ''
}

export function parseThinkContent(text: string): string {
  return Array.from(text.matchAll(/<think\b[^>]*>([\s\S]*?)<\/think\s*>/gi))
    .map((match) => (match[1] ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}

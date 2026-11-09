/** `reply` 工具（`render.reply = tool`）的名字，与 v2 `packages/chat/core/src/render/reply-tool.ts` 同步。 */
const REPLY_TOOL = 'reply'

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * 读一步模型调用里角色写下的内心活动（v2 character 引擎的 `<think>` 元素）。
 *
 * 文本模式下模型直接写元素，`<think>` 留在 assistant 文本块里；工具模式下同一套元素写在 `reply` 工具的
 * `content` 参数里。模型原生的 reasoning 块不算：它是模型的推理过程，不是角色的内心活动，混进来就看不出
 * 「生成内心活动」有没有生效。
 */
export function readStepThought(step: unknown): string {
  const record = readRecord(step)
  const blocks: unknown[] = Array.isArray(record?.content) ? record.content : []
  return blocks
    .map((value) => {
      const block = readRecord(value)
      if (block?.type === 'text' && typeof block.text === 'string') return parseThinkContent(block.text)
      const content = readRecord(block?.input)?.content
      if (block?.type === 'tool-call' && block.toolName === REPLY_TOOL && typeof content === 'string') return parseThinkContent(content)
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

export function parseThinkContent(text: string): string {
  return Array.from(text.matchAll(/<think\b[^>]*>([\s\S]*?)<\/think\s*>/gi))
    .map((match) => (match[1] ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}

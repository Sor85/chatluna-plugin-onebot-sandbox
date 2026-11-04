import type { ModelEvidenceMessage, ModelEvidenceToolCall, ModelEvidenceToolDefinition } from './types'

/**
 * 证据字符数度量。
 *
 * 请求组成图与分析卡片头部必须使用同一个公式，否则同一条证据会在两个视图里显示不同字符数。
 * 每项只统计它自己能证明的内容：消息不含工具调用参数，工具调用只算参数，工具定义算整段声明。
 */
export function countMessageCharacters(message: ModelEvidenceMessage): number {
  // 只含工具调用、没有可见正文的消息返回 0：它的字符数由对应的工具调用项统计，
  // 否则同一段参数会在消息项和工具调用项里被数两遍。
  const text = message.text || message.contentParts.map(part => part.value).join('\n')
  return text.length + (message.reasoning?.length ?? 0)
}

export function countToolCallCharacters(call: ModelEvidenceToolCall): number {
  return call.arguments?.length ?? serializedLength(call.sources[0]?.value)
}

export function countToolDefinitionCharacters(definition: ModelEvidenceToolDefinition): number {
  return serializedLength(definition.sources[0]?.value)
}

export function serializedLength(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return String(value).length
  }
}

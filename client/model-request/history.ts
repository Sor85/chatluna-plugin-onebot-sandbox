import { XMLParser, XMLValidator } from 'fast-xml-parser'

export const HISTORY_VARIABLE_NAMES = new Set(['history_new', 'history_last'])

export interface ModelRequestHistoryMessage {
  name?: string
  id?: string
  messageId?: string
  timestamp?: string
  content: string
  quote?: ModelRequestHistoryMessage
}

type OrderedXmlNode = Record<string, unknown> & {
  ':@'?: Record<string, unknown>
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
})

export function isHistoryVariableName(name: string): boolean {
  return HISTORY_VARIABLE_NAMES.has(name.trim())
}

/** Parse the exact XML emitted by chatluna-character without changing the evidence string. */
export function parseModelRequestHistory(value: string): ModelRequestHistoryMessage[] | undefined {
  const source = value.trim()
  if (!source) return undefined
  return parseMessageSequence(source)
}

function parseMessageSequence(source: string): ModelRequestHistoryMessage[] | undefined {
  const wrapped = `<history>${source}</history>`
  if (XMLValidator.validate(wrapped) !== true) return undefined

  try {
    const document = parser.parse(wrapped) as OrderedXmlNode[]
    if (document.length !== 1) return undefined
    const history = document[0]?.history
    if (!Array.isArray(history) || history.length === 0) return undefined

    const messages: ModelRequestHistoryMessage[] = []
    for (const node of history as OrderedXmlNode[]) {
      if (isWhitespaceNode(node)) continue
      if (!hasOnlyNodeKeys(node, ['message', ':@'])) return undefined
      const message = parseMessageNode(node)
      if (!message) return undefined
      messages.push(message)
    }
    return messages.length ? messages : undefined
  } catch {
    return undefined
  }
}

function parseMessageNode(node: OrderedXmlNode): ModelRequestHistoryMessage | undefined {
  const children = node.message
  if (!Array.isArray(children)) return undefined
  const attributes = node[':@'] ?? {}
  if (Object.values(attributes).some(value => typeof value !== 'string')) return undefined

  const quoteValue = stringAttribute(attributes.quote)
  const quoteMessages = quoteValue ? parseMessageSequence(quoteValue) : undefined
  if (quoteValue && quoteMessages?.length !== 1) return undefined

  return {
    name: stringAttribute(attributes.name),
    id: stringAttribute(attributes.id),
    messageId: stringAttribute(attributes.messageId),
    timestamp: stringAttribute(attributes.timestamp),
    content: renderMessageContent(children as OrderedXmlNode[]),
    quote: quoteMessages?.[0],
  }
}

function renderMessageContent(nodes: OrderedXmlNode[]): string {
  return nodes.map(renderContentNode).join('')
}

function renderContentNode(node: OrderedXmlNode): string {
  if (typeof node['#text'] === 'string') return node['#text']

  const tag = Object.keys(node).find(key => key !== ':@')
  if (!tag) return ''
  const children = node[tag]
  const content = Array.isArray(children) ? renderMessageContent(children as OrderedXmlNode[]) : ''
  const attributes = node[':@'] ?? {}

  if (tag === 'at') {
    const name = stringAttribute(attributes.name)
    return `@${name || content || stringAttribute(attributes.id) || ''}`
  }
  if (tag === 'face') return stringAttribute(attributes.name) || content || '[表情]'
  if (tag === 'image') return '[图片]'
  if (tag === 'sticker') return '[贴纸]'
  if (tag === 'file') return `[文件${stringAttribute(attributes.name) ? `: ${stringAttribute(attributes.name)}` : ''}]`
  if (tag === 'audio') return '[语音]'
  if (tag === 'video') return '[视频]'
  return content
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function isWhitespaceNode(node: OrderedXmlNode): boolean {
  return typeof node['#text'] === 'string' && node['#text'].trim() === '' && Object.keys(node).length === 1
}

function hasOnlyNodeKeys(node: OrderedXmlNode, allowed: readonly string[]): boolean {
  return Object.keys(node).every(key => allowed.includes(key))
}

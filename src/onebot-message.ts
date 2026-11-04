import { h, type Fragment } from '@satorijs/core'
import type { SandboxMedia } from './types'
import { SandboxDomainError } from './types'

export interface SandboxOneBotMessageSegment {
  type: string
  data: Record<string, string>
}

export type SandboxOutboundMediaType = 'image' | 'audio' | 'video' | 'file'

export interface SandboxOutboundMediaSource {
  type: SandboxOutboundMediaType
  source: string
  fileName?: string
  mimeType?: string
}

export interface SandboxOutboundMessage {
  content: string
  replyToRawId?: string
  mediaSources: SandboxOutboundMediaSource[]
}

export function parseKoishiOutboundMessage(fragment: Fragment): SandboxOutboundMessage {
  const result: SandboxOutboundMessage = { content: '', mediaSources: [] }
  for (const element of h.normalize(fragment)) appendKoishiElement(result, element)
  result.content = result.content.trim()
  return result
}

export function parseOneBotOutboundMessage(message: unknown): SandboxOutboundMessage {
  const result: SandboxOutboundMessage = { content: '', mediaSources: [] }
  if (typeof message === 'string') {
    appendCqMessage(result, message)
  } else if (Array.isArray(message)) {
    for (const segment of message) appendOneBotSegment(result, segment)
  } else {
    throw new SandboxDomainError('OneBot 消息不能为空')
  }
  result.content = result.content.trim()
  if (!result.content && !result.mediaSources.length) throw new SandboxDomainError('OneBot 消息不能为空')
  return result
}

export function toOneBotMessageSegments(content: string, media?: SandboxMedia[]): SandboxOneBotMessageSegment[] {
  if (media?.length) {
    const segments: SandboxOneBotMessageSegment[] = media.map((item) => ({
      type: item.type === 'audio' ? 'record' : item.type,
      data: { file: item.reference, url: item.reference, name: item.name },
    }))
    const generatedLabel = media.length === 1 ? `[${getMediaLabel(media[0])}] ${media[0].name}` : ''
    if (content && content !== generatedLabel) segments.push({ type: 'text', data: { text: content } })
    return segments
  }
  return h.parse(content).flatMap(toOneBotElementSegments)
}

export function toOneBotRawMessage(segments: SandboxOneBotMessageSegment[]): string {
  return segments.map(({ type, data }) => {
    if (type === 'text') return data.text ?? ''
    const attributes = Object.entries(data).map(([key, value]) => `${key}=${value}`).join(',')
    return `[CQ:${type}${attributes ? `,${attributes}` : ''}]`
  }).join('')
}

function appendKoishiElement(result: SandboxOutboundMessage, element: ReturnType<typeof h>): void {
  if (element.type === 'text') {
    result.content += String(element.attrs.content ?? '')
    return
  }
  if (element.type === 'br') {
    result.content += '\n'
    return
  }
  if (element.type === 'quote' || element.type === 'reply') {
    result.replyToRawId ??= readAttribute(element.attrs, 'id', 'messageId', 'message_id') || undefined
    return
  }
  const mediaType = getOutboundMediaType(element.type)
  if (mediaType) {
    result.mediaSources.push({
      type: mediaType,
      source: readAttribute(element.attrs, 'src', 'url', 'file'),
      fileName: readAttribute(element.attrs, 'title', 'name') || undefined,
      mimeType: readAttribute(element.attrs, 'mime', 'mimeType', 'mime_type') || undefined,
    })
    return
  }
  if (element.children.length) {
    for (const child of element.children) appendKoishiElement(result, child)
    return
  }
  result.content += element.toString()
}

function appendOneBotSegment(result: SandboxOutboundMessage, segment: unknown): void {
  if (!segment || typeof segment !== 'object') return
  const type = String(Reflect.get(segment, 'type') ?? 'unknown')
  const rawData = Reflect.get(segment, 'data')
  const data = rawData && typeof rawData === 'object'
    ? Object.fromEntries(Object.entries(rawData).map(([key, value]) => [key, String(value ?? '')]))
    : {}
  if (type === 'text') {
    result.content += data.text ?? ''
    return
  }
  if (type === 'reply' || type === 'quote') {
    result.replyToRawId ??= data.id || data.message_id || undefined
    return
  }
  const mediaType = getOutboundMediaType(type)
  if (mediaType) {
    result.mediaSources.push({
      type: mediaType,
      source: data.file || data.url || '',
      fileName: data.name || data.file_name || undefined,
      mimeType: data.mime || data.mime_type || undefined,
    })
    return
  }
  result.content += toOneBotRawMessage([{ type, data }])
}

function appendCqMessage(result: SandboxOutboundMessage, message: string): void {
  const pattern = /\[CQ:([\w-]+)((?:,[^\]]*)?)\]/g
  let offset = 0
  for (const match of message.matchAll(pattern)) {
    result.content += message.slice(offset, match.index)
    appendOneBotSegment(result, {
      type: match[1],
      data: parseCqAttributes(match[2]),
    })
    offset = (match.index ?? 0) + match[0].length
  }
  result.content += message.slice(offset)
}

function parseCqAttributes(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of source.replace(/^,/, '').split(',')) {
    if (!entry) continue
    const index = entry.indexOf('=')
    if (index < 0) continue
    result[entry.slice(0, index)] = decodeCqValue(entry.slice(index + 1))
  }
  return result
}

function decodeCqValue(value: string): string {
  return value
    .replaceAll('&#44;', ',')
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&amp;', '&')
}

function getOutboundMediaType(type: string): SandboxOutboundMediaType | undefined {
  if (type === 'img' || type === 'image' || type === 'sticker') return 'image'
  if (type === 'audio' || type === 'record') return 'audio'
  if (type === 'video') return 'video'
  if (type === 'file') return 'file'
}

function toOneBotElementSegments(element: ReturnType<typeof h>): SandboxOneBotMessageSegment[] {
  if (element.type === 'text') return [{ type: 'text', data: { text: String(element.attrs.content ?? '') } }]
  if (element.type === 'br') return [{ type: 'text', data: { text: '\n' } }]
  if (element.type === 'img' || element.type === 'image' || element.type === 'sticker') {
    const source = readAttribute(element.attrs, 'src', 'url', 'file')
    return source ? [{ type: 'image', data: { file: source, url: source } }] : []
  }
  if (element.type === 'audio' || element.type === 'record') {
    const source = readAttribute(element.attrs, 'src', 'url', 'file')
    return source ? [{ type: 'record', data: { file: source, url: source } }] : []
  }
  if (element.type === 'video' || element.type === 'file') {
    const source = readAttribute(element.attrs, 'src', 'url', 'file')
    if (!source) return []
    const name = readAttribute(element.attrs, 'title', 'name')
    return [{ type: element.type, data: { file: source, url: source, ...(name ? { name } : {}) } }]
  }
  if (element.type === 'at') {
    const id = readAttribute(element.attrs, 'id')
    return id ? [{ type: 'at', data: { qq: id } }] : []
  }
  if (element.type === 'quote') {
    const id = readAttribute(element.attrs, 'id')
    return id ? [{ type: 'reply', data: { id } }] : []
  }
  if (element.children.length) return element.children.flatMap(toOneBotElementSegments)
  return [{ type: 'text', data: { text: element.toString() } }]
}

function readAttribute(attributes: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function getMediaLabel(media: SandboxMedia): string {
  return media.type === 'image' ? '图片' : media.type === 'audio' ? '语音' : media.type === 'video' ? '视频' : '文件'
}

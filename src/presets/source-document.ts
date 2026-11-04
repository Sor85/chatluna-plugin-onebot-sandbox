import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Scalar,
} from 'yaml'
import type {
  PresetDocumentKind,
  PresetSourceDiagnostic,
  PresetSourceDocument,
  PresetSourcePath,
  PresetSourceRange,
  PresetTemplateExpression,
  PresetTemplateField,
} from './types'

type OffsetMap = number[]

interface ScalarSourceToken {
  type: 'scalar' | 'single-quoted-scalar' | 'double-quoted-scalar' | 'block-scalar'
  offset: number
  indent: number
  source: string
  props?: Array<{ type: string; source: string }>
}

interface LocatedScalar {
  range: PresetSourceRange
  value: string
  offsets: OffsetMap
  ends: OffsetMap
}

interface LocatedTemplateField extends PresetTemplateField {
  location: LocatedScalar
}

interface MappedText {
  value: string
  offsets: OffsetMap
  ends: OffsetMap
}

const CONTROL_TAG = /^(?:if(?:\s|$)|elseif(?:\s|$)|else\s*$|for(?:\s|$)|while(?:\s|$)|repeat(?:\s|$)|\/(?:if|for|while|repeat)\s*$)/

export function parsePresetSourceDocument(kind: PresetDocumentKind, source: string): PresetSourceDocument {
  const yaml = parseDocument(source, { keepSourceTokens: true, prettyErrors: false })
  const diagnostics: PresetSourceDiagnostic[] = yaml.errors.map((error) => ({
    code: 'yaml-parse-error',
    message: error.message,
    severity: 'error',
    range: error.pos?.length === 2 ? { start: error.pos[0], end: error.pos[1] } : undefined,
  }))
  const locatedFields: LocatedTemplateField[] = []

  if (kind === 'core') {
    const prompts = yaml.get('prompts', true)
    if (isSeq(prompts)) {
      prompts.items.forEach((prompt, index) => {
        if (!isMap(prompt)) return
        collectTemplateField(prompt.get('content', true), ['prompts', index, 'content'], locatedFields, diagnostics)
      })
    }
    collectTemplateField(yaml.get('format_user_prompt', true), ['format_user_prompt'], locatedFields, diagnostics)
  } else {
    collectTemplateField(yaml.get('system', true), ['system'], locatedFields, diagnostics)
    collectTemplateField(yaml.get('input', true), ['input'], locatedFields, diagnostics)
  }

  const expressions = locatedFields.flatMap((field) => scanTemplateExpressions(field, source))
  const templateFields = locatedFields.map(({ path, range, value }) => ({ path, range, value }))
  // 展示名称和模板字段一样是这次解析的产物：语法树已经在手上，不需要再跑一遍普通解析。
  // 「解析失败」只有一套口径——本次解析报出的 yaml-parse-error 诊断。刻意不看
  // template-field-not-string：那类诊断说明某个模板字段不是字符串，名称字段本身解析成功，
  // 把它也算作解析失败会让这类预设突然丢掉展示名称，与「语法错误才不显示展示名称」不符。
  const displayName = diagnostics.some(({ code }) => code === 'yaml-parse-error')
    ? undefined
    : readDisplayName(kind, yaml)
  return { kind, source, displayName, templateFields, expressions, diagnostics }
}

function readDisplayName(kind: PresetDocumentKind, yaml: Document): string | undefined {
  if (kind === 'character') return trimmedScalarString(yaml.get('name', true))
  const keywords = yaml.get('keywords', true)
  return isSeq(keywords) ? trimmedScalarString(keywords.items[0]) : undefined
}

function trimmedScalarString(node: unknown): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string' || !node.value.trim()) return undefined
  return node.value
}

function collectTemplateField(
  node: unknown,
  path: PresetSourcePath,
  fields: LocatedTemplateField[],
  diagnostics: PresetSourceDiagnostic[],
): void {
  if (node == null) return
  if (!isScalar(node) || typeof node.value !== 'string') {
    const range = nodeRange(node)
    diagnostics.push({
      code: 'template-field-not-string',
      message: `模板字段 ${formatPath(path)} 必须是字符串`,
      severity: 'error',
      path,
      range,
    })
    return
  }

  const location = locateScalar(node)
  if (!location) {
    diagnostics.push({
      code: 'template-field-not-string',
      message: `无法定位模板字段 ${formatPath(path)} 的源码范围`,
      severity: 'error',
      path,
      range: nodeRange(node),
    })
    return
  }
  fields.push({ path, range: location.range, value: node.value, location })
}

function scanTemplateExpressions(field: LocatedTemplateField, source: string): PresetTemplateExpression[] {
  const expressions: PresetTemplateExpression[] = []
  let position = 0
  let occurrence = 0

  while (position < field.value.length) {
    if (field.value.startsWith('{{', position) || field.value.startsWith('}}', position)) {
      position += 2
      continue
    }
    if (field.value[position] !== '{') {
      position += 1
      continue
    }

    const end = findTemplateTagEnd(field.value, position)
    if (end < 0) break
    const content = field.value.slice(position + 1, end)
    const startOffset = field.location.offsets[position]
    const endOffset = field.location.ends[end]
    if (startOffset != null && endOffset != null && source[startOffset] === '{' && source[endOffset - 1] === '}') {
      const range = { start: startOffset, end: endOffset }
      const sourceText = source.slice(range.start, range.end)
      if (sourceText.startsWith('{') && sourceText.endsWith('}')) {
        const kind = CONTROL_TAG.test(content.trim()) ? 'control' : 'value'
        expressions.push({
          path: field.path,
          range,
          content,
          kind,
          clickable: kind === 'value',
          occurrence,
        })
        occurrence += 1
      }
    }
    position = end + 1
  }
  return expressions
}

function findTemplateTagEnd(value: string, start: number): number {
  let depth = 1
  let quote = ''
  for (let position = start + 1; position < value.length; position += 1) {
    const character = value[position]
    if (quote) {
      if (character === '\\') position += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return position
    }
  }
  return -1
}

function locateScalar(node: Scalar): LocatedScalar | undefined {
  const range = node.range
  const token = node.srcToken as ScalarSourceToken | undefined
  if (!range || !token || typeof node.value !== 'string') return undefined

  let mapped: MappedText
  switch (token.type) {
    case 'scalar':
      mapped = locateFlowFolded(token.source, token.offset)
      break
    case 'single-quoted-scalar':
      mapped = collapseSingleQuotedEscapes(locateFlowFolded(token.source.slice(1, -1), token.offset + 1))
      break
    case 'double-quoted-scalar':
      mapped = locateDoubleQuoted(token.source, token.offset)
      break
    case 'block-scalar':
      mapped = locateBlockScalar(token)
      break
    default:
      return undefined
  }

  if (mapped.value !== node.value) return undefined
  return {
    range: { start: range[0], end: range[1] },
    value: mapped.value,
    offsets: mapped.offsets,
    ends: mapped.ends,
  }
}

function locateFlowFolded(source: string, sourceStart: number): MappedText {
  let first: RegExp
  let line: RegExp
  try {
    first = new RegExp('(.*?)(?<![ \\t])[ \\t]*\\r?\\n', 'sy')
    line = new RegExp('[ \\t]*(.*?)(?:(?<![ \\t])[ \\t]*)?\\r?\\n', 'sy')
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy
  }

  const builder = mappedBuilder()
  let match = first.exec(source)
  if (!match) {
    builder.appendSource(source, sourceStart)
    return builder.result()
  }

  builder.appendSource(match[1], sourceStart)
  let separator = ' '
  let separatorStart = match[0].length - newlineWidth(match[0])
  let position = first.lastIndex
  line.lastIndex = position
  while ((match = line.exec(source))) {
    const leadingWhitespace = match[0].length - match[0].trimStart().length
    const contentStart = position + leadingWhitespace
    const newlineStart = position + match[0].length - newlineWidth(match[0])
    if (match[1] === '') {
      if (separator === '\n') builder.appendGenerated(separator, sourceStart + separatorStart, sourceStart + separatorStart + newlineWidthAt(source, separatorStart))
      else separator = '\n'
    } else {
      builder.appendGenerated(separator, sourceStart + separatorStart, sourceStart + separatorStart + newlineWidthAt(source, separatorStart))
      builder.appendSource(match[1], sourceStart + contentStart)
      separator = ' '
    }
    separatorStart = newlineStart
    position = line.lastIndex
  }

  const last = /[ \t]*(.*)/sy
  last.lastIndex = position
  match = last.exec(source)
  const lastText = match?.[1] ?? ''
  const leadingWhitespace = (match?.[0].length ?? 0) - lastText.length
  builder.appendGenerated(separator, sourceStart + separatorStart, sourceStart + separatorStart + newlineWidthAt(source, separatorStart))
  builder.appendSource(lastText, sourceStart + position + leadingWhitespace)
  return builder.result()
}

function collapseSingleQuotedEscapes(mapped: MappedText): MappedText {
  const builder = mappedBuilder()
  for (let position = 0; position < mapped.value.length; position += 1) {
    if (mapped.value[position] === "'" && mapped.value[position + 1] === "'") {
      builder.appendMapped("'", mapped.offsets[position], mapped.ends[position + 1])
      position += 1
    } else {
      builder.appendMapped(mapped.value[position], mapped.offsets[position], mapped.ends[position])
    }
  }
  return builder.result()
}

function locateDoubleQuoted(source: string, sourceStart: number): MappedText {
  const builder = mappedBuilder()
  for (let position = 1; position < source.length - 1; position += 1) {
    const character = source[position]
    if (character === '\r' && source[position + 1] === '\n') continue
    if (character === '\n') {
      const folded = foldDoubleQuotedNewline(source, position)
      builder.appendGenerated(folded.value, sourceStart + position, sourceStart + folded.offset + 1)
      position = folded.offset
      continue
    }
    if (character === '\\') {
      let next = source[++position]
      const escapeStart = position - 1
      const simple = DOUBLE_QUOTED_ESCAPES[next]
      if (simple != null) {
        builder.appendGenerated(simple, sourceStart + escapeStart, sourceStart + position + 1)
      } else if (next === '\n') {
        next = source[position + 1]
        while (next === ' ' || next === '\t') next = source[++position + 1]
      } else if (next === '\r' && source[position + 1] === '\n') {
        position += 1
        next = source[position + 1]
        while (next === ' ' || next === '\t') next = source[++position + 1]
      } else if (next === 'x' || next === 'u' || next === 'U') {
        const width = next === 'x' ? 2 : next === 'u' ? 4 : 8
        const codePoint = Number.parseInt(source.slice(position + 1, position + 1 + width), 16)
        const decoded = String.fromCodePoint(codePoint)
        builder.appendGenerated(decoded, sourceStart + escapeStart, sourceStart + position + width + 1)
        position += width
      } else {
        builder.appendSource(source.slice(escapeStart, position + 1), sourceStart + escapeStart)
      }
      continue
    }
    if (character === ' ' || character === '\t') {
      const whitespaceStart = position
      let next = source[position + 1]
      while (next === ' ' || next === '\t') next = source[++position + 1]
      if (next !== '\n' && !(next === '\r' && source[position + 2] === '\n')) {
        builder.appendSource(source.slice(whitespaceStart, position + 1), sourceStart + whitespaceStart)
      }
      continue
    }
    builder.appendSource(character, sourceStart + position)
  }
  return builder.result()
}

function foldDoubleQuotedNewline(source: string, start: number): { value: string; offset: number } {
  let value = ''
  let offset = start
  let character = source[offset + 1]
  while (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
    if (character === '\r' && source[offset + 2] !== '\n') break
    if (character === '\n') value += '\n'
    offset += 1
    character = source[offset + 1]
  }
  return { value: value || ' ', offset }
}

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  '\t': '\t',
}

function locateBlockScalar(token: ScalarSourceToken): MappedText {
  const header = parseBlockHeader(token)
  const contentBase = token.offset + header.length
  const lines = splitBlockLines(token.source)
  let chompStart = lines.length
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const content = lines[index].content
    if (content === '' || content === '\r') chompStart = index
    else break
  }

  const builder = mappedBuilder()
  if (chompStart === 0) {
    if (header.chomp === '+' && lines.length > 0) {
      builder.appendGenerated('\n'.repeat(Math.max(1, lines.length - 1)), contentBase, contentBase + token.source.length)
    }
    return builder.result()
  }

  let trimIndent = token.indent + header.indent
  let contentStart = 0
  for (let index = 0; index < chompStart; index += 1) {
    const line = lines[index]
    if (line.content === '' || line.content === '\r') {
      if (header.indent === 0 && line.indent.length > trimIndent) trimIndent = line.indent.length
    } else {
      if (header.indent === 0) trimIndent = line.indent.length
      contentStart = index
      break
    }
  }
  for (let index = lines.length - 1; index >= chompStart; index -= 1) {
    if (lines[index].indent.length > trimIndent) chompStart = index + 1
  }

  let separator = ''
  let separatorRange = { start: contentBase, end: contentBase }
  let previousMoreIndented = false
  for (let index = 0; index < contentStart; index += 1) {
    const line = lines[index]
    builder.appendSource(line.indent.slice(trimIndent), contentBase + line.contentOffset - line.indent.length + trimIndent)
    builder.appendGenerated('\n', contentBase + line.newlineStart, contentBase + line.newlineEnd)
  }
  for (let index = contentStart; index < chompStart; index += 1) {
    const line = lines[index]
    let content = line.content
    if (content.endsWith('\r')) content = content.slice(0, -1)
    const retainedIndent = line.indent.slice(trimIndent)
    const retainedOffset = contentBase + line.contentOffset - line.indent.length + trimIndent

    if (header.mode === '|') {
      builder.appendGenerated(separator, separatorRange.start, separatorRange.end)
      builder.appendSource(retainedIndent + content, retainedOffset)
      separator = '\n'
    } else if (line.indent.length > trimIndent || content[0] === '\t') {
      if (separator === ' ') separator = '\n'
      else if (!previousMoreIndented && separator === '\n') separator = '\n\n'
      builder.appendGenerated(separator, separatorRange.start, separatorRange.end)
      builder.appendSource(retainedIndent + content, retainedOffset)
      separator = '\n'
      previousMoreIndented = true
    } else if (content === '') {
      if (separator === '\n') builder.appendGenerated('\n', separatorRange.start, separatorRange.end)
      else separator = '\n'
    } else {
      builder.appendGenerated(separator, separatorRange.start, separatorRange.end)
      builder.appendSource(content, contentBase + line.contentOffset)
      separator = ' '
      previousMoreIndented = false
    }
    separatorRange = { start: contentBase + line.newlineStart, end: contentBase + line.newlineEnd }
  }

  if (header.chomp === '+') {
    for (let index = chompStart; index < lines.length; index += 1) {
      const line = lines[index]
      builder.appendGenerated('\n', separatorRange.start, separatorRange.end)
      builder.appendSource(line.indent.slice(trimIndent), contentBase + line.contentOffset - line.indent.length + trimIndent)
      separatorRange = { start: contentBase + line.newlineStart, end: contentBase + line.newlineEnd }
    }
    if (!builder.value().endsWith('\n')) builder.appendGenerated('\n', separatorRange.start, separatorRange.end)
  } else if (header.chomp !== '-') {
    builder.appendGenerated('\n', separatorRange.start, separatorRange.end)
  }
  return builder.result()
}

function parseBlockHeader(token: ScalarSourceToken): { mode: '|' | '>'; indent: number; chomp: string; length: number } {
  const props = token.props ?? []
  const headerSource = props[0]?.source ?? '|'
  let indent = 0
  let chomp = ''
  for (let index = 1; index < headerSource.length; index += 1) {
    const character = headerSource[index]
    if (!chomp && (character === '-' || character === '+')) chomp = character
    else if (!indent && Number(character)) indent = Number(character)
  }
  return {
    mode: headerSource[0] === '>' ? '>' : '|',
    indent,
    chomp,
    length: props.reduce((length, prop) => length + prop.source.length, 0),
  }
}

function splitBlockLines(source: string): Array<{
  indent: string
  content: string
  contentOffset: number
  newlineStart: number
  newlineEnd: number
}> {
  const lines: Array<{ indent: string; content: string; contentOffset: number; newlineStart: number; newlineEnd: number }> = []
  let offset = 0
  while (offset <= source.length) {
    const newline = source.indexOf('\n', offset)
    const lineEnd = newline < 0 ? source.length : newline
    const raw = source.slice(offset, lineEnd)
    const indent = raw.match(/^ */)?.[0] ?? ''
    lines.push({
      indent,
      content: raw.slice(indent.length),
      contentOffset: offset + indent.length,
      newlineStart: lineEnd > offset && source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd,
      newlineEnd: newline < 0 ? lineEnd : newline + 1,
    })
    if (newline < 0) break
    offset = newline + 1
  }
  return lines
}

function mappedBuilder() {
  let value = ''
  const offsets: number[] = []
  const ends: number[] = []
  return {
    appendSource(text: string, start: number) {
      value += text
      for (let index = 0; index < text.length; index += 1) {
        offsets.push(start + index)
        ends.push(start + index + 1)
      }
    },
    appendGenerated(text: string, start: number, end: number) {
      value += text
      for (let index = 0; index < text.length; index += 1) {
        offsets.push(start)
        ends.push(end)
      }
    },
    appendMapped(text: string, start: number, end: number) {
      value += text
      offsets.push(start)
      ends.push(end)
    },
    value: () => value,
    result: (): MappedText => ({ value, offsets, ends }),
  }
}

function newlineWidth(text: string): number {
  return text.endsWith('\r\n') ? 2 : 1
}

function newlineWidthAt(source: string, position: number): number {
  return source[position] === '\r' && source[position + 1] === '\n' ? 2 : 1
}

function nodeRange(node: unknown): PresetSourceRange | undefined {
  if (!node || typeof node !== 'object' || !('range' in node)) return undefined
  const range = (node as { range?: [number, number, number?] }).range
  return range ? { start: range[0], end: range[1] } : undefined
}

function formatPath(path: PresetSourcePath): string {
  return path.map((part) => typeof part === 'number' ? `[${part}]` : part).join('.')
}

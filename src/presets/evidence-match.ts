import type { ModelEvidenceProjection } from '../model-evidence'
import type {
  PresetEvidenceMatchResult,
  PresetRuntimeSnapshot,
  PresetSourceDocument,
  PresetSourcePath,
  PresetTemplateExpression,
} from './types'

export interface MatchPresetExpressionEvidenceInput {
  document: PresetSourceDocument
  expression: PresetTemplateExpression
  snapshot: PresetRuntimeSnapshot
  evidence: ModelEvidenceProjection
}

type ControlType = 'if' | 'elseif' | 'else' | '/if' | 'for' | '/for' | 'while' | '/while' | 'repeat' | '/repeat'

type TemplateLexeme =
  | { kind: 'literal', value: string }
  | { kind: 'value', expressionIndex: number }
  | { kind: 'control', control: ControlType }

type TemplateNode =
  | { kind: 'literal', value: string }
  | { kind: 'value', expressionIndex: number }
  | { kind: 'conditional', branches: TemplateNode[][] }
  | { kind: 'loop', body: TemplateNode[] }

type LinearPart =
  | { kind: 'literal', value: string }
  | { kind: 'value', expressionIndex: number }

interface LinearTemplate {
  literals: string[]
  expressions: number[]
}

interface ExpansionResult {
  variants: LinearPart[][]
  truncated: boolean
}

interface TextMatchResult {
  ranges: Array<{ start: number, end: number }>
  ambiguous: boolean
  observed?: boolean
}

const MAX_VARIANTS = 256
const MAX_LITERAL_PLACEMENTS = 256

export function matchPresetExpressionEvidence(input: MatchPresetExpressionEvidenceInput): PresetEvidenceMatchResult {
  if (input.expression.kind === 'control') return { status: 'unsupported', reason: 'control-tag' }
  const currentExpression = input.document.expressions.find((expression) => sameExpression(expression, input.expression))
  if (!currentExpression) return { status: 'stale' }
  const field = input.document.templateFields.find((candidate) => samePath(candidate.path, currentExpression.path))
  const snapshotTemplate = input.snapshot.templates.find((candidate) => samePath(candidate.path, currentExpression.path))
  if (!field || !snapshotTemplate) return { status: 'unsupported', reason: 'template-field' }
  if (field.value !== snapshotTemplate.template) return { status: 'stale' }

  const fieldExpressions = input.document.expressions.filter((expression) => samePath(expression.path, currentExpression.path))
  const expressionIndex = fieldExpressions.findIndex((expression) => sameExpression(expression, currentExpression))
  if (expressionIndex < 0) return { status: 'stale' }

  const parsed = parseTemplate(field.value)
  if (!parsed.nodes) return { status: 'ambiguous' }
  let ambiguous = false
  const matches = input.evidence.requestMessages
    .filter((message) => message.role === snapshotTemplate.role)
    .flatMap((message) => {
      const result = matchTemplateInText(parsed.nodes!, expressionIndex, message.text)
      ambiguous ||= result.ambiguous
      return result.ranges.map((range) => ({ evidenceId: message.evidenceId, range }))
    })

  if (ambiguous) return { status: 'ambiguous' }
  const unique = deduplicateMatches(matches)
  if (!unique.length) return { status: 'not-observed' }
  return unique.length === 1 ? { status: 'matched', ...unique[0]! } : { status: 'ambiguous' }
}

function matchTemplateInText(
  nodes: TemplateNode[],
  targetExpressionIndex: number,
  text: string,
): TextMatchResult {
  const expanded = expandNodes(nodes, text)
  const ranges: Array<{ start: number, end: number }> = []
  let ambiguous = expanded.truncated
  let observedWithoutTarget = false
  for (const parts of expanded.variants) {
    const linear = linearize(parts)
    const result = matchLinearTemplate(linear, targetExpressionIndex, text)
    ranges.push(...result.ranges)
    ambiguous ||= result.ambiguous
    observedWithoutTarget ||= Boolean(result.observed && !linear.expressions.includes(targetExpressionIndex))
  }
  const uniqueRanges = deduplicateRanges(ranges)
  if (uniqueRanges.length && observedWithoutTarget) ambiguous = true
  return { ranges: uniqueRanges, ambiguous }
}

function matchLinearTemplate(
  template: LinearTemplate,
  targetExpressionIndex: number,
  text: string,
): TextMatchResult {
  const enumerated = enumerateLiteralPlacements(template.literals, text)
  const targetPositions = template.expressions.flatMap((expressionIndex, index) => (
    expressionIndex === targetExpressionIndex ? [index] : []
  ))
  const results: Array<{ start: number, end: number }> = []
  let ambiguous = enumerated.truncated

  for (const placement of enumerated.placements) {
    if (!targetPositions.length) continue
    if (targetPositions.length > 1) ambiguous = true
    for (const targetPosition of targetPositions) {
      let runStart = targetPosition
      let runEnd = targetPosition
      while (runStart > 0 && template.literals[runStart] === '') runStart -= 1
      while (runEnd + 1 < template.expressions.length && template.literals[runEnd + 1] === '') runEnd += 1
      const runGapStart = placement[runStart]!.end
      const runGapEnd = placement[runEnd + 1]!.start
      const runLength = runEnd - runStart + 1
      if (runLength > 1 && runGapEnd > runGapStart) {
        ambiguous = true
        continue
      }
      results.push(runLength > 1
        ? { start: runGapStart, end: runGapStart }
        : { start: placement[targetPosition]!.end, end: placement[targetPosition + 1]!.start })
    }
  }
  return { ranges: deduplicateRanges(results), ambiguous, observed: enumerated.placements.length > 0 }
}

function parseTemplate(template: string): { nodes?: TemplateNode[] } {
  const lexemes = tokenizeTemplate(template)
  let position = 0

  const parseSequence = (stops: ReadonlySet<ControlType>): TemplateNode[] | undefined => {
    const nodes: TemplateNode[] = []
    while (position < lexemes.length) {
      const lexeme = lexemes[position]!
      if (lexeme.kind === 'literal') {
        nodes.push(lexeme)
        position += 1
        continue
      }
      if (lexeme.kind === 'value') {
        nodes.push(lexeme)
        position += 1
        continue
      }
      if (stops.has(lexeme.control)) return nodes
      if (lexeme.control === 'if') {
        position += 1
        const branches: TemplateNode[][] = []
        const first = parseSequence(new Set<ControlType>(['elseif', 'else', '/if']))
        if (!first) return
        branches.push(first)
        while (controlAt(lexemes, position) === 'elseif') {
          position += 1
          const branch = parseSequence(new Set<ControlType>(['elseif', 'else', '/if']))
          if (!branch) return
          branches.push(branch)
        }
        if (controlAt(lexemes, position) === 'else') {
          position += 1
          const branch = parseSequence(new Set<ControlType>(['/if']))
          if (!branch) return
          branches.push(branch)
        } else {
          branches.push([])
        }
        if (controlAt(lexemes, position) !== '/if') return
        position += 1
        nodes.push({ kind: 'conditional', branches })
        continue
      }
      if (lexeme.control === 'for' || lexeme.control === 'while' || lexeme.control === 'repeat') {
        const close = `/${lexeme.control}` as ControlType
        position += 1
        const body = parseSequence(new Set<ControlType>([close]))
        if (!body || controlAt(lexemes, position) !== close) return
        position += 1
        nodes.push({ kind: 'loop', body })
        continue
      }
      return
    }
    return nodes
  }

  const nodes = parseSequence(new Set())
  return nodes && position === lexemes.length ? { nodes } : {}
}

function controlAt(lexemes: TemplateLexeme[], position: number): ControlType | undefined {
  const lexeme = lexemes[position]
  return lexeme?.kind === 'control' ? lexeme.control : undefined
}

function expandNodes(nodes: TemplateNode[], text: string): ExpansionResult {
  let variants: LinearPart[][] = [[]]
  let truncated = false
  for (const node of nodes) {
    const expanded = expandNode(node, text)
    truncated ||= expanded.truncated
    const combined = combineVariants(variants, expanded.variants)
    variants = combined.variants
    truncated ||= combined.truncated
  }
  return { variants, truncated }
}

function expandNode(node: TemplateNode, text: string): ExpansionResult {
  if (node.kind === 'literal' || node.kind === 'value') return { variants: [[node]], truncated: false }
  if (node.kind === 'conditional') {
    const variants: LinearPart[][] = []
    let truncated = false
    for (const branch of node.branches) {
      const expanded = expandNodes(branch, text)
      truncated ||= expanded.truncated
      for (const variant of expanded.variants) {
        if (variants.length >= MAX_VARIANTS) {
          truncated = true
          break
        }
        variants.push(variant)
      }
    }
    return { variants, truncated }
  }

  const body = expandNodes(node.body, text)
  let truncated = body.truncated
  const minimumLiteralLength = Math.min(...body.variants.map(literalLength))
  const unboundedEmptyBody = minimumLiteralLength === 0
  const maximumRepeats = unboundedEmptyBody ? 2 : Math.floor(text.length / minimumLiteralLength)
  if (unboundedEmptyBody) truncated = true

  const variants: LinearPart[][] = [[]]
  let repeated: LinearPart[][] = [[]]
  for (let count = 1; count <= maximumRepeats; count += 1) {
    const combined = combineVariants(repeated, body.variants)
    repeated = combined.variants
    truncated ||= combined.truncated
    for (const variant of repeated) {
      if (variants.length >= MAX_VARIANTS) {
        truncated = true
        return { variants, truncated }
      }
      variants.push(variant)
    }
    if (!repeated.length) break
  }
  return { variants, truncated }
}

function combineVariants(left: LinearPart[][], right: LinearPart[][]): ExpansionResult {
  const variants: LinearPart[][] = []
  let truncated = false
  for (const prefix of left) {
    for (const suffix of right) {
      if (variants.length >= MAX_VARIANTS) {
        truncated = true
        return { variants, truncated }
      }
      variants.push([...prefix, ...suffix])
    }
  }
  return { variants, truncated }
}

function literalLength(parts: LinearPart[]): number {
  return parts.reduce((length, part) => length + (part.kind === 'literal' ? part.value.length : 0), 0)
}

function linearize(parts: LinearPart[]): LinearTemplate {
  const literals = ['']
  const expressions: number[] = []
  for (const part of parts) {
    if (part.kind === 'literal') literals[literals.length - 1] += part.value
    else {
      expressions.push(part.expressionIndex)
      literals.push('')
    }
  }
  return { literals, expressions }
}

function enumerateLiteralPlacements(
  literals: readonly string[],
  text: string,
): { placements: Array<Array<{ start: number, end: number }>>, truncated: boolean } {
  const placements: Array<Array<{ start: number, end: number }>> = []
  const placement: Array<{ start: number, end: number }> = []
  let truncated = false

  const visit = (index: number, minimum: number) => {
    if (truncated) return
    const literal = literals[index]!
    if (index === literals.length - 1 && literal === '') {
      placement[index] = { start: text.length, end: text.length }
      if (placements.length >= MAX_LITERAL_PLACEMENTS) truncated = true
      else placements.push(placement.slice())
      return
    }
    if (literal === '') {
      const offset = index === 0 ? 0 : minimum
      placement[index] = { start: offset, end: offset }
      visit(index + 1, offset)
      return
    }
    let found = text.indexOf(literal, minimum)
    while (found >= 0 && !truncated) {
      placement[index] = { start: found, end: found + literal.length }
      if (index === literals.length - 1) {
        if (placements.length >= MAX_LITERAL_PLACEMENTS) truncated = true
        else placements.push(placement.slice())
      } else {
        visit(index + 1, found + literal.length)
      }
      found = text.indexOf(literal, found + Math.max(1, literal.length))
    }
  }

  visit(0, 0)
  return { placements, truncated }
}

function tokenizeTemplate(template: string): TemplateLexeme[] {
  const lexemes: TemplateLexeme[] = []
  let literal = ''
  let position = 0
  let expressionIndex = 0
  const flushLiteral = () => {
    if (!literal) return
    lexemes.push({ kind: 'literal', value: literal })
    literal = ''
  }

  while (position < template.length) {
    if (template.startsWith('{{', position)) {
      literal += '{'
      position += 2
      continue
    }
    if (template.startsWith('}}', position)) {
      literal += '}'
      position += 2
      continue
    }
    if (template[position] !== '{') {
      literal += template[position]
      position += 1
      continue
    }
    const end = findTagEnd(template, position)
    if (end < 0) {
      literal += template.slice(position)
      break
    }
    flushLiteral()
    const content = template.slice(position + 1, end).trim()
    const control = parseControl(content)
    lexemes.push(control
      ? { kind: 'control', control }
      : { kind: 'value', expressionIndex })
    expressionIndex += 1
    position = end + 1
  }
  flushLiteral()
  return lexemes
}

function findTagEnd(value: string, start: number): number {
  let depth = 1
  let quote = ''
  for (let position = start + 1; position < value.length; position += 1) {
    const character = value[position]
    if (quote) {
      if (character === '\\') position += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return position
  }
  return -1
}

function parseControl(content: string): ControlType | undefined {
  if (/^if(?:\s|$)/.test(content)) return 'if'
  if (/^elseif(?:\s|$)/.test(content)) return 'elseif'
  if (/^else\s*$/.test(content)) return 'else'
  if (/^for(?:\s|$)/.test(content)) return 'for'
  if (/^while(?:\s|$)/.test(content)) return 'while'
  if (/^repeat(?:\s|$)/.test(content)) return 'repeat'
  const close = content.match(/^\/(if|for|while|repeat)\s*$/)?.[1]
  return close ? `/${close}` as ControlType : undefined
}

function sameExpression(left: PresetTemplateExpression, right: PresetTemplateExpression): boolean {
  return samePath(left.path, right.path)
    && left.range.start === right.range.start
    && left.range.end === right.range.end
    && left.content === right.content
    && left.occurrence === right.occurrence
}

function samePath(left: PresetSourcePath, right: PresetSourcePath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function deduplicateMatches<T extends { evidenceId: string, range: { start: number, end: number } }>(matches: T[]): T[] {
  return matches.filter((match, index) => matches.findIndex((candidate) => candidate.evidenceId === match.evidenceId
    && candidate.range.start === match.range.start && candidate.range.end === match.range.end) === index)
}

function deduplicateRanges(ranges: Array<{ start: number, end: number }>): Array<{ start: number, end: number }> {
  return ranges.filter((range, index) => ranges.findIndex((candidate) => candidate.start === range.start && candidate.end === range.end) === index)
}

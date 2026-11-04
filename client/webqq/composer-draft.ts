export interface ComposerMentionToken { type: 'mention', id: string, name: string }
export interface ComposerTextToken { type: 'text', text: string }
export type ComposerDraftToken = ComposerTextToken | ComposerMentionToken
export interface ComposerDraft { tokens: ComposerDraftToken[], tokenIndex: number, offset: number }
export interface MentionCandidate { id: string, name: string, avatar?: string, kind: 'user' | 'bot', keywords?: string[] }

export function createEmptyComposerDraft(): ComposerDraft { return { tokens: [{ type: 'text', text: '' }], tokenIndex: 0, offset: 0 } }
export function draftText(tokens: readonly ComposerDraftToken[]): string { return tokens.map((token) => token.type === 'text' ? token.text : `@${token.name}`).join('') }
export function isComposerDraftEmpty(tokens: readonly ComposerDraftToken[]): boolean { return !tokens.some((token) => token.type === 'mention' || !!token.text.trim()) }
export function serializeComposerDraft(tokens: readonly ComposerDraftToken[]): string { return tokens.map((token) => token.type === 'mention' ? `<at id="${token.id}"/>` : token.text.replace(/ /g, ' ')).join('').trim() }

export function normalizeComposerTokens(tokens: readonly ComposerDraftToken[]): ComposerDraftToken[] {
  const normalized: ComposerDraftToken[] = []
  for (const token of tokens) {
    if (token.type === 'mention') normalized.push({ ...token })
    else {
      const text = token.text.replace(/​/g, '')
      const previous = normalized.at(-1)
      if (previous?.type === 'text') previous.text += text
      else normalized.push({ type: 'text', text })
    }
  }
  if (!normalized.length) return [{ type: 'text', text: '' }]
  const withCarets: ComposerDraftToken[] = []
  normalized.forEach((token, index) => { withCarets.push(token); if (token.type === 'mention' && (!normalized[index + 1] || normalized[index + 1].type === 'mention')) withCarets.push({ type: 'text', text: '' }) })
  if (withCarets[0]?.type === 'mention') withCarets.unshift({ type: 'text', text: '' })
  return withCarets
}

function clampTextCaret(tokens: readonly ComposerDraftToken[], tokenIndex: number, offset: number): ComposerDraft {
  let index = Math.min(Math.max(tokenIndex, 0), Math.max(0, tokens.length - 1))
  if (tokens[index]?.type !== 'text') index = tokens.findIndex((token) => token.type === 'text')
  if (index < 0) return createEmptyComposerDraft()
  const token = tokens[index]
  const text = token?.type === 'text' ? token.text : ''
  return { tokens: [...tokens], tokenIndex: index, offset: Math.min(Math.max(offset, 0), text.length) }
}

export function insertComposerMention(tokens: readonly ComposerDraftToken[], tokenIndex: number, offset: number, mention: Omit<ComposerMentionToken, 'type'>): ComposerDraft { return replaceComposerTextRange(tokens, tokenIndex, offset, offset, mention) }
export function replaceComposerTextRange(tokens: readonly ComposerDraftToken[], tokenIndex: number, start: number, end: number, mention: Omit<ComposerMentionToken, 'type'>): ComposerDraft {
  const source = tokens[tokenIndex]?.type === 'text' ? tokens[tokenIndex].text : ''
  const from = Math.max(0, Math.min(start, end, source.length)), to = Math.max(from, Math.min(Math.max(start, end), source.length))
  let before = source.slice(0, from)
  const rawAfter = source.slice(to)
  if (before && !/\s$/.test(before)) before += ' '
  const after = rawAfter ? (rawAfter.startsWith(' ') ? rawAfter : ` ${rawAfter}`) : ' '
  const next = normalizeComposerTokens([...tokens.slice(0, tokenIndex), ...(before ? [{ type: 'text' as const, text: before }] : []), { type: 'mention' as const, id: mention.id, name: mention.name }, { type: 'text' as const, text: after }, ...tokens.slice(tokenIndex + 1)])
  const mentionIndex = next.findIndex((token, index) => index >= tokenIndex && token.type === 'mention' && token.id === mention.id)
  const caretIndex = mentionIndex + 1
  const caretToken = next[caretIndex]
  // 光标越过自动补入的后置空格，继续输入才能得到“@用户 内容”，而不是“@用户内容 ”。
  const caretOffset = caretToken?.type === 'text' && /^[  ]/.test(caretToken.text) ? 1 : 0
  return clampTextCaret(next, caretIndex, caretOffset)
}

export function deleteComposerBackward(tokens: readonly ComposerDraftToken[], tokenIndex: number, offset: number): ComposerDraft {
  const caret = clampTextCaret(normalizeComposerTokens(tokens), tokenIndex, offset), current = caret.tokens[caret.tokenIndex]
  const previous = caret.tokens[caret.tokenIndex - 1]
  if (current?.type === 'text' && caret.offset === 1 && current.text.startsWith(' ') && previous?.type === 'mention') {
    return clampTextCaret(normalizeComposerTokens([
      ...caret.tokens.slice(0, caret.tokenIndex - 1),
      { type: 'text', text: current.text.slice(1) },
      ...caret.tokens.slice(caret.tokenIndex + 1),
    ]), caret.tokenIndex - 1, Number.MAX_SAFE_INTEGER)
  }
  if (current?.type === 'text' && caret.offset > 0) return clampTextCaret(normalizeComposerTokens([...caret.tokens.slice(0, caret.tokenIndex), { type: 'text', text: current.text.slice(0, caret.offset - 1) + current.text.slice(caret.offset) }, ...caret.tokens.slice(caret.tokenIndex + 1)]), caret.tokenIndex, caret.offset - 1)
  if (caret.tokenIndex <= 0) return caret
  if (previous?.type === 'mention') return clampTextCaret(normalizeComposerTokens([...caret.tokens.slice(0, caret.tokenIndex - 1), ...caret.tokens.slice(caret.tokenIndex)]), caret.tokenIndex - 1, Number.MAX_SAFE_INTEGER)
  return caret
}

export function detectMentionTrigger(text: string, caretOffset: number): { query: string, start: number } | null {
  const prefix = text.slice(0, caretOffset)
  const match = /(^|[^\s@])?@([^\s@]*)$/.exec(prefix)
  return match ? { query: match[2], start: caretOffset - match[2].length - 1 } : null
}
function candidateSearchTexts(candidate: MentionCandidate) { return [candidate.name, candidate.id, ...(candidate.keywords ?? [])] }
export function filterMentionCandidates(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const normalized = query.trim().toLocaleLowerCase()
  return [...candidates].filter((candidate) => !normalized || candidateSearchTexts(candidate).some((text) => text.toLocaleLowerCase().includes(normalized))).sort((a, b) => { const ap = candidateSearchTexts(a).some((text) => text.toLocaleLowerCase().startsWith(normalized)), bp = candidateSearchTexts(b).some((text) => text.toLocaleLowerCase().startsWith(normalized)); return Number(bp) - Number(ap) || a.name.localeCompare(b.name, 'zh-Hans') || a.id.localeCompare(b.id) })
}

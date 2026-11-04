import { describe, expect, it } from 'vitest'
import {
  createEmptyComposerDraft,
  deleteComposerBackward,
  detectMentionTrigger,
  draftText,
  filterMentionCandidates,
  insertComposerMention,
  isComposerDraftEmpty,
  replaceComposerTextRange,
  serializeComposerDraft,
  type ComposerDraftToken,
} from '../client/webqq/composer-draft'

describe('WebQQ 内联提及草稿', () => {
  it('按光标位置插入提及并保持前后文字顺序', () => {
    const draft = insertComposerMention(
      [{ type: 'text', text: '你好 在吗' }],
      0,
      3,
      { id: '10002', name: '测试用户2' },
    )

    expect(draft.tokens).toEqual([
      { type: 'text', text: '你好 ' },
      { type: 'mention', id: '10002', name: '测试用户2' },
      { type: 'text', text: ' 在吗' },
    ])
    expect(draftText(draft.tokens)).toBe('你好 @测试用户2 在吗')
    expect(serializeComposerDraft(draft.tokens)).toBe('你好 <at id="10002"/> 在吗')
    expect(draft.offset).toBe(1)
  })

  it('序列化连续提及并判断空草稿', () => {
    const tokens: ComposerDraftToken[] = [
      { type: 'mention', id: '10002', name: '测试用户2' },
      { type: 'text', text: ' ' },
      { type: 'mention', id: '20001', name: 'Koishi' },
    ]

    expect(serializeComposerDraft(tokens)).toBe('<at id="10002"/> <at id="20001"/>')
    expect(isComposerDraftEmpty(createEmptyComposerDraft().tokens)).toBe(true)
    expect(isComposerDraftEmpty([{ type: 'text', text: '  ' }])).toBe(true)
    expect(isComposerDraftEmpty(tokens)).toBe(false)
  })

  it('在任意正文位置检测 @ 查询', () => {
    expect(detectMentionTrigger('@测', 2)).toEqual({ query: '测', start: 0 })
    expect(detectMentionTrigger('你好 @100', 7)).toEqual({ query: '100', start: 3 })
    expect(detectMentionTrigger('123@', 4)).toEqual({ query: '', start: 3 })
    expect(detectMentionTrigger('mail@example', 12)).toEqual({ query: 'example', start: 4 })
    expect(detectMentionTrigger('你好 @测试 用户', 8)).toBeNull()
  })

  it('按名称、ID 与 keywords 过滤候选并优先前缀匹配', () => {
    const candidates = [
      { id: '10002', name: '管理员小王', kind: 'user' as const },
      { id: '20001', name: 'Koishi', kind: 'bot' as const },
      { id: '10003', name: '测试用户', kind: 'user' as const, keywords: ['真实昵称'] },
    ]

    expect(filterMentionCandidates(candidates, '测试').map(({ id }) => id)).toEqual(['10003'])
    expect(filterMentionCandidates(candidates, '200').map(({ id }) => id)).toEqual(['20001'])
    expect(filterMentionCandidates(candidates, '真实').map(({ id }) => id)).toEqual(['10003'])
    expect(filterMentionCandidates(candidates, '').map(({ id }) => id)).toHaveLength(3)
  })

  it('选择候选时替换 @query，并支持退格删除原子 mention', () => {
    const replaced = replaceComposerTextRange(
      [{ type: 'text', text: '你好 @测' }],
      0,
      3,
      5,
      { id: '10003', name: '测试用户' },
    )
    expect(serializeComposerDraft(replaced.tokens)).toBe('你好 <at id="10003"/>')
    expect(draftText(replaced.tokens)).toBe('你好 @测试用户 ')
    expect(replaced.offset).toBe(1)

    const deleted = deleteComposerBackward(replaced.tokens, replaced.tokenIndex, replaced.offset)
    expect(serializeComposerDraft(deleted.tokens)).toBe('你好')
  })
})

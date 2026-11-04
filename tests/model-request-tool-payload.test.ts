import { describe, expect, it } from 'vitest'

import { resolveModelRequestToolPayload } from '../client/model-request/tool-payload'

/**
 * 工具载荷的展示形态判定。
 *
 * 这条判定决定一段工具参数或工具结果是进 JSON 查看器还是按原文铺开，两种形态的差别很大：
 * 一次搜索返回的三千字符 JSON 按原文显示时挤成一行且换行仍停在 `\n` 转义上，只能逐字读。
 * 反过来把纯文本或被截断的参数硬塞进结构树，只会画出一棵空树，把「这段载荷不是结构化的」
 * 这条事实藏起来。
 */
describe('工具载荷展示形态', () => {
  it('对象与数组交给结构视图', () => {
    expect(resolveModelRequestToolPayload('{"query":"吉祥三宝","results":[]}')).toEqual({
      kind: 'json',
      value: { query: '吉祥三宝', results: [] },
    })
    expect(resolveModelRequestToolPayload('[{"url":"https://example.com"}]')).toEqual({
      kind: 'json',
      value: [{ url: 'https://example.com' }],
    })
  })

  it('两侧留白不影响判定', () => {
    expect(resolveModelRequestToolPayload('\n  {"a":1}  \n')).toEqual({ kind: 'json', value: { a: 1 } })
  })

  it('纯文本按原文显示', () => {
    expect(resolveModelRequestToolPayload('维基百科：吉祥三宝是一首蒙古语歌曲')).toEqual({ kind: 'text' })
  })

  it('缺失与空白按原文显示', () => {
    expect(resolveModelRequestToolPayload(undefined)).toEqual({ kind: 'text' })
    expect(resolveModelRequestToolPayload('')).toEqual({ kind: 'text' })
    expect(resolveModelRequestToolPayload('   \n ')).toEqual({ kind: 'text' })
  })

  it('标量 JSON 按原文显示', () => {
    // JSON.parse 同样接受这三种，但把它们摆成单节点的树只是给纯文本套一层括号。
    expect(resolveModelRequestToolPayload('"一段文本"')).toEqual({ kind: 'text' })
    expect(resolveModelRequestToolPayload('123')).toEqual({ kind: 'text' })
    expect(resolveModelRequestToolPayload('true')).toEqual({ kind: 'text' })
    expect(resolveModelRequestToolPayload('null')).toEqual({ kind: 'text' })
  })

  it('截断的结构按原文显示', () => {
    // 流式吐出的工具参数可能停在中途；退回原文才能看出它不完整。
    expect(resolveModelRequestToolPayload('{"query":"吉祥三')).toEqual({ kind: 'text' })
    expect(resolveModelRequestToolPayload('[{"url":')).toEqual({ kind: 'text' })
  })

  it('看似结构其实无法解析的载荷按原文显示', () => {
    expect(resolveModelRequestToolPayload("{query: '吉祥三宝'}")).toEqual({ kind: 'text' })
  })

  it('搜索命中时退回原文', () => {
    // 命中高亮由正文那棵 pre 画出来；结构视图里没有它，命中的卡片必须退回原文。
    expect(resolveModelRequestToolPayload('{"query":"吉祥三宝"}', { revealText: true })).toEqual({ kind: 'text' })
  })

  it('未命中搜索时仍按结构显示', () => {
    expect(resolveModelRequestToolPayload('{"query":"吉祥三宝"}', { revealText: false })).toEqual({
      kind: 'json',
      value: { query: '吉祥三宝' },
    })
  })
})

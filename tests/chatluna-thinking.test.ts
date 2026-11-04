import { describe, expect, it } from 'vitest'
import { parseThinkContent, readChatLunaResponseText } from '../src/chatluna/thinking'

describe('ChatLuna 思考内容解析', () => {
  it('从多个 think 标签中按顺序取出思考内容', () => {
    expect(parseThinkContent('前<think>第一段</think>中<think>第二段</think>后')).toBe('第一段\n\n第二段')
  })

  it('没有 think 标签时返回空字符串', () => {
    expect(parseThinkContent('只是普通回复')).toBe('')
  })

  it('回复已被清理时继续从完整快照中读取思考内容', () => {
    const text = readChatLunaResponseText({
      lastResponseMessage: { content: '这是已经清理后的回复' },
      completionMessages: [{
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'AIMessage'],
        kwargs: { content: '前文<think>\n从完整快照读取\n</think>后文' },
      }],
    })

    expect(parseThinkContent(text)).toBe('从完整快照读取')
  })

  it('所有候选都没有思考内容时回退到第一个非空文本', () => {
    expect(readChatLunaResponseText({
      lastResponseMessage: { content: '普通回复' },
      completionMessages: [],
    })).toBe('普通回复')
  })

  it('展开 Koishi 元素树形状的回复', () => {
    expect(parseThinkContent(readChatLunaResponseText({
      lastResponseMessage: {
        children: [
          { type: 'text', attrs: { content: '<think>元素树思考</think>' } },
          { type: 'text', attrs: { content: '正文' } },
        ],
      },
    }))).toBe('元素树思考')
  })
})

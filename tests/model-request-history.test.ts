import { describe, expect, it } from 'vitest'
import {
  isHistoryVariableName,
  parseModelRequestHistory,
} from '../client/model-request/history'

describe('模型请求历史消息预览', () => {
  it('解析连续消息及严格元数据，并解码 XML 实体', () => {
    const result = parseModelRequestHistory([
      "<message name='Alice' id='10001' messageId='msg-1' timestamp='8/20/2026, 10:00:00 GMT+8'>你好 &amp; 欢迎</message>",
      "<message name='Bot' id='20002' timestamp='8/20/2026, 10:00:02 GMT+8'>收到</message>",
    ].join(''))

    expect(result).toEqual([
      {
        name: 'Alice',
        id: '10001',
        messageId: 'msg-1',
        timestamp: '8/20/2026, 10:00:00 GMT+8',
        content: '你好 & 欢迎',
        quote: undefined,
      },
      {
        name: 'Bot',
        id: '20002',
        messageId: undefined,
        timestamp: '8/20/2026, 10:00:02 GMT+8',
        content: '收到',
        quote: undefined,
      },
    ])
  })

  it('递归解析 quote 属性里的完整消息', () => {
    const value = "<message name='Bob' id='2' timestamp='now' quote=\"&lt;message name='Alice' id='1' timestamp='before'&gt;原消息 &amp;amp; 内容&lt;/message&gt;\">回复内容</message>"

    expect(parseModelRequestHistory(value)).toEqual([{
      name: 'Bob',
      id: '2',
      messageId: undefined,
      timestamp: 'now',
      content: '回复内容',
      quote: {
        name: 'Alice',
        id: '1',
        messageId: undefined,
        timestamp: 'before',
        content: '原消息 & 内容',
        quote: undefined,
      },
    }])
  })

  it('将消息内容中的结构化元素转换成易读摘要', () => {
    const value = "<message name='Alice' id='1'>看 <at name='Bob'>2</at><image>https://example.test/a.png</image><face name='微笑'>14</face><file name='报告.pdf'>https://example.test/a.pdf</file></message>"

    expect(parseModelRequestHistory(value)?.[0].content).toBe('看 @Bob[图片]微笑[文件: 报告.pdf]')
  })

  it.each([
    ['普通文本', 'plain text'],
    ['非消息根节点', '<item>内容</item>'],
    ['消息之外有正文', 'prefix<message>内容</message>'],
    ['不完整 XML', '<message name="Alice">内容'],
    ['错误引用', '<message quote="not xml">内容</message>'],
  ])('拒绝%s并允许调用方退回原文', (_label, value) => {
    expect(parseModelRequestHistory(value)).toBeUndefined()
  })

  it('只为 history_new 与 history_last 启用预览', () => {
    expect(isHistoryVariableName('history_new')).toBe(true)
    expect(isHistoryVariableName(' history_last ')).toBe(true)
    expect(isHistoryVariableName('history')).toBe(false)
    expect(isHistoryVariableName('latest_message()')).toBe(false)
  })
})

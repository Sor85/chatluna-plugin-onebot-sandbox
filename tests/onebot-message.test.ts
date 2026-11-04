import { h } from '@satorijs/core'
import { describe, expect, it } from 'vitest'
import { parseKoishiOutboundMessage, parseOneBotOutboundMessage } from '../src/onebot-message'

describe('OneBot 出站消息解析', () => {
  it('保留数组消息中的引用、文本和图片来源', () => {
    const result = parseOneBotOutboundMessage([
      { type: 'reply', data: { id: '1234' } },
      { type: 'text', data: { text: '引用图片' } },
      { type: 'image', data: { file: 'base64://aW1hZ2U=', name: 'reply.png' } },
    ])

    expect(result).toEqual({
      content: '引用图片',
      replyToRawId: '1234',
      mediaSources: [{ type: 'image', source: 'base64://aW1hZ2U=', fileName: 'reply.png' }],
    })
  })

  it('解析有限 CQ 段并保留未知段的完整属性', () => {
    const result = parseOneBotOutboundMessage('前缀[CQ:reply,id=1234][CQ:image,file=data:image/png;base64&#44;aW1hZ2U=][CQ:face,id=14]')

    expect(result).toEqual({
      content: '前缀[CQ:face,id=14]',
      replyToRawId: '1234',
      mediaSources: [{ type: 'image', source: 'data:image/png;base64,aW1hZ2U=' }],
    })
  })

  it('从 Koishi 元素中提取引用与图片而不把标签写成文本', () => {
    const result = parseKoishiOutboundMessage([
      h('quote', { id: 'abcd1234' }),
      h.image('data:image/png;base64,aW1hZ2U='),
      h.text('标准消息'),
    ])

    expect(result).toEqual({
      content: '标准消息',
      replyToRawId: 'abcd1234',
      mediaSources: [{ type: 'image', source: 'data:image/png;base64,aW1hZ2U=' }],
    })
  })

  it('将远程 sticker 解析为图片媒体', () => {
    expect(parseKoishiOutboundMessage(h('sticker', {
      url: 'http://192.168.5.3:3426/调皮',
    }))).toEqual({
      content: '',
      mediaSources: [{ type: 'image', source: 'http://192.168.5.3:3426/调皮' }],
    })
  })
})

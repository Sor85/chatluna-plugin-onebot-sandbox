import { describe, expect, it } from 'vitest'
import { readCachedMedia, rememberMedia } from '../client/workspace/media-cache'

describe('媒体页面级缓存', () => {
  it('头像长期保留，消息媒体按最近使用淘汰，命中会刷新顺序', () => {
    rememberMedia('avatar', 'data:avatar', true)
    rememberMedia('first', 'data:first', false)
    for (let index = 0; index < 63; index++) rememberMedia(`filler-${index}`, 'data:filler', false)
    // 此时消息媒体正好 64 张；读一次 first，它变成最近使用，下一张挤掉的是 filler-0。
    expect(readCachedMedia('first')).toBe('data:first')
    rememberMedia('overflow', 'data:overflow', false)
    expect(readCachedMedia('filler-0')).toBeUndefined()
    expect(readCachedMedia('first')).toBe('data:first')
    for (let index = 0; index < 100; index++) rememberMedia(`flood-${index}`, 'data:flood', false)
    expect(readCachedMedia('first')).toBeUndefined()
    expect(readCachedMedia('avatar')).toBe('data:avatar')
  })

  it('同一份内容既是头像又出现在消息里时按头像保留', () => {
    rememberMedia('shared', 'data:shared', false)
    rememberMedia('shared', 'data:shared', true)
    for (let index = 0; index < 100; index++) rememberMedia(`other-${index}`, 'data:other', false)
    expect(readCachedMedia('shared')).toBe('data:shared')
  })
})

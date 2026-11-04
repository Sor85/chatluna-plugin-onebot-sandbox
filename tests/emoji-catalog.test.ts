import { describe, expect, it } from 'vitest'
import {
  getCommonSandboxEmojiFaces,
  getSandboxEmojiFace,
  loadRecentSandboxEmojiIds,
  rememberSandboxEmojiId,
  searchSandboxEmojiFaces,
} from '../client/webqq/emoji-catalog'

describe('本地表情目录', () => {
  it('提供完整目录、常用区和搜索', () => {
    const faces = searchSandboxEmojiFaces('')
    expect(faces.length).toBeGreaterThan(100)
    expect(getSandboxEmojiFace('76')).toMatchObject({ id: '76', label: '赞' })
    expect(getCommonSandboxEmojiFaces().some(({ id }) => id === '76')).toBe(true)
    expect(searchSandboxEmojiFaces('赞').some(({ id }) => id === '76')).toBe(true)
    expect(searchSandboxEmojiFaces('zan').some(({ id }) => id === '76')).toBe(true)
  })

  it('记住最近使用的表情到本地常用区', () => {
    const storage = new Map<string, string>()
    const api = {
      getItem(key: string) {
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
    }
    expect(loadRecentSandboxEmojiIds(api)).toEqual([])
    expect(rememberSandboxEmojiId('76', api)).toEqual(['76'])
    expect(rememberSandboxEmojiId('66', api)).toEqual(['66', '76'])
    expect(loadRecentSandboxEmojiIds(api)).toEqual(['66', '76'])
  })
})

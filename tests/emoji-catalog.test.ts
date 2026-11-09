import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCommonSandboxEmojiFaces,
  getSandboxEmojiFace,
  loadRecentSandboxEmojiIds,
  rememberSandboxEmojiId,
  searchSandboxEmojiFaces,
} from '../client/webqq/emoji-catalog'

const storage = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@chatluna/ui-storage', () => ({
  readStored: (key: string) => storage.get(key),
  writeStored: (key: string, value: unknown) => storage.set(key, value),
}))
beforeEach(() => storage.clear())

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
    expect(loadRecentSandboxEmojiIds()).toEqual([])
    expect(rememberSandboxEmojiId('76')).toEqual(['76'])
    expect(rememberSandboxEmojiId('66')).toEqual(['66', '76'])
    expect(loadRecentSandboxEmojiIds()).toEqual(['66', '76'])
    expect(storage.get('chatluna.onebot-sandbox.recent-emoji-ids')).toEqual(['66', '76'])
  })
})

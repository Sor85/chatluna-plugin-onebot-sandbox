import { describe, expect, it } from 'vitest'
import type { SandboxSnapshot } from '../src/types'
import {
  applyThumbnailAvatars,
  collectAvatarMediaIds,
  mediaSourcesFromCache,
  resolveThumbnailAvatar,
  thumbnailMediaCacheKey,
} from '../client/test-space/thumbnail-media'

const mediaId = 'a'.repeat(32)

function snapshot(avatar: string): SandboxSnapshot {
  return {
    revision: 1,
    participants: [{ id: '20001', name: 'Koishi', kind: 'bot', avatar }],
    groups: [{ id: '30001', name: '测试群', avatar, members: [], announcements: [] }],
    conversations: [],
    messages: [],
    friendships: [],
    requests: [],
  } as unknown as SandboxSnapshot
}

describe('空间缩略图头像解析', () => {
  it('未命中缓存时不把 sandbox-media 引用交给 <img>，命中时换成 data URL', () => {
    expect(resolveThumbnailAvatar(`sandbox-media://${mediaId}`, {})).toBe('')
    expect(resolveThumbnailAvatar(`sandbox-media://${mediaId}`, { [mediaId]: 'data:image/png;base64,new' })).toBe('data:image/png;base64,new')
    expect(resolveThumbnailAvatar('https://example.com/a.png', {})).toBe('https://example.com/a.png')
    expect(resolveThumbnailAvatar(undefined, {})).toBe('')
  })

  it('快照轮询时用缓存同步替换引用，避免先闪回字母头像', () => {
    const cache = { [thumbnailMediaCacheKey(undefined, mediaId)]: 'data:image/png;base64,cached' }
    const ids = collectAvatarMediaIds(snapshot(`sandbox-media://${mediaId}`))
    expect(ids).toEqual([mediaId])
    const resolved = applyThumbnailAvatars(
      snapshot(`sandbox-media://${mediaId}`),
      mediaSourcesFromCache(ids, cache),
    )
    expect(resolved.participants[0]?.avatar).toBe('data:image/png;base64,cached')
    expect(resolved.groups[0]?.avatar).toBe('data:image/png;base64,cached')
  })
})

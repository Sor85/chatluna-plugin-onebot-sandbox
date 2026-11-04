import type { SandboxSnapshot } from '../../src/types'

const MEDIA_REF = /^sandbox-media:\/\/([a-f0-9]{32})$/

export function thumbnailMediaCacheKey(spaceId: string | undefined, mediaId: string) {
  return `${spaceId ?? 'main'}:${mediaId}`
}

export function collectAvatarMediaIds(snapshot: Pick<SandboxSnapshot, 'participants' | 'groups'>) {
  return [...new Set(
    [...snapshot.participants.map(({ avatar }) => avatar), ...snapshot.groups.map(({ avatar }) => avatar)]
      .flatMap((reference) => reference?.match(MEDIA_REF)?.[1] ?? []),
  )]
}

/**
 * 未命中媒体时交出空串而不是原引用：`sandbox-media://` 不是浏览器能取的 URL，
 * 交给 `<img>` 只会得到一个碎图，交出空串才会退回字母头像。
 */
export function resolveThumbnailAvatar(reference: string | undefined, mediaSources: Record<string, string>) {
  const id = reference?.match(MEDIA_REF)?.[1]
  if (!id) return reference ?? ''
  return mediaSources[id] ?? ''
}

export function mediaSourcesFromCache(
  mediaIds: readonly string[],
  cache: Readonly<Record<string, string>>,
  spaceId?: string,
) {
  return Object.fromEntries(mediaIds.flatMap((id) => {
    const cached = cache[thumbnailMediaCacheKey(spaceId, id)]
    return cached ? [[id, cached]] : []
  }))
}

export function applyThumbnailAvatars(
  snapshot: SandboxSnapshot,
  mediaSources: Record<string, string>,
): SandboxSnapshot {
  return {
    ...snapshot,
    participants: snapshot.participants.map((participant) => ({
      ...participant,
      avatar: resolveThumbnailAvatar(participant.avatar, mediaSources),
    })),
    groups: snapshot.groups.map((group) => ({
      ...group,
      avatar: resolveThumbnailAvatar(group.avatar, mediaSources),
    })),
  }
}

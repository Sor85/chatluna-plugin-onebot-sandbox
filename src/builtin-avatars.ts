import {
  BUILTIN_AVATARS,
  BUILTIN_BOT_AVATARS,
  BUILTIN_GROUP_AVATARS,
  BUILTIN_USER_AVATARS,
  type BuiltinAvatar,
  type BuiltinAvatarKind,
} from './builtin-avatar-png'

export {
  BUILTIN_AVATARS,
  BUILTIN_BOT_AVATARS,
  BUILTIN_GROUP_AVATARS,
  BUILTIN_USER_AVATARS,
  type BuiltinAvatar,
  type BuiltinAvatarKind,
}

export function findBuiltinAvatarByReference(reference: string): BuiltinAvatar | undefined {
  for (const pool of Object.values(BUILTIN_AVATARS)) {
    const avatar = pool.find((candidate) => candidate.reference === reference)
    if (avatar) return avatar
  }
}

export function pickUnusedBuiltinAvatar<T>(pool: readonly T[], used: ReadonlySet<T>, random = Math.random): T {
  if (!pool.length) throw new Error('内置头像池不能为空')
  const available = pool.filter((item) => !used.has(item))
  const candidates = available.length ? available : pool
  const value = random()
  const index = Math.min(Math.max(Math.floor(value * candidates.length), 0), candidates.length - 1)
  return candidates[index]!
}

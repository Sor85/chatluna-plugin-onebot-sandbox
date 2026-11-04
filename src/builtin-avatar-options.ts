export type BuiltinAvatarKind = 'user' | 'bot' | 'group'

export interface BuiltinAvatar {
  id: string
  kind: BuiltinAvatarKind
  svg: string
}

function createAvatar(kind: BuiltinAvatarKind, id: string, background: string, body: string) {
  return {
    id,
    kind,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="32" fill="${background}"/>${body}</svg>`,
  }
}

function user(id: string, background: string, foreground: string, headY: number, headRadius: number) {
  return createAvatar('user', id, background, `<circle cx="64" cy="64" r="44" fill="${foreground}" opacity=".18"/><circle cx="64" cy="${headY}" r="${headRadius}" fill="${foreground}"/><path d="M28 108c5-24 18-36 36-36s31 12 36 36" fill="${foreground}"/>`)
}

function bot(id: string, background: string, foreground: string, eye: string, antenna: string) {
  return createAvatar('bot', id, background, `<path d="${antenna}" stroke="${foreground}" stroke-width="7" stroke-linecap="round"/><rect x="24" y="32" width="80" height="68" rx="22" fill="${foreground}"/><circle cx="49" cy="62" r="8" fill="${eye}"/><circle cx="79" cy="62" r="8" fill="${eye}"/><path d="M45 82h38" stroke="${eye}" stroke-width="7" stroke-linecap="round"/>`)
}

function group(id: string, background: string, foreground: string, accent: string, variant: number) {
  const offset = variant % 3 * 2
  return createAvatar('group', id, background, `<circle cx="46" cy="50" r="16" fill="${foreground}"/><circle cx="82" cy="50" r="16" fill="${accent}"/><circle cx="64" cy="42" r="18" fill="${foreground}"/><path d="M17 105c3-20 14-30 29-30 8 0 14 2 18 7 4-5 10-7 18-7 15 0 26 10 29 30" fill="${accent}"/><path d="M33 ${108 - offset}c4-25 15-37 31-37s27 12 31 37" fill="${foreground}"/>`)
}

export const BUILTIN_USER_AVATARS: readonly BuiltinAvatar[] = [
  user('sunny', '#f59e0b', '#fff7ed', 54, 20),
  user('mint', '#10b981', '#ecfdf5', 50, 19),
  user('ocean', '#0ea5e9', '#f0f9ff', 52, 20),
  user('violet', '#8b5cf6', '#f5f3ff', 51, 19),
  user('rose', '#f43f5e', '#fff1f2', 53, 20),
  user('slate', '#475569', '#f8fafc', 50, 18),
  user('coral', '#f97316', '#fff7ed', 52, 19),
  user('indigo', '#4f46e5', '#eef2ff', 51, 20),
]

export const BUILTIN_BOT_AVATARS: readonly BuiltinAvatar[] = [
  bot('cobalt', '#1d4ed8', '#dbeafe', '#1e3a8a', 'M64 32V18M64 18l10-8'),
  bot('cyan', '#0891b2', '#cffafe', '#155e75', 'M64 32V16M55 12h18'),
  bot('emerald', '#059669', '#d1fae5', '#065f46', 'M64 32V17M64 17l-9-7'),
  bot('amber', '#d97706', '#fef3c7', '#92400e', 'M64 32V15M64 15h12'),
  bot('magenta', '#c026d3', '#fae8ff', '#86198f', 'M64 32V18M54 12l10 6'),
  bot('crimson', '#dc2626', '#fee2e2', '#991b1b', 'M64 32V16M58 10h12'),
  bot('navy', '#334155', '#e2e8f0', '#0f172a', 'M64 32V17M64 17l8-7'),
  bot('lime', '#65a30d', '#ecfccb', '#3f6212', 'M64 32V16M54 9l10 7'),
]

export const BUILTIN_GROUP_AVATARS: readonly BuiltinAvatar[] = [
  group('harbor', '#0f766e', '#ccfbf1', '#5eead4', 0),
  group('sky', '#0369a1', '#e0f2fe', '#7dd3fc', 1),
  group('grape', '#7e22ce', '#f3e8ff', '#d8b4fe', 2),
  group('cherry', '#be123c', '#ffe4e6', '#fda4af', 3),
  group('forest', '#15803d', '#dcfce7', '#86efac', 4),
  group('sunset', '#c2410c', '#ffedd5', '#fdba74', 5),
  group('night', '#3730a3', '#e0e7ff', '#a5b4fc', 6),
  group('stone', '#44403c', '#f5f5f4', '#d6d3d1', 7),
]

export const BUILTIN_AVATARS: Readonly<Record<BuiltinAvatarKind, readonly BuiltinAvatar[]>> = {
  user: BUILTIN_USER_AVATARS,
  bot: BUILTIN_BOT_AVATARS,
  group: BUILTIN_GROUP_AVATARS,
}

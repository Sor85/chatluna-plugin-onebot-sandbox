import type { SandboxGroupMember } from '../../src/types'

export function getGroupMemberDisplayName(member: Pick<SandboxGroupMember, 'card'> | undefined, participantName: string) {
  return member?.card?.trim() || participantName
}

// 与真实 QQ 一致：专属头衔占用群身份徽标的位置并覆盖身份文案，
// 但徽标配色仍跟随群身份，普通成员才使用独立的头衔配色。
export function getGroupAuthorityBadge(member: Pick<SandboxGroupMember, 'role' | 'title'> | undefined) {
  if (!member) return
  const title = member.title?.trim()
  if (member.role === 'owner') return { text: title || '群主', kind: 'owner' as const }
  if (member.role === 'admin') return { text: title || '管理员', kind: 'admin' as const }
  return title ? { text: title, kind: 'title' as const } : undefined
}

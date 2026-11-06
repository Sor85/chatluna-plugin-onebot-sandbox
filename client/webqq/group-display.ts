import type { SandboxGroupMember } from '../../src/types'

export function getGroupMemberDisplayName(member: Pick<SandboxGroupMember, 'card'> | undefined, participantName: string) {
  return member?.card?.trim() || participantName
}

export type GroupAuthorityBadge =
  | { readonly kind: 'owner' | 'admin', readonly title?: string }
  | { readonly kind: 'title', readonly title: string }

// 与真实 QQ 一致：专属头衔占用群身份徽标的位置并覆盖身份文案，
// 但徽标配色仍跟随群身份，普通成员才使用独立的头衔配色。没有头衔时由界面按身份显示文案。
export function getGroupAuthorityBadge(member: Pick<SandboxGroupMember, 'role' | 'title'> | undefined): GroupAuthorityBadge | undefined {
  if (!member) return
  const title = member.title?.trim() || undefined
  if (member.role === 'owner' || member.role === 'admin') return title ? { kind: member.role, title } : { kind: member.role }
  return title ? { kind: 'title', title } : undefined
}

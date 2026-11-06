import type { SandboxGroupMember } from '../../src/types'

export type GroupMemberMenuAction = 'mention' | 'poke' | 'set-card' | 'set-title' | 'kick' | 'set-admin' | 'unset-admin' | 'transfer-owner'

export function getGroupMemberMenuActions(
  actor: SandboxGroupMember | undefined,
  target: SandboxGroupMember,
): GroupMemberMenuAction[] {
  if (!actor) return []
  const actions: GroupMemberMenuAction[] = []
  if (actor.participantId !== target.participantId) actions.push('mention', 'poke')
  if (actor.participantId === target.participantId
    || actor.role === 'owner'
    || (actor.role === 'admin' && target.role === 'member')) actions.push('set-card')
  // 与真实 QQ 一致：专属头衔只有群主可以授予，且可以授予给自己。
  if (actor.role === 'owner') actions.push('set-title')
  if (actor.role === 'owner' && target.role !== 'owner') {
    actions.push(target.role === 'admin' ? 'unset-admin' : 'set-admin')
  }
  if (actor.role === 'owner' && actor.participantId !== target.participantId) actions.push('transfer-owner')
  if (actor.participantId !== target.participantId
    && target.role !== 'owner'
    && (actor.role === 'owner' || (actor.role === 'admin' && target.role === 'member'))) actions.push('kick')
  return actions
}

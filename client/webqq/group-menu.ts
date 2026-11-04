import type { SandboxGroupMember } from '../../src/types'
import { isSandboxExtensionAction, type SandboxExtensionAction } from './sandbox-extension'

export type GroupMemberMenuAction = 'mention' | 'poke' | 'set-card' | 'set-title' | 'kick' | 'set-admin' | 'unset-admin' | 'transfer-owner'

// 菜单 action 名保持 WebQQ 既有拼写；是否打标只问共用登记表。
// 不要在这里再维护一份平行名单，也不要按实现配置或能力覆盖动态判断。
const GROUP_MEMBER_SANDBOX_EXTENSIONS = {
  'transfer-owner': 'transfer-group-owner',
} as const satisfies Partial<Record<GroupMemberMenuAction, SandboxExtensionAction>>

export function isSandboxExtensionGroupMemberAction(action: GroupMemberMenuAction): boolean {
  if (!Object.hasOwn(GROUP_MEMBER_SANDBOX_EXTENSIONS, action)) return false
  return isSandboxExtensionAction(GROUP_MEMBER_SANDBOX_EXTENSIONS[action as keyof typeof GROUP_MEMBER_SANDBOX_EXTENSIONS])
}

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

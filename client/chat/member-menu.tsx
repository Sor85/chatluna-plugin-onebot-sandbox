import { AtSignIcon, AwardIcon, CrownIcon, HandIcon, TagIcon, UserMinusIcon, UserPlusIcon } from 'lucide-react'
import { ContextMenuItem } from '@chatluna/ui-kit'
import type { SandboxGroupMember } from '../../src/types'
import { useT } from '../i18n'
import { getGroupMemberMenuActions } from '../webqq/group-menu'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ExtensionMark } from './extension-mark'

/**
 * 群成员菜单项。可用动作由 `getGroupMemberMenuActions` 按双方群身份判定：普通成员不能管理他人，
 * 管理员不能管理群主或其他管理员，只有群主能授予头衔与转让群主。
 */
export function GroupMemberMenuItems({ target, managementOnly, onMention }: {
  target: SandboxGroupMember
  managementOnly?: boolean
  onMention?(participantId: string): void
}) {
  const t = useT()
  const { store, run, dialogs } = useSandbox()
  const { group, operatorId, conversation } = useWorkspace()
  if (!group) return null
  const actor = group.members.find(({ participantId }) => participantId === operatorId)
  const actions = getGroupMemberMenuActions(actor, target)
  const targetId = target.participantId
  const act = (input: Parameters<typeof store.performGroupAction>[0]) => run(t('sandbox.error.group'), () => store.performGroupAction(input))
  const kickDisabledReason = !actor || actor.participantId === targetId
    ? ''
    : actor.role === 'member'
      ? t('sandbox.member.kickNeedAdmin')
      : actor.role === 'admin' && target.role !== 'member' ? t('sandbox.member.adminLimit') : ''

  return (
    <>
      {!managementOnly && actions.includes('mention') && onMention && (
        <ContextMenuItem onClick={() => onMention(targetId)}><AtSignIcon />{t('sandbox.member.mention')}</ContextMenuItem>
      )}
      {!managementOnly && actions.includes('poke') && conversation && (
        <ContextMenuItem onClick={() => act({ action: 'poke', groupId: group.id, targetId, conversationId: conversation.id })}>
          <HandIcon />{t('sandbox.member.poke')}
        </ContextMenuItem>
      )}
      {actions.includes('set-card') && (
        <ContextMenuItem onClick={() => dialogs.openGroupAction('card', targetId, group.id)}><TagIcon />{t('sandbox.member.setCard')}</ContextMenuItem>
      )}
      {actions.includes('set-title') && (
        <ContextMenuItem onClick={() => dialogs.openGroupAction('title', targetId, group.id)}><AwardIcon />{t('sandbox.member.setTitle')}</ContextMenuItem>
      )}
      {actions.includes('set-admin') && (
        <ContextMenuItem onClick={() => act({ action: 'set-admin', groupId: group.id, targetId, enabled: true })}><UserPlusIcon />{t('sandbox.member.setAdmin')}</ContextMenuItem>
      )}
      {actions.includes('unset-admin') && (
        <ContextMenuItem onClick={() => act({ action: 'set-admin', groupId: group.id, targetId, enabled: false })}><UserMinusIcon />{t('sandbox.member.unsetAdmin')}</ContextMenuItem>
      )}
      {actions.includes('transfer-owner') && (
        <ContextMenuItem onClick={() => act({ action: 'transfer-owner', groupId: group.id, targetId })}>
          <CrownIcon />{t('sandbox.member.transferOwner')}<ExtensionMark />
        </ContextMenuItem>
      )}
      {actions.includes('kick')
        ? <ContextMenuItem variant="destructive" onClick={() => act({ action: 'kick', groupId: group.id, targetId })}><UserMinusIcon />{t('sandbox.member.kick')}</ContextMenuItem>
        : kickDisabledReason && <ContextMenuItem disabled><UserMinusIcon />{kickDisabledReason}</ContextMenuItem>}
    </>
  )
}

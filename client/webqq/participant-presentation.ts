import type { SandboxGroup, SandboxGroupMember } from '../../src/types'
import { getFriendMenuActions, type FriendMenuAction, type FriendMenuState } from './friend-menu'
import { getGroupAuthorityBadge, getGroupMemberDisplayName } from './group-display'
import { getGroupMemberMenuActions, type GroupMemberMenuAction } from './group-menu'

/**
 * 「这个参与者该怎么显示」——消息列表的参与者呈现投影。
 *
 * 名称、头像、徽标与两张菜单的取数此前散在 `webqq-message-list.vue` 里，各自都要先拿到
 * `props.model` 才能问。收成纯函数后可以不起组件逐条断言，「群名片为空白时回退到全局昵称」
 * 这类边界因此第一次有了红灯。
 */

export interface MessageParticipant {
  name: string
  avatar?: string
  isBot: boolean
}

/** 参与者投影要读的那部分列表模型。 */
export interface ParticipantPresentationContext {
  readonly participants: Record<string, MessageParticipant>
  readonly friendMenuStates: Record<string, FriendMenuState>
  readonly currentGroup?: SandboxGroup
  readonly currentOperatorId?: string
}

const NO_FRIEND_MENU_STATE: FriendMenuState = {
  isFriend: false,
  pendingOutgoing: false,
  pendingIncoming: false,
}

/** 全局昵称。参与者目录里没有这个人时退回标识本身，界面上宁可显示一串 ID 也不显示空白。 */
export function getParticipantName(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'participants'>,
): string {
  return context.participants[participantId]?.name ?? participantId
}

export function getParticipantAvatar(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'participants'>,
): string | undefined {
  return context.participants[participantId]?.avatar
}

/** 机器人参与者才显示机器人形态的头像与「跳转到对应请求」。目录缺这个人时按非机器人处理。 */
export function isBotParticipant(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'participants'>,
): boolean {
  return context.participants[participantId]?.isBot ?? false
}

/** 当前群里的成员记录。不在群里（私聊、或已退群的历史发言者）时取不到。 */
export function getCurrentGroupMember(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'currentGroup'>,
): SandboxGroupMember | undefined {
  return context.currentGroup?.members.find((member) => member.participantId === participantId)
}

/**
 * 消息上显示的作者名：群名片优先，回退到全局昵称。
 *
 * 回退按「去空白后为空」判定而不是按「字段存在」——只判存在会让一张全是空格的群名片顶掉昵称，
 * 表现为消息上的名字整个消失。
 */
export function getMessageAuthorName(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'participants' | 'currentGroup'>,
): string {
  return getGroupMemberDisplayName(
    getCurrentGroupMember(participantId, context),
    getParticipantName(participantId, context),
  )
}

/** 群身份徽标与专属头衔共用同一个槽位，判定住在 `group-display`。 */
export function getMessageRoleBadge(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'currentGroup'>,
) {
  return getGroupAuthorityBadge(getCurrentGroupMember(participantId, context))
}

/**
 * 头像右键里的群成员动作。
 *
 * 目标不在当前群里就一个都不给：私聊里点头像不该冒出群操作，历史发言者已退群时那些操作
 * 也真的做不到。发起者用当前操作者，因此同一条消息在不同操作者视角下给出的动作不同。
 */
export function getMessageGroupMemberActions(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'currentGroup' | 'currentOperatorId'>,
): GroupMemberMenuAction[] {
  const target = getCurrentGroupMember(participantId, context)
  if (!target) return []
  return getGroupMemberMenuActions(
    getCurrentGroupMember(context.currentOperatorId ?? '', context),
    target,
  )
}

/**
 * 哪些动作算「群管理操作」。
 *
 * 这张表决定头像右键里那个「群成员操作」子菜单出不出现：`mention` 与 `poke` 是互动而不是
 * 管理，它们留在一级菜单里，因此只有这六项进表。表此前内联在视图模板旁边，改它不会报错，
 * 只会让子菜单在该出现时不出现。
 */
export const GROUP_MANAGEMENT_ACTIONS: readonly GroupMemberMenuAction[] = [
  'set-card',
  'set-title',
  'set-admin',
  'unset-admin',
  'transfer-owner',
  'kick',
]

export function hasGroupMemberManagementActions(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'currentGroup' | 'currentOperatorId'>,
): boolean {
  return getMessageGroupMemberActions(participantId, context)
    .some((action) => GROUP_MANAGEMENT_ACTIONS.includes(action))
}

/** 好友关系状态。投影里没有这个人时按「不是好友、没有待处理申请」处理。 */
export function getFriendMenuStateOf(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'friendMenuStates'>,
): FriendMenuState {
  return context.friendMenuStates[participantId] ?? NO_FRIEND_MENU_STATE
}

/** 头像右键里的好友动作。聊天区域里的入口带互动项（戳一戳），因此第二参数恒为 true。 */
export function getChatFriendActions(
  participantId: string,
  context: Pick<ParticipantPresentationContext, 'friendMenuStates'>,
): FriendMenuAction[] {
  return getFriendMenuActions(getFriendMenuStateOf(participantId, context), true)
}

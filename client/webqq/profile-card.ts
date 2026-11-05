import type {
  SandboxAccountProfile,
  SandboxBotProfile,
  SandboxGroup,
  SandboxGroupMember,
  SandboxParticipant,
  SandboxSnapshot,
  SandboxUser,
} from '../../src/types'
import { isSandboxBot } from '../../src/types'
import { implementationLabel } from '../shared/implementation'

/** 字段名与取值都经插件文案翻译；纯逻辑模块不依赖 React，由调用方传入 `t`。 */
export type ProfileCardTranslate = (key: string, params?: Record<string, unknown>) => string

export type ProfileCardFieldGroup = 'account' | 'friendship' | 'group-member' | 'bot-runtime' | 'group'

export interface ProfileCardField {
  group: ProfileCardFieldGroup
  label: string
  value: string
}

export interface ProfileCardModel {
  participantId: string
  name: string
  avatar?: string
  avatarKind: 'user' | 'bot' | 'group'
  /** 「QQ」或「群号」，已按当前语言翻译。 */
  identityLabel: string
  /** 个性签名单独展示在英雄区，不混入字段分组。 */
  personalNote?: string
  fields: ProfileCardField[]
}

export function getProfileCardGroupLabel(t: ProfileCardTranslate, group: ProfileCardFieldGroup): string {
  return t(`sandbox.profileCard.group.${group}`)
}

function formatSex(t: ProfileCardTranslate, value: SandboxAccountProfile['sex']): string | undefined {
  if (value) return t(`sandbox.sex.${value}`)
}

function yesNo(t: ProfileCardTranslate, value: boolean) {
  return t(value ? 'sandbox.profileCard.yes' : 'sandbox.profileCard.no')
}

function pushField(fields: ProfileCardField[], group: ProfileCardFieldGroup, label: string, value: string | number | boolean | undefined) {
  if (value === undefined || value === '') return
  fields.push({ group, label, value: String(value) })
}

function getAccountFields(t: ProfileCardTranslate, profile: SandboxAccountProfile | undefined): ProfileCardField[] {
  if (!profile) return []
  const fields: ProfileCardField[] = []
  const label = (name: string) => t(`sandbox.profileCard.field.${name}`)
  pushField(fields, 'account', label('sex'), formatSex(t, profile.sex))
  pushField(fields, 'account', label('age'), profile.age)
  pushField(fields, 'account', 'QID', profile.qid)
  pushField(fields, 'account', label('level'), profile.level)
  pushField(fields, 'account', label('loginDays'), profile.loginDays)
  pushField(fields, 'account', label('regTime'), profile.regTime)
  pushField(fields, 'account', label('city'), profile.city)
  pushField(fields, 'account', label('country'), profile.country)
  if (profile.birthdayYear !== undefined || profile.birthdayMonth !== undefined || profile.birthdayDay !== undefined) {
    const parts = [
      profile.birthdayYear,
      profile.birthdayMonth,
      profile.birthdayDay,
    ].filter((part): part is number => part !== undefined)
    if (parts.length) pushField(fields, 'account', label('birthday'), parts.join('-'))
  }
  if (profile.labels?.length) pushField(fields, 'account', label('labels'), profile.labels.join(t('sandbox.profileCard.separator')))
  if (profile.isVip !== undefined) pushField(fields, 'account', 'VIP', yesNo(t, profile.isVip))
  if (profile.isYearsVip !== undefined) pushField(fields, 'account', label('yearsVip'), yesNo(t, profile.isYearsVip))
  pushField(fields, 'account', label('vipLevel'), profile.vipLevel)
  return fields
}

function getFriendshipFields(
  t: ProfileCardTranslate,
  snapshot: Pick<SandboxSnapshot, 'participants' | 'friendships'>,
  participantId: string,
): ProfileCardField[] {
  const fields: ProfileCardField[] = []
  for (const friendship of snapshot.friendships) {
    if (!friendship.participantIds.includes(participantId)) continue
    for (const [ownerId, remark] of Object.entries(friendship.remarks)) {
      if (!remark) continue
      const peerId = friendship.participantIds.find((id) => id !== ownerId) ?? participantId
      // 备注属于 owner 对 peer 的好友局部资料，标签标明双方以免与全局昵称混淆。
      if (peerId === participantId) {
        const owner = snapshot.participants.find(({ id }) => id === ownerId)
        pushField(fields, 'friendship', t('sandbox.profileCard.remarkBy', { name: owner?.name ?? ownerId }), remark)
      } else if (ownerId === participantId) {
        const peer = snapshot.participants.find(({ id }) => id === peerId)
        pushField(fields, 'friendship', t('sandbox.profileCard.remarkFor', { name: peer?.name ?? peerId }), remark)
      }
    }
  }
  return fields
}

function getGroupMemberFields(t: ProfileCardTranslate, group: SandboxGroup, member: SandboxGroupMember): ProfileCardField[] {
  const fields: ProfileCardField[] = []
  const label = (name: string) => t(`sandbox.profileCard.field.${name}`)
  pushField(fields, 'group-member', label('group'), group.name)
  pushField(fields, 'group-member', label('groupId'), group.id)
  pushField(fields, 'group-member', label('role'), t(`sandbox.role.${member.role}`))
  // 仅在有值时展示，不使用「未设置」等伪造默认值掩盖缺失。
  pushField(fields, 'group-member', label('card'), member.card)
  pushField(fields, 'group-member', label('title'), member.title)
  pushField(fields, 'group-member', label('area'), member.area)
  pushField(fields, 'group-member', label('joinTime'), member.joinTime)
  pushField(fields, 'group-member', label('lastSentTime'), member.lastSentTime)
  pushField(fields, 'group-member', label('groupLevel'), member.level)
  if (member.unfriendly !== undefined) pushField(fields, 'group-member', label('unfriendly'), yesNo(t, member.unfriendly))
  pushField(fields, 'group-member', label('titleExpire'), member.titleExpireTime)
  if (member.cardChangeable !== undefined) pushField(fields, 'group-member', label('cardChangeable'), yesNo(t, member.cardChangeable))
  return fields
}

function getBotRuntimeFields(t: ProfileCardTranslate, bot: SandboxBotProfile): ProfileCardField[] {
  const label = (name: string) => t(`sandbox.profileCard.field.${name}`)
  const fields: ProfileCardField[] = [
    { group: 'bot-runtime', label: label('implementation'), value: implementationLabel(bot.implementation) },
    { group: 'bot-runtime', label: label('enabled'), value: t(bot.enabled ? 'sandbox.env.enabled' : 'sandbox.env.disabled') },
  ]
  if (bot.disabledCapabilities?.length) {
    fields.push({ group: 'bot-runtime', label: label('disabledCapabilities'), value: bot.disabledCapabilities.join(t('sandbox.profileCard.separator')) })
  }
  return fields
}

export function buildProfileCardModel(t: ProfileCardTranslate, input: {
  snapshot: Pick<SandboxSnapshot, 'participants' | 'friendships' | 'groups'>
  participantId: string
  viewerId?: string
  groupId?: string
}): ProfileCardModel | undefined {
  const participant = input.snapshot.participants.find(({ id }) => id === input.participantId) as SandboxParticipant | undefined
  if (!participant) return undefined

  const fields: ProfileCardField[] = []
  fields.push(...getAccountFields(t, participant.profile))
  fields.push(...getFriendshipFields(t, input.snapshot, participant.id))

  // 优先当前会话群；否则列出参与者加入的全部群成员资料，满足「场景中全部可用资料」。
  const memberships = input.groupId
    ? input.snapshot.groups
      .filter(({ id }) => id === input.groupId)
      .flatMap((group) => {
        const member = group.members.find(({ participantId }) => participantId === participant.id)
        return member ? [{ group, member }] : []
      })
    : input.snapshot.groups.flatMap((group) => {
      const member = group.members.find(({ participantId }) => participantId === participant.id)
      return member ? [{ group, member }] : []
    })
  for (const { group, member } of memberships) {
    fields.push(...getGroupMemberFields(t, group, member))
  }

  if (isSandboxBot(participant)) fields.push(...getBotRuntimeFields(t, participant))

  return {
    participantId: participant.id,
    name: participant.name,
    avatar: participant.avatar,
    avatarKind: isSandboxBot(participant) ? 'bot' : 'user',
    identityLabel: 'QQ',
    ...(participant.profile?.personalNote ? { personalNote: participant.profile.personalNote } : {}),
    fields,
  }
}

export function buildGroupProfileCardModel(t: ProfileCardTranslate, group: SandboxGroup): ProfileCardModel {
  return {
    participantId: group.id,
    name: group.name,
    ...(group.avatar ? { avatar: group.avatar } : {}),
    avatarKind: 'group',
    identityLabel: t('sandbox.profileCard.field.groupId'),
    fields: [
      { group: 'group', label: t('sandbox.profileCard.field.members'), value: t('sandbox.profileCard.memberCount', { count: group.members.length }) },
      { group: 'group', label: t('sandbox.profileCard.field.announcements'), value: t('sandbox.profileCard.announcementCount', { count: group.announcements.length }) },
    ],
  }
}

export function getParticipantPersonalNote(participant: SandboxUser | SandboxBotProfile | undefined): string | undefined {
  return participant?.profile?.personalNote
}

export function groupProfileCardFields(t: ProfileCardTranslate, fields: readonly ProfileCardField[]): Array<{ group: ProfileCardFieldGroup, label: string, fields: ProfileCardField[] }> {
  const order: ProfileCardFieldGroup[] = ['account', 'friendship', 'group-member', 'bot-runtime', 'group']
  return order
    .map((group) => ({
      group,
      label: getProfileCardGroupLabel(t, group),
      fields: fields.filter((field) => field.group === group),
    }))
    .filter((section) => section.fields.length > 0)
}

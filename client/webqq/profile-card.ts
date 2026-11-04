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
  identityLabel: 'QQ' | '群号'
  /** 个性签名单独展示在英雄区，不混入字段分组。 */
  personalNote?: string
  fields: ProfileCardField[]
}

const GROUP_LABELS: Record<ProfileCardFieldGroup, string> = {
  account: '账号资料',
  friendship: '好友资料',
  'group-member': '群成员资料',
  'bot-runtime': '机器人运行',
  group: '群资料',
}

export function getProfileCardGroupLabel(group: ProfileCardFieldGroup): string {
  return GROUP_LABELS[group]
}

function getGroupRole(member: SandboxGroupMember): string {
  if (member.role === 'owner') return '群主'
  if (member.role === 'admin') return '管理员'
  return '成员'
}

function formatSex(value: SandboxAccountProfile['sex']): string | undefined {
  if (value === 'male') return '男'
  if (value === 'female') return '女'
  if (value === 'unknown') return '未知'
}

function pushField(fields: ProfileCardField[], group: ProfileCardFieldGroup, label: string, value: string | number | boolean | undefined) {
  if (value === undefined || value === '') return
  fields.push({ group, label, value: String(value) })
}

function getAccountFields(profile: SandboxAccountProfile | undefined): ProfileCardField[] {
  if (!profile) return []
  const fields: ProfileCardField[] = []
  pushField(fields, 'account', '性别', formatSex(profile.sex))
  pushField(fields, 'account', '年龄', profile.age)
  pushField(fields, 'account', 'QID', profile.qid)
  pushField(fields, 'account', '等级', profile.level)
  pushField(fields, 'account', '登录天数', profile.loginDays)
  pushField(fields, 'account', '注册时间', profile.regTime)
  pushField(fields, 'account', '城市', profile.city)
  pushField(fields, 'account', '国家', profile.country)
  if (profile.birthdayYear !== undefined || profile.birthdayMonth !== undefined || profile.birthdayDay !== undefined) {
    const parts = [
      profile.birthdayYear,
      profile.birthdayMonth,
      profile.birthdayDay,
    ].filter((part): part is number => part !== undefined)
    if (parts.length) pushField(fields, 'account', '生日', parts.join('-'))
  }
  if (profile.labels?.length) pushField(fields, 'account', '标签', profile.labels.join('、'))
  if (profile.isVip !== undefined) pushField(fields, 'account', 'VIP', profile.isVip ? '是' : '否')
  if (profile.isYearsVip !== undefined) pushField(fields, 'account', '年费 VIP', profile.isYearsVip ? '是' : '否')
  pushField(fields, 'account', 'VIP 等级', profile.vipLevel)
  return fields
}

function getFriendshipFields(
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
        pushField(fields, 'friendship', `${owner?.name ?? ownerId} 的备注`, remark)
      } else if (ownerId === participantId) {
        const peer = snapshot.participants.find(({ id }) => id === peerId)
        pushField(fields, 'friendship', `备注 ${peer?.name ?? peerId}`, remark)
      }
    }
  }
  return fields
}

function getGroupMemberFields(group: SandboxGroup, member: SandboxGroupMember): ProfileCardField[] {
  const fields: ProfileCardField[] = []
  pushField(fields, 'group-member', '所在群', group.name)
  pushField(fields, 'group-member', '群号', group.id)
  pushField(fields, 'group-member', '群身份', getGroupRole(member))
  // 仅在有值时展示，不使用「未设置」等伪造默认值掩盖缺失。
  pushField(fields, 'group-member', '群名片', member.card)
  pushField(fields, 'group-member', '专属头衔', member.title)
  pushField(fields, 'group-member', '地区', member.area)
  pushField(fields, 'group-member', '入群时间', member.joinTime)
  pushField(fields, 'group-member', '最后发言', member.lastSentTime)
  pushField(fields, 'group-member', '群等级', member.level)
  if (member.unfriendly !== undefined) pushField(fields, 'group-member', '不友好', member.unfriendly ? '是' : '否')
  pushField(fields, 'group-member', '头衔过期', member.titleExpireTime)
  if (member.cardChangeable !== undefined) pushField(fields, 'group-member', '可改名片', member.cardChangeable ? '是' : '否')
  return fields
}

function getBotRuntimeFields(bot: SandboxBotProfile): ProfileCardField[] {
  const fields: ProfileCardField[] = [
    { group: 'bot-runtime', label: '实现配置', value: bot.implementation === 'napcat' ? 'NapCat' : 'LLBot' },
    { group: 'bot-runtime', label: '启用状态', value: bot.enabled ? '已启用' : '已停用' },
  ]
  if (bot.disabledCapabilities?.length) {
    fields.push({ group: 'bot-runtime', label: '已禁用能力', value: bot.disabledCapabilities.join('、') })
  }
  return fields
}

export function buildProfileCardModel(input: {
  snapshot: Pick<SandboxSnapshot, 'participants' | 'friendships' | 'groups'>
  participantId: string
  viewerId?: string
  groupId?: string
}): ProfileCardModel | undefined {
  const participant = input.snapshot.participants.find(({ id }) => id === input.participantId) as SandboxParticipant | undefined
  if (!participant) return undefined

  const fields: ProfileCardField[] = []
  fields.push(...getAccountFields(participant.profile))
  fields.push(...getFriendshipFields(input.snapshot, participant.id))

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
    fields.push(...getGroupMemberFields(group, member))
  }

  if (isSandboxBot(participant)) fields.push(...getBotRuntimeFields(participant))

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

export function buildGroupProfileCardModel(group: SandboxGroup): ProfileCardModel {
  return {
    participantId: group.id,
    name: group.name,
    ...(group.avatar ? { avatar: group.avatar } : {}),
    avatarKind: 'group',
    identityLabel: '群号',
    fields: [
      { group: 'group', label: '群成员', value: `${group.members.length} 人` },
      { group: 'group', label: '群公告', value: `${group.announcements.length} 条` },
    ],
  }
}

export function getParticipantPersonalNote(participant: SandboxUser | SandboxBotProfile | undefined): string | undefined {
  return participant?.profile?.personalNote
}

export function groupProfileCardFields(fields: readonly ProfileCardField[]): Array<{ group: ProfileCardFieldGroup, label: string, fields: ProfileCardField[] }> {
  const order: ProfileCardFieldGroup[] = ['account', 'friendship', 'group-member', 'bot-runtime', 'group']
  return order
    .map((group) => ({
      group,
      label: getProfileCardGroupLabel(group),
      fields: fields.filter((field) => field.group === group),
    }))
    .filter((section) => section.fields.length > 0)
}

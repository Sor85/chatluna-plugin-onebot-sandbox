import type {
  SandboxAccountProfile,
  SandboxAccountSex,
  SandboxGroupMember,
  SandboxGroupRole,
  SandboxParticipant,
  SandboxSnapshot,
} from './types'

export type SandboxAccountSexInput = SandboxAccountSex | 0 | 1 | 2 | '0' | '1' | '2'

const ACCOUNT_PROFILE_KEYS = [
  'personalNote',
  'sex',
  'age',
  'qid',
  'level',
  'loginDays',
  'regTime',
  'city',
  'country',
  'birthdayYear',
  'birthdayMonth',
  'birthdayDay',
  'labels',
  'isVip',
  'isYearsVip',
  'vipLevel',
] as const satisfies readonly (keyof SandboxAccountProfile)[]

export function normalizeAccountSex(value: unknown): SandboxAccountSex | undefined {
  if (value === 'male' || value === 1 || value === '1') return 'male'
  if (value === 'female' || value === 2 || value === '2') return 'female'
  if (value === 'unknown' || value === 0 || value === '0') return 'unknown'
  return undefined
}

export function normalizeAccountProfile(input?: SandboxAccountProfile | null): SandboxAccountProfile | undefined {
  if (!input) return undefined
  const profile: SandboxAccountProfile = {}
  if (typeof input.personalNote === 'string') profile.personalNote = input.personalNote
  if (input.sex !== undefined) {
    const sex = normalizeAccountSex(input.sex)
    if (sex) profile.sex = sex
  }
  if (typeof input.age === 'number' && Number.isFinite(input.age)) profile.age = Math.trunc(input.age)
  if (typeof input.qid === 'string') profile.qid = input.qid
  if (typeof input.level === 'number' && Number.isFinite(input.level)) profile.level = Math.trunc(input.level)
  if (typeof input.loginDays === 'number' && Number.isFinite(input.loginDays)) profile.loginDays = Math.trunc(input.loginDays)
  if (typeof input.regTime === 'number' && Number.isFinite(input.regTime)) profile.regTime = Math.trunc(input.regTime)
  if (typeof input.city === 'string') profile.city = input.city
  if (typeof input.country === 'string') profile.country = input.country
  if (typeof input.birthdayYear === 'number' && Number.isFinite(input.birthdayYear)) profile.birthdayYear = Math.trunc(input.birthdayYear)
  if (typeof input.birthdayMonth === 'number' && Number.isFinite(input.birthdayMonth)) profile.birthdayMonth = Math.trunc(input.birthdayMonth)
  if (typeof input.birthdayDay === 'number' && Number.isFinite(input.birthdayDay)) profile.birthdayDay = Math.trunc(input.birthdayDay)
  if (Array.isArray(input.labels)) profile.labels = input.labels.map(String)
  if (typeof input.isVip === 'boolean') profile.isVip = input.isVip
  if (typeof input.isYearsVip === 'boolean') profile.isYearsVip = input.isYearsVip
  if (typeof input.vipLevel === 'number' && Number.isFinite(input.vipLevel)) profile.vipLevel = Math.trunc(input.vipLevel)
  return ACCOUNT_PROFILE_KEYS.some((key) => profile[key] !== undefined) ? profile : undefined
}

export function mergeAccountProfile(
  current: SandboxAccountProfile | undefined,
  patch: SandboxAccountProfile,
): SandboxAccountProfile | undefined {
  return normalizeAccountProfile({ ...current, ...patch })
}

export function toOneBotSex(value: SandboxAccountSex | undefined): string | undefined {
  return value
}

export function toOneBotAccountProfile(participant: Pick<SandboxParticipant, 'id' | 'name' | 'profile'>) {
  const profile = participant.profile ?? {}
  const data: Record<string, unknown> = {
    user_id: Number(participant.id),
    nickname: participant.name,
  }
  if (profile.sex !== undefined) data.sex = profile.sex
  if (profile.age !== undefined) data.age = profile.age
  if (profile.qid !== undefined) data.qid = profile.qid
  if (profile.level !== undefined) data.level = profile.level
  if (profile.loginDays !== undefined) data.login_days = profile.loginDays
  if (profile.regTime !== undefined) data.reg_time = profile.regTime
  if (profile.personalNote !== undefined) data.long_nick = profile.personalNote
  if (profile.city !== undefined) data.city = profile.city
  if (profile.country !== undefined) data.country = profile.country
  if (profile.birthdayYear !== undefined) data.birthday_year = profile.birthdayYear
  if (profile.birthdayMonth !== undefined) data.birthday_month = profile.birthdayMonth
  if (profile.birthdayDay !== undefined) data.birthday_day = profile.birthdayDay
  if (profile.labels !== undefined) data.labels = profile.labels
  if (profile.isVip !== undefined) data.is_vip = profile.isVip
  if (profile.isYearsVip !== undefined) data.is_years_vip = profile.isYearsVip
  if (profile.vipLevel !== undefined) data.vip_level = profile.vipLevel
  return data
}

export function toOneBotLoginInfo(participant: Pick<SandboxParticipant, 'id' | 'name' | 'profile'>) {
  const profile = participant.profile ?? {}
  const data: Record<string, unknown> = {
    user_id: Number(participant.id),
    nickname: participant.name,
  }
  if (profile.personalNote !== undefined) data.long_nick = profile.personalNote
  if (profile.sex !== undefined) data.sex = profile.sex
  return data
}

export function toOneBotGroupMemberInfo(
  groupId: string,
  member: SandboxGroupMember,
  participant: Pick<SandboxParticipant, 'id' | 'name' | 'profile'>,
  shutUpTimestamp = 0,
) {
  const profile = participant.profile ?? {}
  const data: Record<string, unknown> = {
    group_id: Number(groupId),
    user_id: Number(participant.id),
    nickname: participant.name,
    card: member.card ?? '',
    role: member.role,
    title: member.title ?? '',
    shut_up_timestamp: shutUpTimestamp,
  }
  if (profile.sex !== undefined) data.sex = profile.sex
  if (profile.age !== undefined) data.age = profile.age
  if (member.area !== undefined) data.area = member.area
  if (member.joinTime !== undefined) data.join_time = member.joinTime
  if (member.lastSentTime !== undefined) data.last_sent_time = member.lastSentTime
  if (member.level !== undefined) data.level = member.level
  if (member.unfriendly !== undefined) data.unfriendly = member.unfriendly
  if (member.titleExpireTime !== undefined) data.title_expire_time = member.titleExpireTime
  if (member.cardChangeable !== undefined) data.card_changeable = member.cardChangeable
  return data
}

export function parseAccountProfileFromUnknown(value: unknown): SandboxAccountProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  return normalizeAccountProfile({
    personalNote: typeof input.personalNote === 'string'
      ? input.personalNote
      : typeof input.personal_note === 'string'
        ? input.personal_note
        : typeof input.long_nick === 'string'
          ? input.long_nick
          : undefined,
    sex: normalizeAccountSex(input.sex),
    age: typeof input.age === 'number' ? input.age : undefined,
    qid: typeof input.qid === 'string' ? input.qid : undefined,
    level: typeof input.level === 'number' ? input.level : undefined,
    loginDays: typeof input.loginDays === 'number'
      ? input.loginDays
      : typeof input.login_days === 'number'
        ? input.login_days
        : undefined,
    regTime: typeof input.regTime === 'number'
      ? input.regTime
      : typeof input.reg_time === 'number'
        ? input.reg_time
        : undefined,
    city: typeof input.city === 'string' ? input.city : undefined,
    country: typeof input.country === 'string' ? input.country : undefined,
    birthdayYear: typeof input.birthdayYear === 'number'
      ? input.birthdayYear
      : typeof input.birthday_year === 'number'
        ? input.birthday_year
        : undefined,
    birthdayMonth: typeof input.birthdayMonth === 'number'
      ? input.birthdayMonth
      : typeof input.birthday_month === 'number'
        ? input.birthday_month
        : undefined,
    birthdayDay: typeof input.birthdayDay === 'number'
      ? input.birthdayDay
      : typeof input.birthday_day === 'number'
        ? input.birthday_day
        : undefined,
    labels: Array.isArray(input.labels) ? input.labels.map(String) : undefined,
    isVip: typeof input.isVip === 'boolean'
      ? input.isVip
      : typeof input.is_vip === 'boolean'
        ? input.is_vip
        : undefined,
    isYearsVip: typeof input.isYearsVip === 'boolean'
      ? input.isYearsVip
      : typeof input.is_years_vip === 'boolean'
        ? input.is_years_vip
        : undefined,
    vipLevel: typeof input.vipLevel === 'number'
      ? input.vipLevel
      : typeof input.vip_level === 'number'
        ? input.vip_level
        : undefined,
  })
}

function readOptionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
}

function readOptionalNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  }
}

function readOptionalBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
}

function normalizeGroupRole(value: unknown): SandboxGroupRole | undefined {
  if (value === 'owner' || value === 'admin' || value === 'member') return value
}

/**
 * 归一化群成员资料。只保留已建模字段，丢弃 raw API 透传。
 * 群名片/头衔/等级等不回写到账号全局资料。
 */
export function normalizeGroupMemberFromUnknown(value: unknown): SandboxGroupMember | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const participantId = typeof input.participantId === 'string'
    ? input.participantId
    : typeof input.user_id === 'string' || typeof input.user_id === 'number'
      ? String(input.user_id)
      : undefined
  const role = normalizeGroupRole(input.role)
  if (!participantId || !role) return undefined
  return {
    participantId,
    role,
    card: readOptionalString(input.card),
    title: readOptionalString(input.title),
    mutedUntil: readOptionalString(input.mutedUntil, input.muted_until),
    area: readOptionalString(input.area),
    joinTime: readOptionalNumber(input.joinTime, input.join_time),
    lastSentTime: readOptionalNumber(input.lastSentTime, input.last_sent_time),
    level: readOptionalString(input.level),
    unfriendly: readOptionalBoolean(input.unfriendly),
    titleExpireTime: readOptionalNumber(input.titleExpireTime, input.title_expire_time),
    cardChangeable: readOptionalBoolean(input.cardChangeable, input.card_changeable),
  }
}

export function normalizeFriendshipRemarks(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, remark]) => [key, remark.trim()])
    .filter(([, remark]) => remark.length > 0))
}

/** 场景导入/替换时剥离未建模资料字段，并保持账号/好友/群成员边界。 */
export function sanitizeSnapshotProfiles(snapshot: SandboxSnapshot): SandboxSnapshot {
  return {
    ...snapshot,
    participants: snapshot.participants.map((participant) => {
      const profile = normalizeAccountProfile(participant.profile)
      if (profile) return { ...participant, profile }
      const { profile: _ignored, ...rest } = participant
      return rest
    }),
    groups: snapshot.groups.map((group) => ({
      ...group,
      members: group.members.flatMap((member) => {
        const normalized = normalizeGroupMemberFromUnknown(member)
        return normalized ? [normalized] : []
      }),
    })),
    friendships: snapshot.friendships.map((friendship) => ({
      ...friendship,
      remarks: normalizeFriendshipRemarks(friendship.remarks),
    })),
  }
}

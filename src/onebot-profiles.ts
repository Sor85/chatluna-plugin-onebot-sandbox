import type { SandboxImplementationProfile } from './types'
import { SandboxDomainError } from './types'

export type SandboxOneBotCapabilitySurface = 'standard' | 'native'

export interface SandboxOneBotCapability {
  id: string
  action: string
  handler: string
  description: string
  aliases?: string[]
  surface: SandboxOneBotCapabilitySurface
  supported: boolean
  reason?: string
}

export interface SandboxOneBotProfileBaseline {
  id: SandboxImplementationProfile
  label: string
  snapshotDate: string
  sourceRevision: string
  appName: string
  appVersion: string
  capabilities: SandboxOneBotCapability[]
}

export interface SandboxOneBotMessageEventFields {
  message_id: number
  message_seq: number
  real_id?: number
  message_format: 'array'
  font: number
}

const standardActions = {
  get_status: '获取机器人在线状态和运行状态',
  get_login_info: '获取当前机器人的 QQ ID 和昵称',
  get_version_info: '获取当前 OneBot 实现和协议版本信息',
  get_friend_list: '获取当前机器人的好友列表',
  get_group_list: '获取当前机器人已加入的群列表',
  get_group_info: '获取指定群的名称和成员数量',
  get_group_member_info: '获取指定群成员的资料和群身份',
  get_group_member_list: '获取指定群的全部成员列表',
  send_private_msg: '向指定好友发送私聊消息',
  send_group_msg: '向指定群发送群聊消息',
  send_msg: '根据参数自动发送私聊或群聊消息',
  get_msg: '按消息 ID 获取机器人可见的消息详情',
  delete_msg: '撤回机器人发送且仍可操作的消息',
  set_group_kick: '将指定普通成员踢出群聊',
  set_group_admin: '设置或取消指定成员的管理员身份',
  set_group_card: '修改指定成员的群名片',
  set_group_name: '修改指定群的群名称',
  set_friend_add_request: '同意或拒绝好友申请',
  set_group_add_request: '同意或拒绝加群申请或群邀请',
  set_group_leave: '退出指定群聊（群主不可直接退出）',
  set_group_ban: '禁言或解除禁言指定群成员；沙盒保存禁言到期时间',
  set_group_special_title: '设置或清除群成员专属头衔；沙盒保存头衔并在群成员资料中返回',
} as const

const nativeActions: SandboxOneBotCapability[] = [
  { id: 'get_stranger_info', action: 'get_stranger_info', handler: 'get_stranger_info', description: '获取指定 QQ 用户的基础资料', surface: 'native', supported: true },
  { id: 'message.history.friend', action: 'get_friend_msg_history', handler: 'get_friend_msg_history', description: '获取指定好友的私聊历史消息', surface: 'native', supported: true },
  { id: 'message.history.group', action: 'get_group_msg_history', handler: 'get_group_msg_history', description: '获取指定群的群聊历史消息', surface: 'native', supported: true },
  { id: 'friend.category.list', action: 'get_friends_with_category', handler: 'get_friends_with_category', description: '获取按 QQ 好友分组整理的好友列表', surface: 'native', supported: true },
  {
    id: 'friend.remark.set',
    action: 'set_friend_remark',
    handler: 'set_friend_remark',
    description: '修改当前机器人对指定好友的备注；空备注表示清除备注，get_friend_list 与 get_recent_contact 立刻返回同一份值',
    surface: 'native',
    supported: true,
  },
  { id: 'delete_friend', action: 'delete_friend', handler: 'delete_friend', description: '删除当前机器人的指定好友', surface: 'native', supported: true },
  { id: 'set_qq_profile', action: 'set_qq_profile', handler: 'set_qq_profile', description: '修改当前机器人的昵称和个性签名', surface: 'native', supported: true },
  { id: 'set_qq_avatar', action: 'set_qq_avatar', handler: 'set_qq_avatar', description: '修改当前机器人的头像', surface: 'native', supported: true },
  {
    id: 'send_poke',
    action: 'send_poke',
    handler: 'send_poke',
    description: '向好友或群成员发送戳一戳',
    aliases: ['friend_poke', 'group_poke'],
    surface: 'native',
    supported: true,
  },
  {
    id: 'group.member.shut-list',
    action: 'get_group_shut_list',
    handler: 'get_group_shut_list',
    description: '获取指定群当前处于禁言状态的成员列表',
    aliases: ['getGroupShutList'],
    surface: 'native',
    supported: true,
  },
  {
    id: 'group.notice.list',
    action: '_get_group_notice',
    handler: 'get_group_notice',
    description: '获取指定群的公告列表；沙盒公告没有图片、发布设置与阅读数，NapCat 的 image 与 images 都返回空数组，LLBot 必给的 settings 五项按 false 返回，NapCat 的可选 settings 与 read_num 不出现',
    surface: 'native',
    supported: true,
  },
  {
    id: 'group.system-msg',
    action: 'get_group_system_msg',
    handler: 'get_group_system_msg',
    description: '获取机器人有权审批的入群申请与发给它的群邀请；返回的 request_id 可直接作为 set_group_add_request 的 flag',
    surface: 'native',
    supported: true,
  },
  {
    id: 'message.emoji-like',
    action: 'set_msg_emoji_like',
    handler: 'set_msg_emoji_like',
    description: '给消息贴表情回应；沙盒按 emoji 保存回应参与者',
    surface: 'native',
    supported: true,
  },
  {
    id: 'message.emoji-like.list',
    action: 'fetch_emoji_like',
    handler: 'fetch_emoji_like',
    description: '获取消息上某个 emoji 的表情回应参与者；沙盒不分页，cookie 恒为空串；nickName 刻意返回参与者真名，而不是复刻 LLBot 上游写死的空串',
    surface: 'native',
    supported: true,
  },
  {
    id: 'message.forward.send',
    action: 'send_forward_msg',
    handler: 'send_forward_msg',
    description: '发送合并转发消息；沙盒创建独立转发资源，并在会话中写入外层 forward 卡片消息',
    aliases: ['send_group_forward_msg', 'send_private_forward_msg'],
    surface: 'native',
    supported: true,
  },
  {
    id: 'message.forward.get',
    action: 'get_forward_msg',
    handler: 'get_forward_msg',
    description: '读取合并转发详情；接受转发资源 id 或外层消息 message_id，返回 node 列表',
    surface: 'native',
    supported: true,
  },
]

function createCapabilities(profileCapabilities: SandboxOneBotCapability[]): SandboxOneBotCapability[] {
  return [
    ...Object.entries(standardActions).map(([action, description]) => ({
      id: action,
      action,
      handler: action,
      description,
      surface: 'standard' as const,
      supported: true,
    })),
    ...nativeActions,
    ...profileCapabilities,
  ]
}

const baselines: Record<SandboxImplementationProfile, SandboxOneBotProfileBaseline> = {
  napcat: {
    id: 'napcat',
    label: 'NapCat',
    snapshotDate: '2026-07-24',
    sourceRevision: '33546b936e008c017b2b9c1c41a0bb4f9e86c5be',
    appName: 'NapCat.Onebot',
    appVersion: 'sandbox-2026.07.24',
    capabilities: createCapabilities([
      {
        id: 'contact.recent.list',
        action: 'get_recent_contact',
        handler: 'get_recent_contact',
        description: '获取当前机器人的最近私聊和群聊会话',
        surface: 'native',
        supported: true,
      },
      {
        id: 'group.notice.delete',
        action: '_del_group_notice',
        handler: 'delete_group_notice',
        description: '删除指定群公告',
        surface: 'native',
        supported: true,
      },
      {
        id: 'group.member.kick-batch',
        action: 'set_group_kick_members',
        handler: 'batch_kick_group_members',
        description: '一次将多个普通成员踢出群聊',
        surface: 'native',
        supported: true,
      },
      {
        id: 'group.album.list',
        action: 'get_qun_album_list',
        handler: 'get_group_album_list',
        description: '获取指定群的相册列表',
        surface: 'native',
        supported: false,
        reason: '沙盒未模拟 NapCat 群相册资源',
      },
      {
        id: 'group.ai.characters',
        action: 'get_ai_characters',
        handler: 'get_ai_characters',
        description: '获取 NapCat 群聊 AI 声聊角色列表',
        surface: 'native',
        supported: false,
        reason: '沙盒未模拟 NapCat 群聊 AI 声聊资源',
      },
    ]),
  },
  llbot: {
    id: 'llbot',
    label: 'LLBot',
    snapshotDate: '2026-07-24',
    sourceRevision: 'd6e2f485b8164597d04a2907d307739ecfcf4a55',
    appName: 'LLOneBot',
    appVersion: 'sandbox-2026.07.24',
    capabilities: createCapabilities([
      {
        id: 'group.notice.delete',
        action: '_delete_group_notice',
        handler: 'delete_group_notice',
        description: '删除指定群公告',
        surface: 'native',
        supported: true,
      },
      {
        id: 'group.member.kick-batch',
        action: 'batch_delete_group_member',
        handler: 'batch_kick_group_members',
        description: '一次将多个普通成员踢出群聊',
        surface: 'native',
        supported: true,
      },
      {
        id: 'group.album.list',
        action: 'get_group_album_list',
        handler: 'get_group_album_list',
        description: '获取指定群的相册列表',
        surface: 'native',
        supported: false,
        reason: '沙盒未模拟 LLBot 群相册资源',
      },
      {
        id: 'flash.file.info',
        action: 'get_flash_file_info',
        handler: 'get_flash_file_info',
        description: '获取 LLBot 闪传文件信息',
        surface: 'native',
        supported: false,
        reason: '沙盒未模拟 LLBot 闪传文件',
      },
    ]),
  },
}

export function getOneBotProfileBaseline(profile: SandboxImplementationProfile): SandboxOneBotProfileBaseline {
  return structuredClone(baselines[profile])
}

/** 全部已建模的 OneBot 实现。按实现展开 action 别名的查询需要遍历它们。 */
export function listOneBotImplementationProfiles(): SandboxImplementationProfile[] {
  return Object.keys(baselines) as SandboxImplementationProfile[]
}

export function getOneBotCapabilityMatrix(
  profile: SandboxImplementationProfile,
  disabledCapabilities: readonly string[] = [],
): SandboxOneBotCapability[] {
  const disabled = new Set(disabledCapabilities)
  return getOneBotProfileBaseline(profile).capabilities.map((capability) => disabled.has(capability.id)
    ? { ...capability, supported: false, reason: '已被机器人能力覆盖禁用' }
    : capability)
}

export function resolveOneBotAction(
  profile: SandboxImplementationProfile,
  disabledCapabilities: readonly string[],
  action: string,
): SandboxOneBotCapability {
  const baseline = baselines[profile]
  const capability = baseline.capabilities.find((item) => item.action === action || item.aliases?.includes(action))
  if (!capability) throw new SandboxDomainError(`${baseline.label} 基线不支持 OneBot action：${action}`)
  if (disabledCapabilities.includes(capability.id)) throw new SandboxDomainError(`能力已被禁用：${capability.id}`)
  if (!capability.supported) throw new SandboxDomainError(`${baseline.label} 暂不支持 ${capability.action}：${capability.reason}`)
  return capability
}

export function normalizeDisabledCapabilities(
  profile: SandboxImplementationProfile,
  values: readonly string[] | undefined,
): string[] | undefined {
  if (!values?.length) return undefined
  const supported = new Set(baselines[profile].capabilities.filter(({ supported }) => supported).map(({ id }) => id))
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  const unknown = normalized.find((id) => !supported.has(id))
  if (unknown) throw new SandboxDomainError(`${baselines[profile].label} 基线中不存在可禁用能力：${unknown}`)
  return normalized.length ? normalized : undefined
}

export function getOneBotMessageSequence(messageId: string): number {
  if (!/^[\da-f]+$/i.test(messageId)) throw new SandboxDomainError(`消息 ID 不是十六进制：${messageId}`)
  return Number.parseInt(messageId, 16)
}

export function resolveOneBotMessageId(rawMessageId: unknown, messageIds: Iterable<string>): string | undefined {
  const value = String(rawMessageId ?? '').trim()
  if (!value) return
  const ids = [...messageIds]
  if (ids.includes(value)) return value
  if (!/^\d+$/.test(value)) return
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence)) return
  return ids.find((id) => getOneBotMessageSequence(id) === sequence)
}

export function getOneBotMessageEventFields(
  profile: SandboxImplementationProfile,
  messageId: string,
): SandboxOneBotMessageEventFields {
  const sequence = getOneBotMessageSequence(messageId)
  const common = { message_id: sequence, message_seq: sequence, message_format: 'array' as const, font: 0 }
  return profile === 'napcat' ? { ...common, real_id: sequence } : common
}

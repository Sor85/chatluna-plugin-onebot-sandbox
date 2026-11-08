import { errorDetail } from './error-detail'
import type { Context } from 'cordis'
import { Bot, type Fragment, h, Universal } from '@satorijs/core'
import type { SandboxControlService } from './control-service'
import {
  parseKoishiOutboundMessage,
  parseOneBotOutboundMessage,
  toOneBotMessageSegments,
  toOneBotRawMessage,
  type SandboxOutboundMediaSource,
  type SandboxOutboundMessage,
} from './onebot-message'
import {
  normalizeAccountSex,
  toOneBotAccountProfile,
  toOneBotGroupMemberInfo,
  toOneBotLoginInfo,
} from './account-profile'
import {
  getOneBotMessageId,
  getOneBotMessageSequence,
  getOneBotProfileBaseline,
  getSatoriMessageId,
  resolveOneBotAction,
  resolveOneBotMessageId,
} from './onebot-profiles'
import { createOneBotDebugError } from './onebot-debug'
import type { InboundEventConversations } from './inbound-delivery'
import { MAX_MEDIA_SIZE } from './media-storage'
import {
  listVisibleConversationIds,
  listVisibleRootConversations,
  readConversationMessageIds,
  requireVisibleConversation,
  resolveConversation,
  resolveConversationPeerId,
  resolveDirectConversationId,
  resolveGroupConversationId,
  resolveOneBotChannelId,
  toOneBotChannelId,
  toOneBotDirectChannelId,
} from './conversation-resolution'
import {
  forwardNodeText,
  isRecalledMessage,
  isSandboxGroupMemberMuted,
  type SandboxForwardNodeInput,
  type SandboxGroupMember,
  type SandboxGroupSystemMessage,
  type SandboxImplementationProfile,
  type SandboxOneBotConversationObservation,
} from './types'

/**
 * 一次 OneBot action 碰到的会话，由具体 handler 在完成后填上。
 *
 * 让「会话观察」只出现在一处：handler 只报出自己碰了哪个会话、以及按 OneBot 参数寻址到的是
 * 哪个根会话，两者之间是不是一次值得断言的关系由记录调试记录的那一处统一判定。每次外部调用
 * 一个独立实例，避免并发 action 互相覆盖。
 */
interface OneBotActionTarget {
  /** 实际操作的会话：写入是落点，读取是真正读到的那个会话。 */
  conversationId?: string
  /**
   * 仅读取型 action 填写：它按 OneBot 参数寻址到的根会话。
   *
   * 与 {@link conversationId} 不同就意味着这次读取跟随了入站事件来源会话；判定因此不必再
   * 重新推一遍寻址，也不会把「插件主动查另一个联系人的历史」误当成跟随。
   */
  addressedRootConversationId?: string
}

/** 合并转发节点 content 里一个 forward 段指向的资源 ID；不是 forward 段时返回 undefined。 */
function readNestedForwardId(segment: unknown): string | undefined {
  if (!segment || typeof segment !== 'object' || Reflect.get(segment, 'type') !== 'forward') return undefined
  const data = Reflect.get(segment, 'data')
  const id = data && typeof data === 'object' ? String(Reflect.get(data, 'id') ?? '') : ''
  return id || undefined
}

// OneBot 用秒级到期时间戳表示禁言，未禁言固定为 0。
function getGroupMemberMuteTimestamp(member: SandboxGroupMember): number {
  return isSandboxGroupMemberMuted(member) ? Math.floor(new Date(member.mutedUntil!).getTime() / 1000) : 0
}

/** QQ 内核的群角色编号（NapCat `NTGroupMemberRole`）：成员 2、管理员 3、群主 4。 */
const KERNEL_GROUP_ROLE: Record<SandboxGroupMember['role'], number> = { member: 2, admin: 3, owner: 4 }

/** 内核 uid 是与 QQ 号无关的不透明字符串；沙盒没有这一层，按账号派生一个形似的值。 */
function toKernelUid(participantId: string): string {
  return `u_sandbox_${participantId}`
}

export namespace SandboxBot {
  export interface Config {
    selfId: string
    name: string
    avatar?: string
    implementation: SandboxImplementationProfile
    disabledCapabilities?: string[]
  }

  export interface Internal {
    _request(action: string, params: Record<string, unknown>): Promise<unknown>
    _get(action: string, params?: Record<string, unknown>): Promise<unknown>
    getGroupInfo(groupId: string | number, noCache?: boolean): Promise<unknown>
    getGroupMemberList(groupId: string | number): Promise<unknown[]>
    getGroupMemberInfo(groupId: string | number, userId: string | number, noCache?: boolean): Promise<unknown>
    set_friend_add_request(input: { flag: string; approve: boolean; remark?: string }): Promise<unknown>
    set_group_add_request(input: { flag: string; sub_type: 'add' | 'invite'; approve: boolean; reason?: string }): Promise<unknown>
  }
}

// Koishi Context 覆盖了 Cordis 的递归数据库泛型，在 strict 模式下无法满足
// Satori Bot<C> 的基础约束；只在第三方基类边界放宽，领域服务仍使用具体 Context。
export class SandboxBot extends Bot<any, SandboxBot.Config> {
  hidden = true
  internal: SandboxBot.Internal
  private implementation: SandboxImplementationProfile
  private disabledCapabilities: string[]
  private readonly startedAt = Date.now()

  constructor(
    ctx: Context,
    public control: SandboxControlService,
    config: SandboxBot.Config,
    /**
     * 本机器人此刻正在处理的入站消息事件来自哪个会话，由入站投递维护。
     *
     * 直接读窗口而不是转手一层控制服务：这件事的持有者是投递模块，中间那一层什么也不知道。
     */
    private readonly inboundEventConversations: InboundEventConversations,
  ) {
    // 被测插件通常按 session.platform === 'onebot' 选择协议逻辑；
    // 沙盒身份由服务和机器人配置区分，不能伪造一个插件无法识别的新平台名。
    super(ctx, config, 'onebot')
    this.platform = 'onebot'
    this.selfId = config.selfId
    this.implementation = config.implementation
    this.disabledCapabilities = config.disabledCapabilities ?? []
    this.user = { id: config.selfId, name: config.name, avatar: control.resolveImageSource(config.avatar) }
    this.status = 1
    const executeRequest = async (
      capability: ReturnType<typeof resolveOneBotAction>,
      params: Record<string, unknown>,
      target: OneBotActionTarget,
    ) => {
        const action = capability.handler
        if (action === 'get_status') {
          const online = this.status === 1
          return {
            status: 'ok',
            retcode: 0,
            data: {
              online,
              good: online && !this.error,
              // SnowLuma 另给实例运行时长（整秒）。
              ...(this.implementation === 'snowluma' ? { time: Math.floor((Date.now() - this.startedAt) / 1000) } : {}),
            },
          }
        }
        if (action === 'get_login_info') {
          const self = this.control.getSnapshot().participants.find(({ id }) => id === this.selfId)
          return {
            status: 'ok',
            retcode: 0,
            data: toOneBotLoginInfo({
              id: this.selfId,
              name: self?.name ?? this.user?.name ?? this.selfId,
              profile: self?.profile,
            }),
          }
        }
        if (action === 'get_version_info') {
          const baseline = getOneBotProfileBaseline(this.implementation)
          return {
            status: 'ok',
            retcode: 0,
            data: { app_name: baseline.appName, app_version: baseline.appVersion, protocol_version: 'v11' },
          }
        }
        if (action === 'get_stranger_info') {
          const participant = this.control.getSnapshot().participants.find(({ id }) => id === String(params.user_id ?? ''))
          if (!participant) throw new Error(`参与者不存在：${params.user_id}`)
          return { status: 'ok', retcode: 0, data: toOneBotAccountProfile(participant) }
        }
        if (action === 'get_friend_list') {
          return { status: 'ok', retcode: 0, data: await this.listOneBotFriends() }
        }
        if (action === 'get_friends_with_category') {
          const buddyList = await this.listOneBotFriends()
          return {
            status: 'ok',
            retcode: 0,
            data: [{
              categoryId: 0,
              categoryName: '我的好友',
              categoryMbCount: buddyList.length,
              buddyList,
              ...(this.implementation === 'llbot' ? { categorySortId: 0, onlineCount: buddyList.length } : {}),
            }],
          }
        }
        if (action === 'get_group_list') {
          const groups = await this.getGuildList()
          const snapshot = this.control.getSnapshot()
          return {
            status: 'ok',
            retcode: 0,
            data: groups.data.map((group) => {
              const memberCount = snapshot.groups.find(({ id }) => id === group.id)?.members.length ?? 0
              return { group_id: Number(group.id), group_name: group.name, member_count: memberCount, max_member_count: memberCount }
            }),
          }
        }
        if (action === 'get_recent_contact') {
          // SnowLuma 上游是空实现，照答空数组：插件在沙盒上读到的最近会话不能比真实环境多。
          if (this.implementation === 'snowluma') return { status: 'ok', retcode: 0, data: [] }
          const limit = this.resolveCountParam(params.count, 10)
          const snapshot = this.control.getVisibleSnapshot(this.selfId, 1)
          const participants = new Map(snapshot.participants.map((participant) => [participant.id, participant]))
          const groups = new Map(snapshot.groups.map((group) => [group.id, group]))
          const messages = new Map(snapshot.messages.map((message) => [message.id, message]))
          const recentContacts = listVisibleRootConversations(snapshot, this.selfId).flatMap((conversation) => {
            // 最近联系人摘要不得泄露撤回原文，回退到最近一条仍可读的消息。
            const latestMessage = [...readConversationMessageIds(snapshot, conversation.id)].reverse()
              .map((messageId) => messages.get(messageId))
              .find((message) => message && !isRecalledMessage(message))
            if (!latestMessage) return []
            const peerId = (conversation.type === 'group'
              ? conversation.groupId
              : resolveConversationPeerId(conversation, this.selfId))!
            const peerName = conversation.type === 'group'
              ? groups.get(peerId)?.name ?? peerId
              : participants.get(peerId)?.name ?? peerId
            const senderName = participants.get(latestMessage.authorId)?.name ?? latestMessage.authorId
            const sendMemberName = conversation.type === 'group'
              ? groups.get(peerId)?.members.find(({ participantId }) => participantId === latestMessage.authorId)?.card ?? ''
              : ''
            return [{
              createdAt: new Date(latestMessage.createdAt).getTime(),
              contact: {
                lastestMsg: this.toOneBotMessage(latestMessage),
                peerUin: peerId,
                remark: conversation.type === 'direct'
                  ? snapshot.friendships.find(({ participantIds }) => participantIds.includes(this.selfId) && participantIds.includes(peerId))?.remarks[this.selfId] ?? ''
                  : '',
                msgTime: String(Math.floor(new Date(latestMessage.createdAt).getTime() / 1000)),
                chatType: conversation.type === 'group' ? 2 : 1,
                msgId: latestMessage.id,
                sendNickName: senderName,
                sendMemberName,
                peerName,
              },
            }]
          }).sort((left, right) => right.createdAt - left.createdAt).slice(0, limit).map(({ contact }) => contact)
          return { status: 'ok', retcode: 0, data: recentContacts }
        }
        if (action === 'get_group_info') {
          const group = await this.getGuild(this.normalizeOneBotGroupId(params.group_id))
          const memberCount = this.control.getSnapshot().groups.find(({ id }) => id === group.id)?.members.length ?? 0
          return {
            status: 'ok',
            retcode: 0,
            data: { group_id: Number(group.id), group_name: group.name, member_count: memberCount, max_member_count: memberCount },
          }
        }
        if (action === 'get_group_member_info') {
          const groupId = this.normalizeOneBotGroupId(params.group_id)
          const member = await this.getGuildMember(groupId, String(params.user_id ?? ''))
          return { status: 'ok', retcode: 0, data: this.toOneBotGuildMember(groupId, member) }
        }
        if (action === 'get_group_member_list') {
          const groupId = this.normalizeOneBotGroupId(params.group_id)
          const members = await this.getGuildMemberList(groupId)
          return { status: 'ok', retcode: 0, data: members.data.map((member) => this.toOneBotGuildMember(groupId, member)) }
        }
        if (action === 'send_private_msg') {
          const conversationId = this.resolveDirectConversationId(String(params.user_id ?? ''))
          const messageId = await this.deliverOutboundMessage(conversationId, parseOneBotOutboundMessage(params.message))
          target.conversationId = conversationId
          return { status: 'ok', retcode: 0, data: { message_id: getOneBotMessageId(this.implementation, messageId) } }
        }
        if (action === 'send_group_msg') {
          const groupId = this.normalizeOneBotGroupId(params.group_id)
          await this.getGuild(groupId)
          const conversationId = this.resolveGroupConversationId(groupId)
          const messageId = await this.deliverOutboundMessage(conversationId, parseOneBotOutboundMessage(params.message))
          target.conversationId = conversationId
          return { status: 'ok', retcode: 0, data: { message_id: getOneBotMessageId(this.implementation, messageId) } }
        }
        if (action === 'send_msg') {
          const targetAction = params.message_type === 'group' || params.group_id !== undefined
            ? 'send_group_msg'
            : 'send_private_msg'
          const targetCapability = resolveOneBotAction(this.implementation, this.disabledCapabilities, targetAction)
          if (!targetCapability) throw new Error(`OneBot action ${targetAction} is not supported`)
          // send_msg 只是协议级分流入口；直接进入具体实现，避免一次外部调用生成两条调试记录。
          return executeRequest(targetCapability, params, target)
        }
        if (action === 'get_msg') {
          const message = this.requireReadableMessage(String(params.message_id ?? ''))
          return { status: 'ok', retcode: 0, data: this.toOneBotMessage(message) }
        }
        if (action === 'get_friend_msg_history') {
          const conversationId = this.resolveHistoryConversation(
            target,
            this.resolveDirectConversationId(String(params.user_id ?? '')),
          )
          return this.implementation === 'snowluma'
            ? this.getSnowLumaMessageHistory(conversationId, params)
            : this.getOneBotMessageHistory(conversationId, params)
        }
        if (action === 'get_group_msg_history') {
          const conversationId = this.resolveHistoryConversation(
            target,
            this.resolveGroupConversationId(this.normalizeOneBotGroupId(params.group_id)),
          )
          return this.implementation === 'snowluma'
            ? this.getSnowLumaMessageHistory(conversationId, params)
            : this.getOneBotMessageHistory(conversationId, params)
        }
        if (action === 'delete_msg') {
          await this.control.recallBotMessage(this.selfId, String(params.message_id ?? ''))
          return { status: 'ok', retcode: 0, data: null }
        }
        if (action === 'delete_friend') {
          this.control.deleteBotFriend(this.selfId, String(params.user_id ?? ''))
          return { status: 'ok', retcode: 0, data: null }
        }
        if (action === 'set_group_kick') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'kick',
            groupId: this.normalizeOneBotGroupId(params.group_id),
            targetId: String(params.user_id ?? ''),
          })
        }
        if (action === 'set_group_admin') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'set-admin',
            groupId: this.normalizeOneBotGroupId(params.group_id),
            targetId: String(params.user_id ?? ''),
            enabled: params.enable === true,
          })
        }
        if (action === 'batch_kick_group_members') {
          const rawUserIds = this.implementation === 'llbot' ? params.user_ids : params.user_id
          if (!Array.isArray(rawUserIds) || !rawUserIds.length) {
            throw new Error(`${capability.action} 需要至少一个群成员 ID`)
          }
          for (const userId of rawUserIds) {
            await this.control.performBotGroupAction(this.selfId, {
              action: 'kick',
              groupId: this.normalizeOneBotGroupId(params.group_id),
              targetId: String(userId),
            })
          }
          return { status: 'ok', retcode: 0, data: null }
        }
        if (action === 'set_group_card') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'set-card',
            groupId: this.normalizeOneBotGroupId(params.group_id),
            targetId: String(params.user_id ?? ''),
            card: typeof params.card === 'string' ? params.card : '',
          })
        }
        if (action === 'set_group_name') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'set-name',
            groupId: this.normalizeOneBotGroupId(params.group_id),
            name: typeof params.group_name === 'string' ? params.group_name : '',
          })
        }
        if (action === 'delete_group_notice') {
          // SnowLuma 的公告 ID 也可以写在 fid。
          const noticeId = String(params.notice_id ?? (this.implementation === 'snowluma' ? params.fid : undefined) ?? '')
          if (!noticeId) throw new Error(`${capability.action} 缺少 notice_id`)
          this.control.deleteGroupAnnouncement({
            operatorId: this.selfId,
            groupId: this.normalizeOneBotGroupId(params.group_id),
            announcementId: noticeId,
          })
          return { status: 'ok', retcode: 0, data: null }
        }
        if (action === 'get_group_notice') {
          const announcements = this.control.listGroupAnnouncements({
            operatorId: this.selfId,
            groupId: this.normalizeOneBotGroupId(params.group_id),
          })
          if (this.implementation === 'snowluma') {
            return {
              status: 'ok',
              retcode: 0,
              data: announcements.map(({ id, authorId, content, createdAt }) => ({
                notice_id: id,
                sender_id: Number(authorId),
                publish_time: Math.floor(new Date(createdAt).getTime() / 1000),
                message: { text: content, image: [], images: [] },
                // SnowLuma 原样透传 QQ 网页接口的 settings，且 read_num、type、pinned 都是必给字段；
                // 沙盒没有对应状态，按网页接口的键名给 0，type 取普通公告的 6。
                settings: { is_show_edit_card: 0, remind_ts: 0, tip_window_type: 0, confirm_required: 0 },
                read_num: 0,
                type: 6,
                pinned: 0,
                send_to_new_members: false,
              })),
            }
          }
          return {
            status: 'ok',
            retcode: 0,
            data: announcements.map(({ id, authorId, content, createdAt }) => ({
              notice_id: id,
              sender_id: Number(authorId),
              // 上游是秒级时间戳；沙盒内部存 ISO 字符串，转换只在这里做一次。
              publish_time: Math.floor(new Date(createdAt).getTime() / 1000),
              message: {
                text: content,
                images: [],
                // NapCat 的返回同时给 image 与 images，LLBot 只给 images；沙盒没有公告图片，
                // 两个数组都是空的，但字段名按各自实现出现——这正是实现配置存在的意义。
                ...(this.implementation === 'napcat' ? { image: [] } : {}),
              },
              // LLBot 的 settings 是必给的五个布尔，沙盒没有对应状态因此全给 false；
              // NapCat 的 settings 与 read_num 是可选字段，不编造、直接不出现。
              ...(this.implementation === 'llbot'
                ? {
                    settings: {
                      is_show_edit_card: false,
                      tip_window: false,
                      confirm_required: false,
                      pinned: false,
                      send_new_member: false,
                    },
                  }
                : {}),
            })),
          }
        }
        if (action === 'get_group_system_msg') {
          const messages = this.control.getBotGroupSystemMessages(this.selfId)
          if (this.implementation === 'snowluma') return this.getSnowLumaGroupSystemMessages(messages, params)
          // count 只有 NapCat 声明，且它限的是「一次取多少条系统消息」的总量，分桶发生在截断之后；
          // LLBot 上游对没有 payloadSchema 的 action 一律不校验参数，传了要忽略而不是报错。
          const visible = this.implementation === 'napcat'
            ? messages.slice(0, this.resolveCountParam(params.count, 50))
            : messages
          const invited = visible.filter(({ kind }) => kind === 'invite')
            .map((message) => this.toOneBotGroupInvitedRequest(message))
          return {
            status: 'ok',
            retcode: 0,
            data: {
              invited_requests: invited,
              // NapCat 额外给一个内容相同的兼容别名桶；LLBot 只有两个桶。
              ...(this.implementation === 'napcat' ? { InvitedRequest: invited } : {}),
              join_requests: visible.filter(({ kind }) => kind === 'join')
                .map((message) => this.toOneBotGroupJoinRequest(message)),
            },
          }
        }
        if (action === 'set_friend_remark') {
          return this.control.performBotFriendAction(this.selfId, {
            action: 'set-remark',
            targetId: String(params.user_id ?? ''),
            // 两种实现的 remark 都默认空串，而空串表示清除备注。
            remark: typeof params.remark === 'string' ? params.remark : '',
          })
        }
        if (action === 'set_qq_profile') {
          // SnowLuma 三项都可选、只改传入的字段；NapCat 与 LLOneBot 的昵称必填。
          const nicknameOptional = this.implementation === 'snowluma' && params.nickname === undefined
          if (!nicknameOptional && (typeof params.nickname !== 'string' || !params.nickname.trim())) throw new Error('机器人昵称不能为空')
          // NapCat 接受 sex，SnowLuma 只收 0–2 的整数，LLOneBot 只允许 nickname/personal_note；不支持时必须明确失败。
          if (params.sex !== undefined) {
            if (this.implementation === 'llbot') throw new Error('当前实现配置不支持修改性别')
            if (this.implementation === 'snowluma' && !/^[0-2]$/.test(String(params.sex))) throw new Error('性别参数无效')
            if (normalizeAccountSex(params.sex) === undefined) throw new Error('性别参数无效')
          }
          return this.control.updateBotSelfProfile(this.selfId, {
            ...(typeof params.nickname === 'string' ? { name: params.nickname } : {}),
            ...(typeof params.personal_note === 'string' ? { personalNote: params.personal_note } : {}),
            ...(params.sex !== undefined ? { sex: normalizeAccountSex(params.sex) } : {}),
          })
        }
        if (action === 'set_qq_avatar') {
          if (typeof params.file !== 'string' || !params.file.trim()) throw new Error('机器人头像不能为空')
          return this.control.updateBotSelfProfile(this.selfId, {
            avatar: params.file,
          })
        }
        if (action === 'set_friend_add_request') {
          return this.control.handleBotFriendRequest(this.selfId, {
            flag: typeof params.flag === 'string' ? params.flag : '',
            approve: params.approve === true,
            // SnowLuma 的 set_friend_add_request 没有 remark 参数，传了也不生效。
            remark: typeof params.remark === 'string' && this.implementation !== 'snowluma' ? params.remark : undefined,
          })
        }
        if (action === 'set_group_add_request') {
          return this.control.handleBotGroupRequest(this.selfId, {
            flag: typeof params.flag === 'string' ? params.flag : '',
            subType: params.sub_type === 'invite' ? 'invite' : 'add',
            approve: params.approve === true,
            reason: typeof params.reason === 'string' ? params.reason : undefined,
          })
        }
        if (action === 'send_poke') {
          const targetId = String(params.target_id ?? params.user_id ?? '')
          if (params.group_id !== undefined) {
            const groupId = this.normalizeOneBotGroupId(params.group_id)
            const conversationId = this.resolveGroupConversationId(groupId)
            const result = await this.control.performGroupAction({
              action: 'poke',
              operatorId: this.selfId,
              groupId,
              targetId,
              conversationId,
            })
            target.conversationId = conversationId
            return result
          }
          const conversationId = this.resolveDirectConversationId(targetId)
          const result = await this.control.performFriendAction({
            action: 'poke',
            operatorId: this.selfId,
            targetId,
            conversationId,
          })
          target.conversationId = conversationId
          return result
        }
        if (action === 'set_group_leave') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'leave',
            groupId: this.normalizeOneBotGroupId(params.group_id),
          })
        }
        // set_group_ban、set_group_special_title 与 set_msg_emoji_like 现在都写入
        // 沙盒领域状态，插件可以从群成员资料、禁言列表和场景快照复查执行结果。
        if (action === 'set_group_ban') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'set-ban',
            groupId: this.normalizeOneBotGroupId(params.group_id),
            targetId: String(params.user_id ?? ''),
            durationSeconds: Number(params.duration ?? 0),
          })
        }
        if (action === 'set_group_special_title') {
          return this.control.performBotGroupAction(this.selfId, {
            action: 'set-title',
            groupId: this.normalizeOneBotGroupId(params.group_id),
            targetId: String(params.user_id ?? ''),
            title: typeof params.special_title === 'string' ? params.special_title : '',
          })
        }
        if (action === 'get_group_shut_list') {
          const groupId = this.normalizeOneBotGroupId(params.group_id)
          await this.getGuild(groupId)
          const snapshot = this.control.getSnapshot()
          const group = snapshot.groups.find(({ id }) => id === groupId)!
          const muted = group.members.filter((member) => isSandboxGroupMemberMuted(member))
          const participantOf = (id: string) => snapshot.participants.find((participant) => participant.id === id)
          // 三家形状各不相同，按上游原样给出：SnowLuma 是 OneBot 风格的 snake_case；LLBot 从群成员表
          // 映射出同名 camelCase 子集；NapCat 原样转出 QQ 内核的 ShutUpGroupMember。后两者的 uin 是字符串，
          // uid 是与 QQ 号无关的内核 ID，把它当 QQ 号用的插件在真实环境同样会失败。
          if (this.implementation === 'snowluma') {
            return {
              status: 'ok',
              retcode: 0,
              data: muted.map((member) => ({
                user_id: Number(member.participantId),
                nickname: participantOf(member.participantId)?.name ?? member.participantId,
                shut_up_time: getGroupMemberMuteTimestamp(member),
              })),
            }
          }
          const members = muted.map((member) => ({
            uid: toKernelUid(member.participantId),
            uin: member.participantId,
            nick: participantOf(member.participantId)?.name ?? member.participantId,
            cardName: member.card ?? '',
            role: KERNEL_GROUP_ROLE[member.role],
            shutUpTime: getGroupMemberMuteTimestamp(member),
            memberRealLevel: Number.parseInt(member.level ?? '', 10) || 0,
            memberSpecialTitle: member.title ?? '',
            joinTime: member.joinTime ?? 0,
            lastSpeakTime: member.lastSentTime ?? 0,
          }))
          if (this.implementation === 'llbot') return { status: 'ok', retcode: 0, data: members }
          return {
            status: 'ok',
            retcode: 0,
            data: members.map((member) => ({
              uid: member.uid,
              qid: '',
              uin: member.uin,
              nick: member.nick,
              remark: '',
              cardType: 0,
              cardName: member.cardName,
              role: member.role,
              avatarPath: '',
              shutUpTime: member.shutUpTime,
              isDelete: false,
              isSpecialConcerned: false,
              isSpecialShield: false,
              isRobot: participantOf(member.uin)?.kind === 'bot',
              groupHonor: {},
              memberRealLevel: member.memberRealLevel,
              memberLevel: member.memberRealLevel,
              globalGroupLevel: 0,
              globalGroupPoint: 0,
              memberTitleId: 0,
              memberSpecialTitle: member.memberSpecialTitle,
              specialTitleExpireTime: '0',
              userShowFlag: 0,
              userShowFlagNew: 0,
              richFlag: 0,
              mssVipType: 0,
              bigClubLevel: 0,
              bigClubFlag: 0,
              autoRemark: '',
              creditLevel: 0,
              joinTime: member.joinTime,
              lastSpeakTime: member.lastSpeakTime,
              memberFlag: 0,
              memberFlagExt: 0,
              memberMobileFlag: 0,
              memberFlagExt2: 0,
              isSpecialShielded: false,
              cardNameId: 0,
            })),
          }
        }
        if (action === 'set_msg_emoji_like') {
          const message = this.findAccessibleMessage(String(params.message_id ?? ''))
          if (this.implementation === 'snowluma' && resolveConversation(this.control.getSnapshot(), message.conversationId)?.type !== 'group') {
            throw new Error('SnowLuma 不支持私聊消息的表情回应')
          }
          // bot action 直接写入领域状态，避免再经 setMessageReaction 回绕到 OneBot action。
          this.control.applyMessageReaction({
            operatorId: this.selfId,
            messageId: message.id,
            emojiId: String(params.emoji_id ?? ''),
            enabled: params.set !== false,
          })
          return { status: 'ok', retcode: 0, data: null }
        }
        if (action === 'fetch_emoji_like') {
          // 读取路径拒绝撤回原文：撤回的语义是原文不再可读，谁贴过表情同样不该还查得出。
          const message = this.requireReadableMessage(String(params.message_id ?? ''))
          const emojiId = this.resolveEmojiLikeEmojiId(capability.action, params)
          const participantIds = message.reactions?.find((reaction) => reaction.emojiId === emojiId)?.participantIds ?? []
          const page = participantIds.slice(0, this.resolveCountParam(params.count, this.implementation === 'snowluma' ? 10 : 20))
          const participants = new Map(this.control.getSnapshot().participants.map((participant) => [participant.id, participant]))
          return {
            status: 'ok',
            retcode: 0,
            data: {
              emojiLikesList: page.map((participantId) => ({
                tinyId: participantId,
                // 刻意偏离 LLBot 上游写死的空串：沙盒有真实的参与者名字，测试者要能核对贴表情的是谁。
                nickName: participants.get(participantId)?.name ?? participantId,
                headUrl: participants.get(participantId)?.avatar ?? '',
              })),
              // 沙盒不分页：参与者列表是完整的内存数组，假游标只会多一处能漂移的状态。
              cookie: '',
              isLastPage: page.length === participantIds.length,
              isFirstPage: true,
              ...(this.implementation === 'llbot' ? {} : { result: 0, errMsg: '' }),
            },
          }
        }
        if (action === 'send_forward_msg') {
          // send_forward_msg / send_group_forward_msg / send_private_forward_msg
          // 统一生成真实转发资源，不再把节点展平成普通文本。
          const conversationId = params.group_id !== undefined
            ? this.resolveGroupConversationId(this.normalizeOneBotGroupId(params.group_id))
            : this.resolveDirectConversationId(String(params.user_id ?? ''))
          this.getVisibleConversation(conversationId)
          const nodes = await this.parseOneBotForwardNodes(params.messages)
          const result = await this.control.applyForwardMessage({
            operatorId: this.selfId,
            conversationId,
            nodes,
          })
          target.conversationId = conversationId
          return {
            status: 'ok',
            retcode: 0,
            data: {
              message_id: getOneBotMessageId(this.implementation, result.messageId),
              // 不同实现分别返回 res_id / forward_id；沙盒同时提供二者，方便插件兼容。
              res_id: result.forwardId,
              forward_id: result.forwardId,
            },
          }
        }
        if (action === 'get_forward_msg') {
          const forwardId = typeof params.id === 'string' || typeof params.id === 'number'
            ? String(params.id)
            : undefined
          const messageId = params.message_id !== undefined ? String(params.message_id) : undefined
          const forward = this.control.getForwardMessage({
            operatorId: this.selfId,
            ...(forwardId ? { forwardId } : {}),
            ...(messageId ? { messageId } : {}),
          })
          return {
            status: 'ok',
            retcode: 0,
            data: {
              // 参考仓会同时尝试 messages / message / nodes；这里三者返回同一份 node 列表。
              messages: forward.nodes.map((node) => this.toOneBotForwardNode(node)),
              message: forward.nodes.map((node) => this.toOneBotForwardNode(node)),
              nodes: forward.nodes.map((node) => this.toOneBotForwardNode(node)),
            },
          }
        }
        throw new Error(`OneBot action 已声明但未接入处理器：${capability.action}`)
    }
    const request = async (requestedAction: string, params: Record<string, unknown>) => {
      const startedAt = Date.now()
      let action = requestedAction
      let matchedAlias: string | undefined
      // 每次调用一个独立的落点槽：同一机器人上并发的 action 不能共用它。
      const target: OneBotActionTarget = {}
      try {
        const capability = resolveOneBotAction(this.implementation, this.disabledCapabilities, requestedAction)
        action = capability.action
        matchedAlias = capability.aliases?.includes(requestedAction) ? requestedAction : undefined
        const result = await executeRequest(capability, params, target)
        this.control.recordOneBotDebug({
          botId: this.selfId,
          implementation: this.implementation,
          direction: 'action',
          requestedAction,
          action,
          matchedAlias,
          status: 'success',
          durationMs: Date.now() - startedAt,
          payload: params,
          result,
          ...(target.conversationId
            ? { conversationObservation: this.observeConversation(target) }
            : {}),
        })
        return result
      } catch (error) {
        const debugError = createOneBotDebugError(error)
        this.ctx.logger('onebot-sandbox').error('%s\n%s', `OneBot action 调用失败 [${debugError.traceId}]`, errorDetail(error))
        this.control.recordOneBotDebug({
          botId: this.selfId,
          implementation: this.implementation,
          direction: 'action',
          requestedAction,
          action,
          matchedAlias,
          status: 'error',
          durationMs: Date.now() - startedAt,
          payload: params,
          error: debugError,
        })
        throw error
      }
    }
    const internal: SandboxBot.Internal = {
      _request: request,
      // 与 Koishi OneBot 适配器的 Internal._get 同义：发出 action、只返回 data，retcode 非 0 时抛错。
      // ChatLuna 的 OneBot 插件经它读取合并转发；不声明时 Proxy 会把 `_get` 当成 action 名转发。
      _get: async (action, params = {}) => {
        const response = await request(action, params) as { retcode?: number, data?: unknown }
        if (response.retcode === 0) return response.data
        throw new Error(`OneBot action ${action} 返回 retcode ${response.retcode}`)
      },
      // Koishi 的 OneBot 适配器提供 camelCase 便捷方法；不显式声明时会被下方 Proxy
      // 当作原始 action 名转发，导致 getGroupInfo 这类调用报「不支持的 action」。
      getGroupInfo: async (groupId, noCache = false) => {
        const result = await request('get_group_info', {
          group_id: this.normalizeOneBotGroupId(groupId),
          no_cache: noCache,
        }) as { data?: unknown }
        return result.data
      },
      getGroupMemberList: async (groupId) => {
        const result = await request('get_group_member_list', {
          group_id: this.normalizeOneBotGroupId(groupId),
        }) as { data?: unknown }
        return Array.isArray(result.data) ? result.data : []
      },
      getGroupMemberInfo: async (groupId, userId, noCache = false) => {
        const result = await request('get_group_member_info', {
          group_id: this.normalizeOneBotGroupId(groupId),
          user_id: userId,
          no_cache: noCache,
        }) as { data?: unknown }
        return result.data
      },
      set_friend_add_request: (input) => request('set_friend_add_request', input),
      set_group_add_request: (input) => request('set_group_add_request', input),
    }
    this.internal = new Proxy(internal, {
      get: (target, property) => {
        if (property in target) return Reflect.get(target, property)
        if (typeof property === 'string') return (params: Record<string, unknown> = {}) => request(property, params)
      },
    })
  }

  updateImplementation(implementation: SandboxImplementationProfile, disabledCapabilities: string[] | undefined) {
    this.implementation = implementation
    this.disabledCapabilities = disabledCapabilities ?? []
  }

  async createDirectChannel(userId: string): Promise<Universal.Channel> {
    // 与 adapter-onebot 一样给出 `private:<账号>`、不做校验：ChatLuna 唤醒后回私聊走 sendPrivateMessage →
    // 这里 → sendMessage，给沙盒会话 ID 会让调试记录与插件拿到的 channelId 都偏离真实格式。
    // 不可见的私聊由 sendMessage 报错。
    return { id: toOneBotDirectChannelId(userId), type: 1 }
  }

  async getUser(userId: string): Promise<Universal.User> {
    const snapshot = this.control.getSnapshot()
    const participant = snapshot.participants.find(({ id }) => id === userId)
    if (!participant) throw new Error(`参与者不存在：${userId}`)
    return { id: participant.id, name: participant.name, avatar: this.control.resolveImageSource(participant.avatar), isBot: participant.kind === 'bot' }
  }

  async getFriendList(): Promise<Universal.List<Universal.Friend>> {
    const snapshot = this.control.getSnapshot()
    const friendships = snapshot.friendships.filter(({ participantIds }) => participantIds.includes(this.selfId))
    return {
      data: await Promise.all(friendships.map(async ({ participantIds, remarks }) => {
        const id = participantIds.find((participantId) => participantId !== this.selfId)!
        const user = await this.getUser(id)
        // OneBot remark 只表示好友备注；缺失时返回空串，不回落到昵称。
        return { user, nick: remarks[this.selfId] ?? '' }
      })),
    }
  }

  async getGuild(guildId: string): Promise<Universal.Guild> {
    const group = this.control.getSnapshot().groups.find(({ id, members }) => id === guildId
      && members.some(({ participantId }) => participantId === this.selfId))
    if (!group) throw new Error(`群组不存在：${guildId}`)
    return { id: group.id, name: group.name }
  }

  async getGuildList(): Promise<Universal.List<Universal.Guild>> {
    const snapshot = this.control.getSnapshot()
    return {
      data: snapshot.groups
        .filter(({ members }) => members.some(({ participantId }) => participantId === this.selfId))
        .map(({ id, name }) => ({ id, name })),
    }
  }

  async getGuildMember(guildId: string, userId: string): Promise<Universal.GuildMember> {
    await this.getGuild(guildId)
    const snapshot = this.control.getSnapshot()
    const group = snapshot.groups.find(({ id }) => id === guildId)!
    const member = group.members.find(({ participantId }) => participantId === userId)
    if (!member) throw new Error(`群成员不存在：${userId}`)
    const user = await this.getUser(userId)
    const roleName = member.role === 'owner' ? '群主' : member.role === 'admin' ? '管理员' : '成员'
    return { user, name: user.name, nick: member.card ?? user.name, avatar: user.avatar, roles: [{ id: member.role, name: roleName }] }
  }

  async getGuildMemberList(guildId: string): Promise<Universal.List<Universal.GuildMember>> {
    await this.getGuild(guildId)
    const group = this.control.getSnapshot().groups.find(({ id }) => id === guildId)!
    return { data: await Promise.all(group.members.map(({ participantId }) => this.getGuildMember(guildId, participantId))) }
  }

  async getMessage(channelId: string, messageId: string): Promise<Universal.Message> {
    const message = this.requireReadableMessage(messageId, this.resolveChannelId(channelId))
    return this.toUniversalMessage(message)
  }

  async getMessageList(channelId: string): Promise<Universal.BidiList<Universal.Message>> {
    const snapshot = this.control.getSnapshot()
    const conversation = this.getVisibleConversation(resolveOneBotChannelId(snapshot, channelId, this.selfId), snapshot)
    const conversationMessageIds = new Set(readConversationMessageIds(snapshot, conversation.id))
    // 与 get_msg / 历史查询一致：已撤回消息不得以原文形式暴露给机器人。
    const messages = snapshot.messages
      .filter(({ id }) => conversationMessageIds.has(id))
      .filter((message) => !isRecalledMessage(message))
    return { data: await Promise.all(messages.map((message) => this.toUniversalMessage(message))) }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const conversationId = this.resolveChannelId(channelId)
    this.getVisibleConversation(conversationId)
    await this.control.recallBotMessage(this.selfId, messageId, conversationId)
  }

  async deleteFriend(userId: string): Promise<void> {
    this.control.deleteBotFriend(this.selfId, userId)
  }

  async kickGuildMember(guildId: string, userId: string): Promise<void> {
    await this.control.performBotGroupAction(this.selfId, { action: 'kick', groupId: guildId, targetId: userId })
  }

  async setGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
    if (roleId === 'owner') {
      await this.control.performBotGroupAction(this.selfId, { action: 'transfer-owner', groupId: guildId, targetId: userId })
      return
    }
    if (roleId !== 'admin') throw new Error(`不支持的群角色：${roleId}`)
    await this.control.performBotGroupAction(this.selfId, { action: 'set-admin', groupId: guildId, targetId: userId, enabled: true })
  }

  async unsetGuildMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
    if (roleId !== 'admin') throw new Error(`不支持的群角色：${roleId}`)
    await this.control.performBotGroupAction(this.selfId, { action: 'set-admin', groupId: guildId, targetId: userId, enabled: false })
  }

  async handleFriendRequest(messageId: string, approve: boolean, comment?: string): Promise<void> {
    await this.control.handleBotFriendRequest(this.selfId, { flag: messageId, approve, remark: comment })
  }

  async handleGuildRequest(messageId: string, approve: boolean, comment?: string): Promise<void> {
    await this.control.handleBotGroupRequest(this.selfId, { flag: messageId, subType: 'invite', approve, reason: comment })
  }

  async handleGuildMemberRequest(messageId: string, approve: boolean, comment?: string): Promise<void> {
    await this.control.handleBotGroupRequest(this.selfId, { flag: messageId, subType: 'add', approve, reason: comment })
  }

  dispose() {
    // Koishi 整体停机时可能先释放 Satori 的 bots 服务，再触发插件作用域 dispose。
    // 热卸载时服务仍存在，必须继续使用基类路径发送正确的 bot-removed 生命周期事件。
    if (!this.ctx.bots) return this.stop()
    return super.dispose()
  }

  async sendMessage(channelId: string, fragment: Fragment, _referrer?: unknown, options: Universal.SendOptions = {}) {
    if (this.status !== 1) throw new Error(`机器人已离线：${this.selfId}`)
    const conversationId = this.resolveChannelId(channelId)
    // 覆盖 Bot.sendMessage 后不会再经过 MessageEncoder；必须在原始消息 Session 上执行组件转换，
    // 否则 poke 等插件发送的 <execute> 会被当作字面文本，命令永远不会执行。
    const renderSession = options.session ?? this.session({
      type: 'send',
      channel: {
        id: channelId,
        // channel 类型来自解析出的会话，不按 ID 前缀推断：会话实例 ID 没有 `group:` 前缀，
        // 按前缀推断会把群实例判成私聊 channel，群专属的组件转换与判断随之走错分支。
        type: resolveConversation(this.control.getSnapshot(), conversationId)?.type === 'group'
          ? 0
          : 1,
      },
    })
    const transformed = await renderSession.transform(h.normalize(fragment))
    const message = parseKoishiOutboundMessage(transformed)
    if (!message.content && !message.mediaSources.length) return []
    // ChatLuna 与 Koishi 插件经 Satori sendMessage 发消息，不经过 action 层；真实适配器在这里会发出
    // send_group_msg / send_private_msg，调试页按这一形态补记，否则机器人的回复在调试记录里不可见。
    const action = resolveConversation(this.control.getSnapshot(), conversationId)?.type === 'group' ? 'send_group_msg' : 'send_private_msg'
    const payload = { channel_id: channelId, message: transformed.join('') }
    const startedAt = Date.now()
    try {
      const messageId = await this.deliverOutboundMessage(conversationId, message)
      const conversationObservation = this.observeConversation({ conversationId })
      this.control.recordOneBotDebug({
        botId: this.selfId,
        implementation: this.implementation,
        direction: 'action',
        requestedAction: 'sendMessage',
        action,
        status: 'success',
        durationMs: Date.now() - startedAt,
        payload,
        result: { status: 'ok', retcode: 0, data: { message_id: getOneBotMessageId(this.implementation, messageId) } },
        ...(conversationObservation ? { conversationObservation } : {}),
      })
      return [getSatoriMessageId(this.implementation, messageId)]
    } catch (error) {
      this.control.recordOneBotDebug({
        botId: this.selfId,
        implementation: this.implementation,
        direction: 'action',
        requestedAction: 'sendMessage',
        action,
        status: 'error',
        durationMs: Date.now() - startedAt,
        payload,
        error: createOneBotDebugError(error),
      })
      throw error
    }
  }

  private async deliverOutboundMessage(conversationId: string, message: SandboxOutboundMessage): Promise<string> {
    // 先校验机器人确实能看到目标会话，再落盘媒体；否则无效 action 会留下孤儿文件。
    this.getVisibleConversation(conversationId)
    const replyToMessageId = message.replyToRawId
      ? this.findAccessibleMessage(message.replyToRawId, conversationId).id
      : undefined
    const mediaInputs = await Promise.all(message.mediaSources.map((media) => this.resolveOutboundMedia(media)))
    if (!message.content && !mediaInputs.length) throw new Error('消息内容不能为空')
    const result = mediaInputs.length
      ? await this.control.sendStoredMediaMessage({
          operatorId: this.selfId,
          conversationId,
          content: message.content,
          replyToMessageId,
          media: this.control.storeMediaBatch(mediaInputs),
        })
      : await this.control.sendMessage({
          operatorId: this.selfId,
          conversationId,
          content: message.content,
          replyToMessageId,
        })
    return result.messageId
  }

  private async resolveOutboundMedia(media: SandboxOutboundMediaSource) {
    const source = media.source.trim()
    const dataUri = /^data:([^;,]+);base64,(.+)$/s.exec(source)
    if (dataUri) {
      const mimeType = dataUri[1].toLowerCase()
      return {
        fileName: media.fileName || this.getOutboundMediaFileName(media.type, mimeType),
        mimeType,
        dataBase64: dataUri[2],
      }
    }
    if (source.startsWith('base64://')) {
      const mimeType = media.mimeType?.toLowerCase() || this.getDefaultMediaMimeType(media.type)
      return {
        fileName: media.fileName || this.getOutboundMediaFileName(media.type, mimeType),
        mimeType,
        dataBase64: source.slice('base64://'.length),
      }
    }
    const storedMedia = /^sandbox-media:\/\/([a-f0-9]{32})$/.exec(source)
    if (storedMedia) {
      const content = this.control.getMediaContent({ operatorId: this.selfId, mediaId: storedMedia[1] })
      return { fileName: media.fileName || content.name, mimeType: content.mimeType, dataBase64: content.dataBase64 }
    }
    if (!source) throw new Error('媒体来源不能为空')
    if (/^https?:\/\//i.test(source)) return this.downloadOutboundMedia(media, source)
    // 只允许网络 URL 或沙盒受控媒体，不读取机器人传入的任意本地文件路径。
    throw new Error(`不支持的媒体来源：${source}`)
  }

  private async downloadOutboundMedia(media: SandboxOutboundMediaSource, source: string) {
    let response: Response
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      throw new Error(`下载远程媒体失败：${source}（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (!response.ok) throw new Error(`下载远程媒体失败：${response.status} ${response.statusText || source}`)

    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_SIZE) throw new Error('媒体大小不能超过 10 MB')
    const responseMimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    const mimeType = responseMimeType || media.mimeType?.toLowerCase() || this.getDefaultMediaMimeType(media.type)
    this.assertOutboundMediaType(media.type, mimeType)
    if (!response.body) throw new Error(`下载远程媒体失败：响应内容为空（${source}）`)

    const chunks: Buffer[] = []
    const reader = response.body.getReader()
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_MEDIA_SIZE) {
          await reader.cancel().catch(() => {})
          throw new Error('媒体大小不能超过 10 MB')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    if (!size) throw new Error('媒体内容不能为空')
    return {
      fileName: media.fileName || this.getOutboundMediaFileName(media.type, mimeType),
      mimeType,
      dataBase64: Buffer.concat(chunks, size).toString('base64'),
    }
  }

  private assertOutboundMediaType(type: SandboxOutboundMediaSource['type'], mimeType: string): void {
    if (type !== 'file' && !mimeType.startsWith(`${type}/`)) {
      throw new Error(`媒体类型不匹配：${type} 段收到 ${mimeType || '未知类型'}`)
    }
  }

  private getDefaultMediaMimeType(type: SandboxOutboundMediaSource['type']): string {
    if (type === 'image') return 'image/png'
    if (type === 'audio') return 'audio/mpeg'
    if (type === 'video') return 'video/mp4'
    throw new Error('文件消息必须提供 MIME 类型')
  }

  private getOutboundMediaFileName(type: SandboxOutboundMediaSource['type'], mimeType: string): string {
    const extension = (mimeType.split('/')[1] ?? 'bin').replace(/^x-/, '').replace('jpeg', 'jpg')
    return `${type}.${extension}`
  }

  private getOutboundMessageSummary(message: SandboxOutboundMessage): string {
    const media = message.mediaSources.map(({ type, fileName }) => `[${type === 'image' ? '图片' : type === 'audio' ? '语音' : type === 'video' ? '视频' : '文件'}]${fileName ? ` ${fileName}` : ''}`)
    return [message.content, ...media].filter(Boolean).join(' ')
  }

  private toOneBotGuildMember(groupId: string, member: Universal.GuildMember) {
    const userId = member.user?.id ?? ''
    const snapshot = this.control.getSnapshot()
    const groupMember = snapshot.groups.find(({ id }) => id === groupId)
      ?.members.find(({ participantId }) => participantId === userId)
    const participant = snapshot.participants.find(({ id }) => id === userId)
    if (!groupMember || !participant) {
      return {
        group_id: Number(groupId),
        user_id: Number(userId || 0),
        nickname: member.user?.name ?? userId,
        card: member.nick ?? '',
        role: member.roles?.[0]?.id ?? 'member',
        title: '',
        shut_up_timestamp: 0,
      }
    }
    return toOneBotGroupMemberInfo(
      groupId,
      groupMember,
      participant,
      getGroupMemberMuteTimestamp(groupMember),
    )
  }

  private resolveDirectConversationId(userId: string) {
    return resolveDirectConversationId(this.control.getSnapshot(), this.selfId, userId)
  }

  private resolveGroupConversationId(groupId: string) {
    return resolveGroupConversationId(this.control.getSnapshot(), groupId)
  }

  /**
   * OneBot 的条数参数：两种实现都收数字或字符串，非法取值退回各自的默认值而不是报错。
   *
   * 三处读取（最近会话、群系统消息、表情回应参与者）默认值各不相同，但归一化规则是同一条，
   * 因此只写一份——上游对这个参数一律不校验，沙盒也不该在其中某一处忽然变严。
   */
  private resolveCountParam(value: unknown, fallback: number): number {
    const count = Number(value ?? fallback)
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : fallback
  }

  /**
   * 群邀请项：两种实现的这个桶都用 `invitor_*` 指邀请人，且都不带附言。
   *
   * `request_id` 就是审批时要传的 flag，因此列出来的每一条都能直接接上 `set_group_add_request`。
   */
  private toOneBotGroupInvitedRequest(message: SandboxGroupSystemMessage) {
    return {
      request_id: message.requestId,
      invitor_uin: Number(message.initiatorId),
      invitor_nick: message.initiatorName,
      group_id: Number(message.groupId),
      group_name: message.groupName,
      checked: message.checked,
      // 处理人：沙盒场景只保存待处理申请，因此永远没有处理人，与上游未处理时的 0 一致。
      actor: 0,
      // NapCat 的两个桶共用同一份 schema，因此邀请项也带附言与申请人昵称；LLBot 的邀请项没有这两个字段。
      ...(this.implementation === 'napcat'
        ? { message: message.comment, requester_nick: message.initiatorName }
        : {}),
    }
  }

  /**
   * SnowLuma 的群系统消息是一个不分桶的数组，入群申请与群邀请共用一份 schema。
   *
   * `requester_*` 是这条请求的发起人（申请人，或邀请机器人入群的人），`invitor_*` 只在群邀请里
   * 有值、入群申请为 0 与空串；审批用的是 `flag`。`count` 是 1–100 的整数，越界时上游参数校验即拒绝。
   * 沙盒只保存待处理申请，`only_pending` 不改变结果。
   */
  private getSnowLumaGroupSystemMessages(messages: SandboxGroupSystemMessage[], params: Record<string, unknown>) {
    const count = Number(params.count ?? 50)
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('get_group_system_msg 的 count 必须是 1 到 100 的整数')
    const groupId = params.group_id === undefined ? undefined : this.normalizeOneBotGroupId(params.group_id)
    return {
      status: 'ok',
      retcode: 0,
      data: messages
        .filter((message) => groupId === undefined || message.groupId === groupId)
        .slice(0, count)
        .map((message) => ({
          group_id: Number(message.groupId),
          group_name: message.groupName,
          request_id: message.requestId,
          requester_uin: Number(message.initiatorId),
          requester_nick: message.initiatorName,
          invitor_uin: message.kind === 'invite' ? Number(message.initiatorId) : 0,
          invitor_nick: message.kind === 'invite' ? message.initiatorName : '',
          message: message.comment,
          checked: message.checked,
          flag: message.requestId,
        })),
    }
  }

  /** 入群申请项：LLBot 用 `requester_*`，NapCat 的共用 schema 里申请人落在 `invitor_*` 上。 */
  private toOneBotGroupJoinRequest(message: SandboxGroupSystemMessage) {
    const common = {
      request_id: message.requestId,
      group_id: Number(message.groupId),
      group_name: message.groupName,
      message: message.comment,
      checked: message.checked,
      actor: 0,
    }
    return this.implementation === 'napcat'
      ? { ...common, invitor_uin: Number(message.initiatorId), invitor_nick: message.initiatorName, requester_nick: message.initiatorName }
      : { ...common, requester_uin: Number(message.initiatorId), requester_nick: message.initiatorName }
  }

  /**
   * 表情回应查询的 emoji 参数，按各自实现校验。
   *
   * NapCat 只认 camelCase 的 `emojiId`，且 `emojiType` 必填（上游是 `Value.Parse` 的 Assert 阶段
   * 拒绝）；LLBot 收 `emoji_id` 或 `emojiId` 两种拼写择一、不要 `emojiType`。两边都接受所有拼写
   * 会掩盖这处真实差异，插件在沙盒上能跑、换到 NapCat 上就崩。
   *
   * `emojiType` 只做必填校验、不参与查找：`participantIds` 按 emojiId 聚合，类型不影响命中；
   * 类型与 emojiId 明显矛盾时上游也不校验，沙盒不该更严。
   *
   * SnowLuma 与 NapCat 一样只认 `emojiId`，但不要 `emojiType`。
   *
   * 两边都对取值 trim：`applyMessageReaction` 存的就是 trim 过的 emojiId，读取不跟着归一化会让
   * 「贴了带空白的表情、再按同一个参数查」查不到自己刚写的那条回应。
   */
  private resolveEmojiLikeEmojiId(actionName: string, params: Record<string, unknown>): string {
    if (this.implementation === 'napcat') {
      if (params.emojiId === undefined || params.emojiId === null) throw new Error(`${actionName} 缺少 emojiId`)
      if (params.emojiType === undefined || params.emojiType === null) throw new Error(`${actionName} 缺少 emojiType`)
      return String(params.emojiId).trim()
    }
    if (this.implementation === 'snowluma') {
      const emojiId = String(params.emojiId ?? '').trim()
      if (!emojiId) throw new Error(`${actionName} 缺少 emojiId`)
      return emojiId
    }
    const emojiId = String(params.emoji_id ?? params.emojiId ?? '').trim()
    if (!emojiId) throw new Error(`${actionName} 缺少 emoji_id`)
    return emojiId
  }

  /**
   * 群实例的 channelId 是实例 ID，插件把它当群号传进 OneBot action 时换回真实群号；也认沙盒的
   * `group:*` 会话 ID。根会话的 channelId 已经是裸群号。
   *
   * 群号从解析出的会话读，不按 `group:` 前缀推断：会话实例 ID 沿用随机 ID 命名空间、没有群前缀，
   * 剥前缀会把群实例的 channelId 原样当成群号。解析不出会话时原样返回，插件直接传真实群号仍然可用。
   */
  private normalizeOneBotGroupId(value: unknown): string {
    const raw = String(value ?? '')
    return resolveConversation(this.control.getSnapshot(), raw)?.groupId ?? raw
  }

  /**
   * 一次原始 OneBot 历史查询实际要读的会话，顺带把寻址结果报给会话观察。
   *
   * 这一维跟随入站事件来源会话，与写入落点的取舍相反。理由是两者的可见性不同：回复落到根会话
   * 是测试者在界面上看得见的事实，沙盒只记录不归位；历史查询读到什么没人看得见，它会直接变成
   * 模型输入，照字面答成根会话会让插件在会话实例里读到另一条对话线的历史，分支测试因此不成立。
   *
   * 只在「来源会话是所寻址根会话的实例」时跟随：插件主动查另一个联系人的历史是它自己的选择，
   * 跟着改会让沙盒答非所问。
   */
  private resolveHistoryConversation(target: OneBotActionTarget, rootConversationId: string): string {
    target.addressedRootConversationId = rootConversationId
    const eventConversationId = this.inboundEventConversations.current(this.selfId)
    const source = eventConversationId
      ? resolveConversation(this.control.getSnapshot(), eventConversationId)
      : undefined
    target.conversationId = source?.kind === 'instance' && source.rootConversationId === rootConversationId
      ? source.id
      : rootConversationId
    return target.conversationId
  }

  /**
   * 观察一次原始 OneBot action 与触发它的入站事件来源会话之间的关系。
   *
   * 原始 action 只能按账号或群号寻址：真实 QQ 的 action 表面没有「会话」这一级。插件在会话
   * 实例的入站事件里用原始 action 回复时，回复因此必然落到根会话——沙盒不替它猜测归位，只把
   * 这次偏离作为可断言的证据挂在机器人动作记录上。历史查询反过来跟随来源实例，那次跟随同样
   * 记成证据，见 {@link resolveHistoryConversation}。
   *
   * 偏离只认「落点正好是来源实例的根会话」这一种：插件主动寻址别的联系人是它自己的选择，
   * 不是沙盒无法归位造成的偏离，记进来只会变成噪声。
   */
  private observeConversation(target: OneBotActionTarget): SandboxOneBotConversationObservation | undefined {
    const { conversationId, addressedRootConversationId } = target
    const eventConversationId = this.inboundEventConversations.current(this.selfId)
    if (!conversationId || !eventConversationId) return undefined
    if (addressedRootConversationId !== undefined) {
      // 读取路径：寻址结果被改写过就说明跟随发生了，此时读到的会话一定是来源实例本身。
      return addressedRootConversationId !== conversationId
        ? { kind: 'history-followed-event-conversation', eventConversationId, conversationId }
        : undefined
    }
    if (eventConversationId === conversationId) return undefined
    const source = resolveConversation(this.control.getSnapshot(), eventConversationId)
    if (source?.kind !== 'instance' || source.rootConversationId !== conversationId) return undefined
    return { kind: 'reply-left-event-conversation', eventConversationId, conversationId }
  }

  /**
   * 会话可见性按完整逻辑会话判断。
   *
   * 快照可选：`getSnapshot` 每次克隆整份场景，需要顺带读消息列表的调用方传入自己那一份，
   * 一次 action 因此只克隆一遍。
   */
  /** Satori 接口收到的 channelId 可能是 adapter-onebot 格式，也可能是沙盒会话 ID，见 {@link resolveOneBotChannelId}。 */
  private resolveChannelId(channelId: string): string {
    return resolveOneBotChannelId(this.control.getSnapshot(), channelId, this.selfId)
  }

  private getVisibleConversation(channelId: string, snapshot = this.control.getSnapshot()) {
    // WebQQ 可见快照会截断最近消息；机器人 action 必须按完整逻辑会话判断可见性。
    try {
      return requireVisibleConversation(snapshot, this.selfId, channelId)
    } catch {
      throw new Error(`会话不存在：${channelId}`)
    }
  }

  /**
   * 按原始 message_id 定位一条机器人可读的消息。
   *
   * 声明会话时按「在那个会话里可读」筛选，而不是按消息实体的归属：会话实例的继承前缀仍然归属
   * 来源会话，按归属比对会让插件在分支里按消息 ID 取历史莫名失败。可读集合仍然只包含自身
   * 会话对机器人可见的消息，因此放宽的只是 `channelId` 这一维，机器人能拿到的消息集合不变。
   */
  private findAccessibleMessage(rawMessageId: string, channelId?: string) {
    const snapshot = this.control.getSnapshot()
    const visibleConversationIds = listVisibleConversationIds(snapshot, this.selfId)
    const readableMessageIds = channelId ? new Set(readConversationMessageIds(snapshot, channelId)) : undefined
    const visibleMessages = snapshot.messages.filter(({ id, conversationId }) => (
      visibleConversationIds.has(conversationId)
      && (!readableMessageIds || readableMessageIds.has(id))
    ))
    const messageId = resolveOneBotMessageId(this.implementation, rawMessageId, visibleMessages.map(({ id }) => id))
    const message = visibleMessages.find(({ id }) => id === messageId)
    if (!message) throw new Error(`消息不存在：${rawMessageId}`)
    return message
  }

  // 普通读取路径拒绝撤回原文；写路径（如 set_msg_emoji_like）仍可定位消息后由领域层给出只读错误。
  private requireReadableMessage(rawMessageId: string, channelId?: string) {
    const message = this.findAccessibleMessage(rawMessageId, channelId)
    if (isRecalledMessage(message)) throw new Error(`消息已撤回：${rawMessageId}`)
    return message
  }

  private getOneBotMessageHistory(conversationId: string, params: Record<string, unknown>) {
    const count = Number(params.count ?? 20)
    const limit = Number.isInteger(count) && count > 0 ? Math.min(count, 100) : 20
    const messageSequence = Number(params.message_seq)
    let beforeMessageId: string | undefined
    if (Number.isFinite(messageSequence) && messageSequence > 0) {
      const snapshot = this.control.getSnapshot()
      const conversation = this.getVisibleConversation(conversationId, snapshot)
      beforeMessageId = readConversationMessageIds(snapshot, conversation.id)
        .find((messageId) => getOneBotMessageSequence(messageId) === messageSequence)
      if (!beforeMessageId) throw new Error(`消息不存在：${params.message_seq}`)
    }
    // 历史查询同样不得泄露撤回原文，直接隐藏已撤回消息。
    const messages = this.control.getMessageHistory({
      operatorId: this.selfId,
      conversationId,
      limit,
      beforeMessageId,
    }).messages
      .filter((message) => !isRecalledMessage(message))
      .map((message) => this.toOneBotMessage(message))
    if (params.reverseOrder === true || params.reverse_order === true) messages.reverse()
    return { status: 'ok', retcode: 0, data: { messages } }
  }

  /**
   * SnowLuma 的历史查询以 `message_id` 为锚，且结果包含锚点本身。
   *
   * `reverse_order` 缺省为 true，取锚点及更旧的消息；false 取锚点及更新的消息；不带锚点（缺省或 0）
   * 时取最新一页。锚点查不到时上游答空列表而不是报错。`count` 缺省或不是正数时为 20，上限 200。
   * 结果始终按时间正序。
   */
  private getSnowLumaMessageHistory(conversationId: string, params: Record<string, unknown>) {
    const count = Math.trunc(Number(params.count))
    const limit = Number.isFinite(count) && count > 0 ? Math.min(count, 200) : 20
    const snapshot = this.control.getSnapshot()
    const conversation = this.getVisibleConversation(conversationId, snapshot)
    const messageIds = readConversationMessageIds(snapshot, conversation.id)
    const anchor = Number(params.message_id ?? 0)
    let window: string[]
    if (!Number.isInteger(anchor) || anchor === 0) {
      window = messageIds.slice(-limit)
    } else {
      const index = messageIds.findIndex((messageId) => getOneBotMessageId(this.implementation, messageId) === anchor)
      if (index < 0) return { status: 'ok', retcode: 0, data: { messages: [] } }
      const newer = ['false', '0', 'no', 'off'].includes(String(params.reverse_order ?? true).toLowerCase())
      window = newer ? messageIds.slice(index, index + limit) : messageIds.slice(Math.max(0, index + 1 - limit), index + 1)
    }
    const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]))
    // 历史查询同样不得泄露撤回原文，直接隐藏已撤回消息。
    const messages = window.flatMap((messageId) => messagesById.get(messageId) ?? [])
      .filter((message) => !isRecalledMessage(message))
      .map((message) => this.toOneBotMessage(message))
    return { status: 'ok', retcode: 0, data: { messages } }
  }

  /** get_friend_list 与 get_friends_with_category 的好友项；SnowLuma 的好友项另带分组 ID。 */
  private async listOneBotFriends() {
    const friends = await this.getFriendList()
    const snapshot = this.control.getSnapshot()
    return friends.data.map(({ user, nick }) => {
      const userId = user?.id ?? '0'
      const participant = snapshot.participants.find(({ id }) => id === userId)
      return {
        ...toOneBotAccountProfile(participant ?? { id: userId, name: user?.name ?? userId }),
        remark: nick ?? '',
        ...(this.implementation === 'snowluma' ? { category_id: 0 } : {}),
      }
    })
  }

  private async toUniversalMessage(message: ReturnType<SandboxControlService['getSnapshot']>['messages'][number]): Promise<Universal.Message> {
    const snapshot = this.control.getSnapshot()
    const conversation = resolveConversation(snapshot, message.conversationId)
    const user = await this.getUser(message.authorId)
    const reply = message.replyToMessageId
      ? snapshot.messages.find(({ id }) => id === message.replyToMessageId)
      : undefined
    // 回复消息本身仍可读取，但引用目标撤回后不能通过 quote 旁路泄露原文。
    const readableReply = reply && !isRecalledMessage(reply) ? reply : undefined
    return {
      id: getSatoriMessageId(this.implementation, message.id),
      messageId: getSatoriMessageId(this.implementation, message.id),
      channel: conversation ? { id: toOneBotChannelId(conversation, this.selfId), type: conversation.type === 'group' ? 0 : 1 } : undefined,
      guild: conversation?.groupId ? { id: conversation.groupId, name: snapshot.groups.find(({ id }) => id === conversation.groupId)?.name } : undefined,
      user,
      content: message.content,
      elements: h.parse(message.content),
      quote: readableReply ? {
        id: getSatoriMessageId(this.implementation, readableReply.id),
        messageId: getSatoriMessageId(this.implementation, readableReply.id),
        content: readableReply.content,
        user: await this.getUser(readableReply.authorId),
      } : undefined,
      timestamp: new Date(message.createdAt).getTime(),
      createdAt: new Date(message.createdAt).getTime(),
    }
  }

  private toOneBotMessage(message: ReturnType<SandboxControlService['getSnapshot']>['messages'][number]) {
    const snapshot = this.control.getSnapshot()
    const conversation = resolveConversation(snapshot, message.conversationId)
    const directPeerId = conversation ? resolveConversationPeerId(conversation, this.selfId) : undefined
    const sequence = getOneBotMessageSequence(message.id)
    const messageId = getOneBotMessageId(this.implementation, message.id)
    const participant = snapshot.participants.find(({ id }) => id === message.authorId)
    const groupMember = conversation?.groupId
      ? snapshot.groups.find(({ id }) => id === conversation.groupId)?.members.find(({ participantId }) => participantId === message.authorId)
      : undefined
    // 外层消息只暴露 forward 段；完整 node 通过 get_forward_msg 读取。
    const onebotMessage: Array<{ type: string; data: Record<string, string> }> = message.forwardId
      ? [{ type: 'forward', data: { id: message.forwardId } }]
      : [
        ...(message.replyToMessageId ? [{ type: 'reply', data: { id: String(getOneBotMessageId(this.implementation, message.replyToMessageId)) } }] : []),
        ...toOneBotMessageSegments(message.content, message.media),
      ]
    return {
      time: Math.floor(new Date(message.createdAt).getTime() / 1000),
      message_type: conversation?.type === 'group' ? 'group' : 'private',
      message_id: messageId,
      message_seq: sequence,
      real_id: messageId,
      sender: {
        user_id: Number(message.authorId),
        nickname: participant?.name ?? this.user?.name ?? message.authorId,
        ...(groupMember ? { card: groupMember.card ?? '', role: groupMember.role, title: groupMember.title ?? '' } : {}),
      },
      user_id: Number(conversation?.type === 'group' ? message.authorId : directPeerId ?? message.authorId),
      group_id: conversation?.groupId ? Number(conversation.groupId) : undefined,
      // SnowLuma 的群消息带群名，且 get_msg 与历史消息都不带 message_format。
      ...(this.implementation === 'snowluma'
        ? conversation?.groupId ? { group_name: snapshot.groups.find(({ id }) => id === conversation.groupId)?.name ?? '' } : {}
        : { message_format: 'array' }),
      message: onebotMessage,
      font: 0,
      raw_message: toOneBotRawMessage(onebotMessage),
    }
  }

  private async parseOneBotForwardNodes(rawNodes: unknown): Promise<SandboxForwardNodeInput[]> {
    if (!Array.isArray(rawNodes) || !rawNodes.length) throw new Error('send_forward_msg 需要至少一个消息节点')
    const nodes: SandboxForwardNodeInput[] = []
    for (const [index, node] of rawNodes.entries()) {
      const payload = node && typeof node === 'object' ? node as Record<string, unknown> : {}
      const data = payload.data && typeof payload.data === 'object'
        ? payload.data as Record<string, unknown>
        : payload
      if (data.id !== undefined && data.id !== null && String(data.id)) {
        // 引用节点：校验可见性/撤回/事件后，再固化为独立 node 快照。
        const message = this.requireReadableMessage(String(data.id))
        if (message.event) throw new Error(`事件消息不能合并转发：${data.id}`)
        nodes.push({ type: 'reference', messageId: message.id })
        continue
      }
      const userId = String(data.user_id ?? data.uin ?? data.uid ?? '').trim()
      const nickname = String(data.nickname ?? data.name ?? data.senderName ?? data.sender_name ?? userId).trim() || userId
      if (!userId) throw new Error(`send_forward_msg 节点 #${index + 1} 缺少 user_id`)
      const contentSource = data.content ?? data.message
      if (contentSource === undefined || contentSource === null) {
        throw new Error(`send_forward_msg 节点 #${index + 1} 缺少 content`)
      }
      // 节点 content 里的 forward 段挂到 domain node.forwardId（嵌套资源）；同一节点里其余的文字与
      // 媒体照常解析，不因为带了嵌套转发就丢掉。只有 forward 段时正文是 `[合并转发]` 占位。
      const segments = Array.isArray(contentSource) ? contentSource : undefined
      const forwardSegment = segments?.find((segment) => readNestedForwardId(segment))
      const forwardId = forwardSegment ? readNestedForwardId(forwardSegment) : undefined
      const rest = forwardSegment ? segments!.filter((segment) => !readNestedForwardId(segment)) : contentSource
      const createdAt = typeof data.time === 'number' || typeof data.time === 'string'
        ? { createdAt: new Date(Number(data.time) * 1000).toISOString() }
        : {}
      if (forwardId && Array.isArray(rest) && !rest.length) {
        nodes.push({ type: 'custom', userId, nickname, content: '[合并转发]', forwardId, ...createdAt })
        continue
      }
      const outbound = parseOneBotOutboundMessage(rest)
      // 自定义节点媒体与 send_msg 对齐：sandbox-media / base64 / data URI / http(s) 均可，落盘后再写入 node。
      const media = outbound.mediaSources.length
        ? await this.resolveForwardNodeMedia(outbound.mediaSources)
        : undefined
      nodes.push({
        type: 'custom',
        userId,
        nickname,
        content: this.getOutboundMessageSummary(outbound) || (media?.length ? media.map((item) => `[${item.type === 'image' ? '图片' : item.type === 'audio' ? '语音' : item.type === 'video' ? '视频' : '文件'}] ${item.name}`).join(' ') : ''),
        ...(media ? { media } : {}),
        ...(forwardId ? { forwardId } : {}),
        ...createdAt,
      })
    }
    return nodes
  }

  // 复用已有 sandbox-media 引用，其余来源走 resolveOutboundMedia + storeMediaBatch，与普通出站消息一致。
  private async resolveForwardNodeMedia(sources: SandboxOutboundMediaSource[]) {
    const media: Array<ReturnType<SandboxControlService['storeMedia']>> = []
    for (const source of sources) {
      const match = /^sandbox-media:\/\/([a-f0-9]{32})$/.exec(source.source.trim())
      if (match) {
        const content = this.control.getMediaContent({ operatorId: this.selfId, mediaId: match[1] })
        media.push({
          id: content.id,
          type: content.type,
          name: source.fileName || content.name,
          mimeType: content.mimeType,
          size: content.size,
          reference: content.reference,
        })
        continue
      }
      const input = await this.resolveOutboundMedia(source)
      media.push(...this.control.storeMediaBatch([input]))
    }
    return media
  }

  private toOneBotForwardNode(node: NonNullable<ReturnType<SandboxControlService['getSnapshot']>['forwards']>[number]['nodes'][number]) {
    const content = [
      ...toOneBotMessageSegments(forwardNodeText(node), node.media),
      ...(node.forwardId ? [{ type: 'forward', data: { id: node.forwardId } }] : []),
    ]
    return {
      type: 'node',
      data: {
        user_id: Number(node.userId) || node.userId,
        nickname: node.nickname,
        content,
        time: Math.floor(new Date(node.createdAt).getTime() / 1000),
        ...(node.sourceMessageId ? { id: String(getOneBotMessageId(this.implementation, node.sourceMessageId)) } : {}),
      },
    }
  }
}

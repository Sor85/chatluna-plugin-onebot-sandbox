import { errorDetail } from './error-detail'
import type {} from 'koishi'
import { onDispose, onStart } from './lifecycle'
import { resolveBaseDir } from './base-dir'
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import { Random } from './random'
import { h } from '@satorijs/core'
import { resolve } from 'node:path'
import { SandboxBot } from './bot'
import { BUILTIN_AVATARS, findBuiltinAvatarByReference, getBuiltinAvatarReference, pickUnusedBuiltinAvatar } from './builtin-avatars'
import { SandboxChannelAssignee } from './channel-assignee'
import { SandboxChatLunaStateStore } from './chatluna/state'
import { SandboxChatConversationLines, findChatConversationReset } from './chatluna/conversation-lines'
import {
  createInboundDelivery,
  createInboundEventConversations,
  type InboundDelivery,
  type InboundEventConversations,
  type InboundMessageContext,
  type InboundQuotedMessage,
} from './inbound-delivery'
import { SandboxMediaStorage, MAX_MEDIA_SIZE, toMediaMetadata } from './media-storage'
import { SandboxOneBotDebugStore, type AppendOneBotDebugRecordInput, type SandboxOneBotDebugPersistence } from './onebot-debug'
import { toOneBotMessageSegments, toOneBotRawMessage, type SandboxOneBotMessageSegment } from './onebot-message'
import type { SandboxSceneLoadResult, SandboxScenePersistence } from './persistence'
import {
  appendConversationMessageId,
  clearConversationMessageIds,
  createConversationInstance as insertConversationInstance,
  ensureDirectRootConversation,
  ensureGroupRootConversation,
  findDirectRootConversation,
  findGroupRootConversation,
  findVisibleConversation,
  listConversationIds,
  listVisibleConversationIds,
  projectVisibleConversations,
  pruneConversationMessageIds,
  normalizeSceneConversationInstances,
  readConversationMessageIds,
  removeConversationInstance,
  removeConversations,
  renameConversationInstance as renameInstanceTitle,
  requireConversation,
  requireVisibleConversation,
  resolveConversation,
  resolveConversationPeerId,
  resolveDirectConversationId,
  resolveGroupConversationId,
  validateSceneConversations,
  type ResolvedConversation,
} from './conversation-resolution'
import { mergeAccountProfile, normalizeAccountProfile, sanitizeSnapshotProfiles } from './account-profile'
import {
  denyMessageCapability,
  type MessageCapabilityDenial,
  type MessageCapabilityInput,
} from './message-capabilities'
import { getOneBotCapabilityMatrix, getOneBotMessageId, getOneBotMessageSequence, normalizeDisabledCapabilities, resolveOneBotMessageId, type SandboxOneBotCapability } from './onebot-profiles'
import {
  createRelationshipActions,
  denyGroupAuthority,
  type RelationshipActionDenial,
  type RelationshipActions,
} from './relationship-actions'
import {
  createDirectConversationId,
  createGroupConversationId,
  isSandboxGroupMemberMuted,
  type BranchConversationInstanceInput,
  type CreateConversationInstanceInput,
  type CreateSandboxBotInput,
  type CreateSandboxGroupInput,
  type CreateSandboxUserInput,
  type DeleteSandboxBotInput,
  type DeleteSandboxGroupInput,
  type DeleteSandboxUserInput,
  type DeleteGroupAnnouncementInput,
  type GetMediaContentInput,
  type GetSandboxBotDeliveriesInput,
  type GetMessageHistoryInput,
  type ListGroupAnnouncementsInput,
  type PerformFriendActionInput,
  type PerformFriendActionResult,
  type PerformGroupActionInput,
  type PerformGroupActionResult,
  type RecallMessageInput,
  type ClearConversationMessagesInput,
  type DeleteConversationInstanceInput,
  type RenameConversationInstanceInput,
  type SearchConversationMessagesInput,
  type SetMessageReactionInput,
  type SandboxBotDelivery,
  type SandboxAccountSex,
  type SandboxBotProfile,
  type SandboxImplementationProfile,
  type SandboxChatLunaState,
  type SandboxConversation,
  type SandboxForward,
  type SandboxForwardNode,
  type SandboxForwardNodeInput,
  type SandboxFriendship,
  type SandboxGroup,
  type SandboxGroupAnnouncement,
  type SandboxGroupSystemMessage,
  type SandboxMedia,
  type SandboxMediaContent,
  type SandboxMessage,
  type SandboxMessageChatLuna,
  type SandboxMessageHistory,
  type SandboxMessageSearchResult,
  type SandboxOneBotDebugRecord,
  type SandboxPersistenceStatus,
  type SandboxSnapshot,
  type SandboxUser,
  type GetForwardMessageInput,
  type SendForwardMessageInput,
  type SendForwardMessageResult,
  type SendMediaMessageInput,
  type SendMessageInput,
  type SendMessageResult,
  type SetGroupAnnouncementInput,
  type UpdateSandboxBotInput,
  type UpdateSandboxGroupInput,
  type UpdateSandboxUserInput,
  forwardNodeText,
  isRecalledMessage,
  SandboxDomainError,
} from './types'

export interface SandboxControlServiceOptions {
  mediaDirectory?: string
  persistence?: SandboxScenePersistence
  debugPersistence?: SandboxOneBotDebugPersistence
  debugRecordLimit?: number
  debugRecordMaxBytes?: number
  /** 场景保留的消息条数上限；超出后从最旧消息开始淘汰。 */
  sceneMessageLimit?: number
  /** 场景 JSON 的字节上限；超出后继续从最旧消息开始淘汰。 */
  sceneMessageMaxBytes?: number
  initialScene?: SandboxSnapshot
  runtimeBots?: SandboxRuntimeBotRegistry
  runtimeActive?: boolean
  databaseReadyTimeoutMs?: number
}

export class SandboxRuntimeBotRegistry {
  private owners = new Map<string, object>()

  assertAvailable(botId: string, owner: object): void {
    const currentOwner = this.owners.get(botId)
    if (currentOwner && currentOwner !== owner) throw new SandboxDomainError(`机器人 ID 已被活动场景占用：${botId}`)
  }

  claim(botId: string, owner: object): void {
    this.assertAvailable(botId, owner)
    this.owners.set(botId, owner)
  }

  release(botId: string, owner: object): void {
    if (this.owners.get(botId) === owner) this.owners.delete(botId)
  }
}

/**
 * 一次发送所处的领域位置。投递只读其中前四项（见 {@link InboundMessageContext}）；
 * 引用目标是发送路径自己组装消息段时用的，投递按已解析好的引用收到它。
 */
interface SandboxMessageContext extends InboundMessageContext {
  reply?: SandboxMessage
}

const DEFAULT_USER_ID = '10001'
const SECONDARY_USER_ID = '10002'
const ADMIN_USER_ID = '10003'
const DEFAULT_BOT_ID = '20001'
const DEFAULT_GROUP_ID = '30001'
const DEFAULT_DATABASE_READY_TIMEOUT_MS = 10_000
// 防止插件或 WebQQ 多选无限塞 node 导致场景膨胀。
const MAX_FORWARD_NODES = 100
// 新建会话实例的默认名：用户不必为每次试验先想名字。
const DEFAULT_CONVERSATION_INSTANCE_TITLE = '新会话'

// 场景是整块落盘的：每次领域变更都要把完整场景写一遍，没有上限时单次写入规模随累计
// 消息数线性增长，总写入量随消息数呈平方增长。这两个默认值把单次写入钉在恒定上界，
// 代价是超出窗口的历史消息真正丢弃，不做归档。
export const DEFAULT_SCENE_MESSAGE_LIMIT = 2000
export const DEFAULT_SCENE_MESSAGE_MAX_BYTES = 8 * 1024 * 1024

export function createEmptyScene(): SandboxSnapshot {
  return { revision: 0, participants: [], groups: [], conversations: [], conversationInstances: [], messages: [], forwards: [], friendships: [], requests: [] }
}

/**
 * 撤回被判据拒绝时的错误文案。
 *
 * 判据共享成一处后文案一句不改：它们是外部测试控制器已经在断言的用户可见事实。会话边界那两
 * 类（继承前缀、没有操作者）在撤回路径上到不了——请求声明的会话必须等于消息自身的归属，
 * 操作者也已经校验过存在；这里仍然给出归一化的文案，保证判据新增依据时不会静默落到 undefined。
 */
function describeRecallDenial(denial: MessageCapabilityDenial, message: SandboxMessage, operatorId: string): string {
  switch (denial) {
    case 'event-message':
    case 'recalled-message':
      return '该消息不支持撤回'
    case 'not-own-message':
      return '只能撤回自己发送的消息'
    case 'requires-group-authority':
      return '只有群主或管理员可以撤回成员消息'
    case 'target-outranks-actor':
      return '管理员不能管理群主或其他管理员'
    case 'actor-not-in-group':
      return `参与者不在群组中：${operatorId}`
    case 'author-not-in-group':
      return `参与者不在群组中：${message.authorId}`
    case 'inherited-prefix':
    case 'no-operator':
      return `消息不存在：${message.id}`
  }
}

/** 表情回应被判据拒绝时的错误文案。已撤回那句沿用收敛前的措辞。 */
function describeReactionDenial(denial: MessageCapabilityDenial, messageId: string): string {
  switch (denial) {
    case 'event-message':
      return '事件消息不支持表情回应'
    case 'recalled-message':
      return '已撤回消息不支持修改表情回应'
    default:
      // 会话归属与操作者存在性都在写入路径之前判定，走到这里只能是判据新增了依据。
      return `消息不存在：${messageId}`
  }
}

/** 引用回复被判据拒绝时的错误文案，措辞照 `事件消息不能合并转发` 一族。 */
function describeReplyDenial(denial: MessageCapabilityDenial, messageId: string): string {
  switch (denial) {
    case 'event-message':
      return `事件消息不能引用回复：${messageId}`
    case 'recalled-message':
      return `已撤回消息不能引用回复：${messageId}`
    default:
      // 回复目标是否在当前会话里可读已在上方判定，走到这里只能是判据新增了依据。
      return `回复消息不存在：${messageId}`
  }
}

/**
 * 群操作在拒绝文案里的动作名。
 *
 * 两条通道共用这一份：这八个动作的拒绝措辞今天在用户通道与机器人通道上逐字相同，把动作名再
 * 抄一遍等于把刚消掉的重复换个位置放回来。文案不同的那一处（入群申请审批）不在这张表里，它由
 * 两条通道各自在自己的入口上渲染。
 */
const GROUP_ACTION_LABELS = {
  // 退群的拒绝原因不带动作名。这一条只是让渲染函数的动作名参数保持必填，八个调用点因此是
  // 同一种写法，而不是分成带动作名与不带两种。
  leave: '退出群组',
  'set-name': '修改群名称',
  kick: '踢出成员',
  'set-admin': '设置管理员',
  'set-card': '修改群名片',
  'transfer-owner': '转让群主身份',
  'set-title': '设置专属头衔',
  mute: '禁言成员',
  unmute: '解除禁言',
} as const

/**
 * 群操作被关系规则拒绝时的错误文案。
 *
 * 规则只回答「不行，因为什么」，措辞在这里成形——形状与上面三个消息能力渲染函数一致。这些文案
 * 是 WebQQ 与被测插件已经在断言的用户可见事实，规则收成一处后一句不改。
 */
function describeGroupActionDenial(denial: RelationshipActionDenial, action: keyof typeof GROUP_ACTION_LABELS): string {
  const label = GROUP_ACTION_LABELS[action]
  switch (denial) {
    case 'owner-cannot-leave':
      return '群主不能直接退出群组'
    case 'requires-group-authority':
      return `只有群主或管理员可以${label}`
    case 'requires-group-owner':
      return `只有群主可以${label}`
    case 'target-outranks-actor':
      return '管理员不能管理群主或其他管理员'
    case 'target-is-owner':
      return '不能修改群主权限'
    case 'target-is-actor':
      return `不能对自己执行${label}`
    case 'owner-transfer-to-self':
      return '不能把群主身份转让给自己'
    case 'group-name-empty':
      return '群名称不能为空'
    case 'title-too-long':
      return '专属头衔不能超过 64 个字符'
    case 'mute-duration-negative':
      return '禁言时长不能为负数'
    case 'mute-duration-too-long':
      return '禁言时长不能超过 30 天'
  }
}

export function createDefaultScene(): SandboxSnapshot {
  const createdAt = new Date().toISOString()
  const directConversations: SandboxConversation[] = [
    DEFAULT_USER_ID,
    SECONDARY_USER_ID,
    ADMIN_USER_ID,
  ].map((userId) => ({
    id: createDirectConversationId(userId, DEFAULT_BOT_ID),
    type: 'direct',
    participantIds: [userId, DEFAULT_BOT_ID].sort() as [string, string],
    messageIds: [],
  }))
  const groupConversation: SandboxConversation = {
    id: createGroupConversationId(DEFAULT_GROUP_ID),
    type: 'group',
    groupId: DEFAULT_GROUP_ID,
    messageIds: [],
  }
  return {
    revision: 0,
    participants: [
      { kind: 'user', id: DEFAULT_USER_ID, name: '测试用户1' },
      { kind: 'user', id: SECONDARY_USER_ID, name: '测试用户2' },
      { kind: 'user', id: ADMIN_USER_ID, name: '测试用户3' },
      { kind: 'bot', id: DEFAULT_BOT_ID, name: 'ChatLuna', implementation: 'napcat', enabled: true },
    ],
    groups: [{
      id: DEFAULT_GROUP_ID,
      name: '测试群',
      members: [
        { participantId: DEFAULT_USER_ID, card: '测试用户1', role: 'owner' },
        { participantId: SECONDARY_USER_ID, card: '测试用户2', role: 'admin' },
        { participantId: ADMIN_USER_ID, card: '测试用户3', role: 'member' },
        { participantId: DEFAULT_BOT_ID, card: 'ChatLuna', role: 'admin' },
      ],
      announcements: [{
        id: 'announcement:welcome',
        authorId: DEFAULT_USER_ID,
        content: '欢迎使用测试群验证群聊插件功能',
        createdAt,
      }],
    }],
    conversations: [...directConversations, groupConversation],
    // 默认场景不生成会话实例：实例是复盘手段，不是开箱即用的验证前置条件。
    conversationInstances: [],
    messages: [],
    forwards: [],
    friendships: [
      DEFAULT_USER_ID,
      SECONDARY_USER_ID,
      ADMIN_USER_ID,
    ].map((userId) => createFriendship(userId, DEFAULT_BOT_ID, createdAt)),
    requests: [],
  }
}

function createFriendship(firstId: string, secondId: string, createdAt = new Date().toISOString()): SandboxFriendship {
  const participantIds = [firstId, secondId].sort() as [string, string]
  return {
    id: `friend:${participantIds[0]}:${participantIds[1]}`,
    participantIds,
    remarks: {},
    createdAt,
  }
}

export class SandboxControlService {
  private scene: SandboxSnapshot
  private runtimeBots = new Map<string, SandboxBot>()
  private runtimeBotsActive: boolean
  private runtimeBotRegistry: SandboxRuntimeBotRegistry
  private runtimeOwner = {}
  private botDeliveries: SandboxBotDelivery[] = []
  /**
   * 入站事件会话窗口，由投递模块进出栈，由虚拟 OneBot 机器人读取。
   *
   * 控制服务只负责把同一个实例交给两边，自己不读也不写：读取跟随与会话观察都发生在机器人适配器
   * 那一侧，写入落点不看它，回复照旧落到根会话。
   */
  private inboundEventConversations: InboundEventConversations = createInboundEventConversations()
  /** 投递规则的唯一持有者；三条发送路径与六种事件都经它。 */
  private inboundDelivery: InboundDelivery
  private relationshipActions: RelationshipActions
  private chatLunaState: SandboxChatLunaStateStore
  /**
   * v2 私聊的会话键不看 channelId，根会话与它的实例在 ChatLuna 那里是同一份会话；
   * 由它负责在对话线切换时重置那份会话。
   */
  private chatConversationLines: SandboxChatConversationLines
  /**
   * Koishi 的 channel 受理人与虚拟机器人对不上时，非 @ 的群消息会在中间件之前被静默丢弃；
   * 由它在投递前把受理人对齐，见 {@link SandboxChannelAssignee}。
   */
  private channelAssignee: SandboxChannelAssignee
  private initialScene: SandboxSnapshot
  private oneBotDebug: SandboxOneBotDebugStore
  private mediaStorage: SandboxMediaStorage
  private mediaDirectory: string
  private ownsMediaDirectory: boolean
  private persistence?: SandboxScenePersistence
  private scenePersistenceAuthoritative = true
  private sceneReady = Promise.resolve()
  private resolveSceneReady = () => {}
  private persistenceQueue = Promise.resolve()
  private sceneMutationListeners = new Set<(snapshot: SandboxSnapshot) => void>()
  private debugRecordListeners = new Set<(record: SandboxOneBotDebugRecord) => void>()
  private contextDisposers: Array<() => void> = []
  private disposePromise?: Promise<void>
  private databaseReadyTimeoutMs: number
  private sceneMessageLimit: number
  private sceneMessageMaxBytes: number
  private disposed = false

  constructor(private ctx: Context, options: SandboxControlServiceOptions = {}) {
    this.initialScene = this.normalizeSceneForwards(structuredClone(options.initialScene ?? createDefaultScene()))
    this.scene = structuredClone(this.initialScene)
    this.runtimeBotsActive = options.runtimeActive ?? true
    this.runtimeBotRegistry = options.runtimeBots ?? new SandboxRuntimeBotRegistry()
    this.databaseReadyTimeoutMs = options.databaseReadyTimeoutMs ?? DEFAULT_DATABASE_READY_TIMEOUT_MS
    this.sceneMessageLimit = Math.max(1, Math.trunc(options.sceneMessageLimit ?? DEFAULT_SCENE_MESSAGE_LIMIT))
    this.sceneMessageMaxBytes = Math.max(1, Math.trunc(options.sceneMessageMaxBytes ?? DEFAULT_SCENE_MESSAGE_MAX_BYTES))
    this.persistence = options.persistence
    if (this.persistence) {
      this.sceneReady = new Promise((resolve) => {
        this.resolveSceneReady = resolve
      })
    }
    this.oneBotDebug = new SandboxOneBotDebugStore({
      maxRecords: options.debugRecordLimit,
      maxBytes: options.debugRecordMaxBytes,
      persistence: options.debugPersistence,
    })
    // 内存模式默认使用实例级媒体目录，避免并行测试/多实例共享默认目录时互相 clear 与写冲突。
    // Database 模式仍使用共享目录，以便场景引用在重启后继续命中同一媒体文件。
    // 只有本类自己生成的实例级目录才由本类负责删除；调用方显式传入的目录归调用方管理。
    this.ownsMediaDirectory = !options.mediaDirectory && !this.persistence
    this.mediaDirectory = options.mediaDirectory ?? (
      this.persistence
        ? resolve(resolveBaseDir(ctx), 'data/chatluna/onebot-sandbox/media')
        // 内存模式使用独立目录，避免与 Database 共享 media 目录互相回收。
        : resolve(resolveBaseDir(ctx), 'data/chatluna/onebot-sandbox/ephemeral-media', randomUUID().replaceAll('-', ''))
    )
    this.mediaStorage = new SandboxMediaStorage(this.mediaDirectory)
    // database 服务可能晚于本插件加载，构造时的可用性不可信；数据库模式的清理决策移到 ready 读取场景之后。
    if (!this.persistence) this.mediaStorage.clear()
    this.ensureStableAvatars()
    // 传入的初始场景可能来自更宽上限时期的快照（例如恢复 AI 测试空间），必须先收敛到
    // 当前上限再冻结：initialScene 在上限内是 resetScene 不会写出超限场景的前提。
    this.reclaimSceneMessages()
    // 初始场景在默认头像落盘后再冻结，reset 才能恢复到可显示的实体头像集合。
    this.initialScene = structuredClone(this.scene)
    this.chatLunaState = new SandboxChatLunaStateStore(ctx, (botParticipantId, conversationId) => {
      const participant = this.scene.participants.find(({ id }) => id === botParticipantId)
      return participant?.kind === 'bot' && !!findVisibleConversation(this.scene, botParticipantId, conversationId)
    }, () => this.notifySceneMutation(), (botParticipantId, conversationId, result, messageIds) => {
      this.archiveChatLunaResult(botParticipantId, conversationId, result, messageIds)
    })
    this.chatConversationLines = new SandboxChatConversationLines(() => findChatConversationReset(ctx))
    // database 服务可以晚于本插件加载，因此每次现取；取不到时 Koishi 的受理人判定本身也不生效。
    this.channelAssignee = new SandboxChannelAssignee(async (rows) => {
      // channel 表由 Koishi 兼容层注册，不在本插件的表类型里；只借用 upsert 这一项能力。
      const database: { upsert(table: string, rows: object[]): Promise<unknown> } | undefined = ctx.get('database')
      if (!database) return false
      await database.upsert('channel', [...rows])
      return true
    })
    this.inboundDelivery = createInboundDelivery({
      getRuntimeBot: (botId) => this.runtimeBots.get(botId),
      getBotProfile: (botId) => this.getBots().find(({ id }) => id === botId),
      onMiddlewareFinished: (listener) => ctx.on('middleware', listener),
      recordDebug: (input) => this.recordOneBotDebug(input),
      recordDelivery: (delivery) => this.botDeliveries.push(delivery),
      followInboundConversation: (input) => this.chatConversationLines.followInboundConversation(input),
      alignChannelAssignee: (input) => this.channelAssignee.align(input),
      // 投递模块只认 (消息, 异常) 两参；Cordis 4 的 Logger 会把 Error 格式化成 {}，这里显式带上堆栈。
      logger: {
        warn: (message: string, error?: unknown) => ctx.logger.warn('%s\n%s', message, errorDetail(error)),
        error: (message: string, error?: unknown) => ctx.logger.error('%s\n%s', message, errorDetail(error)),
      },
      eventConversations: this.inboundEventConversations,
    })
    this.relationshipActions = createRelationshipActions({
      commitSceneMutation: () => this.commitSceneMutation(),
      dispatchGroupNotice: (group, noticeType, data) => this.dispatchGroupNotice(group, noticeType, data),
      removeGroupMember: (group, participantId) => this.removeGroupMember(group, participantId),
      removeRelationshipRequest: (requestId) => this.removeRelationshipRequest(requestId),
      addFriendship: (firstId, secondId) => this.addFriendship(firstId, secondId),
      addApprovedGroupMember: ({ group, participantId, operatorId, subType }) => this
        .addApprovedGroupMember(group, participantId, operatorId, subType),
    })
    this.syncRuntimeBots()
    this.contextDisposers.push(onStart(ctx, async () => {
      try {
        await this.restoreScene()
      } finally {
        this.resolveSceneReady()
      }
    }))
    this.contextDisposers.push(onDispose(ctx, () => this.dispose()))
  }

  getSnapshot(): SandboxSnapshot {
    return structuredClone(this.scene)
  }

  onSceneMutation(listener: (snapshot: SandboxSnapshot) => void): () => void {
    this.sceneMutationListeners.add(listener)
    return () => this.sceneMutationListeners.delete(listener)
  }

  // OneBot 调试记录是外部测试控制器判断「插件是否真的调用了某个 action」的唯一事实来源；
  // 广播出去后 MCP 才能把它并入事件流，供 wait_for_onebot_action 等待而不必轮询。
  onOneBotDebugRecord(listener: (record: SandboxOneBotDebugRecord) => void): () => void {
    this.debugRecordListeners.add(listener)
    return () => this.debugRecordListeners.delete(listener)
  }

  setRuntimeActive(active: boolean): void {
    if (active === this.runtimeBotsActive) return
    if (active) {
      for (const bot of this.getBots()) this.runtimeBotRegistry.assertAvailable(bot.id, this.runtimeOwner)
      this.runtimeBotsActive = true
      this.syncRuntimeBots()
      return
    }
    this.runtimeBotsActive = false
    void this.disposeRuntimeBots()
  }

  replaceScene(snapshot: SandboxSnapshot): void {
    const next = structuredClone(snapshot)
    const participantIds = new Set(next.participants.map(({ id }) => id))
    if (participantIds.size !== next.participants.length) throw new SandboxDomainError('参与者 ID 不能重复')
    if (next.participants.some(({ id }) => !/^\d+$/.test(id))) throw new SandboxDomainError('参与者 ID 必须是十进制字符串')
    if (new Set(next.groups.map(({ id }) => id)).size !== next.groups.length) throw new SandboxDomainError('群组 ID 不能重复')
    for (const group of next.groups) {
      if (!group.members.every(({ participantId }) => participantIds.has(participantId))) throw new SandboxDomainError(`群组包含不存在的成员：${group.id}`)
      if (group.members.filter(({ role }) => role === 'owner').length !== 1) throw new SandboxDomainError(`群组必须且只能有一个群主：${group.id}`)
    }
    const groupIds = new Set(next.groups.map(({ id }) => id))
    const messageIds = new Set(next.messages.map(({ id }) => id))
    if (messageIds.size !== next.messages.length) throw new SandboxDomainError('消息 ID 不能重复')
    validateSceneConversations(next, { participantIds, groupIds, messageIds })
    const conversationIds = listConversationIds(next)
    if (next.messages.some(({ authorId, conversationId }) => !participantIds.has(authorId) || !conversationIds.has(conversationId))) throw new SandboxDomainError('消息引用不存在的参与者或会话')
    if (next.messages.some(({ media }) => media?.some(({ id, reference }) => reference !== `sandbox-media://${id}`))) throw new SandboxDomainError('消息包含无效媒体引用')
    // 未发布阶段直接规范化 forwards；缺失时补空数组，避免旧测试快照或半成品导入炸掉。
    this.normalizeSceneForwards(next)
    const forwardIds = new Set(next.forwards!.map(({ id }) => id))
    if (forwardIds.size !== next.forwards!.length) throw new SandboxDomainError('合并转发 ID 不能重复')
    if (next.forwards!.some(({ authorId, nodes }) => !participantIds.has(authorId) || !Array.isArray(nodes) || !nodes.length)) {
      throw new SandboxDomainError('合并转发资源无效')
    }
    if (next.forwards!.some(({ nodes }) => nodes.some(({ media }) => media?.some(({ id, reference }) => reference !== `sandbox-media://${id}`)))) {
      throw new SandboxDomainError('合并转发包含无效媒体引用')
    }
    if (next.forwards!.some(({ nodes }) => nodes.some(({ forwardId }) => !!forwardId && !forwardIds.has(forwardId)))) {
      throw new SandboxDomainError('合并转发引用了不存在的嵌套资源')
    }
    if (next.messages.some(({ forwardId }) => !!forwardId && !forwardIds.has(forwardId))) {
      throw new SandboxDomainError('消息引用了不存在的合并转发资源')
    }
    if (next.friendships.some(({ participantIds: ids }) => !ids.every((id) => participantIds.has(id)))) throw new SandboxDomainError('好友关系引用不存在的参与者')
    if (this.runtimeBotsActive) {
      for (const participant of next.participants) {
        if (participant.kind === 'bot') this.runtimeBotRegistry.assertAvailable(participant.id, this.runtimeOwner)
      }
    }
    // 导入/替换只保留类型化资料字段，避免 raw OneBot JSON 污染领域模型。
    const sanitized = sanitizeSnapshotProfiles(next)
    sanitized.revision = this.scene.revision + 1
    this.scene = sanitized
    this.ensureStableAvatars()
    // 导入的场景同样受保留上限约束，否则一次 import_scene 就能绕过整块落盘的写入上界。
    this.reclaimSceneMessages()
    this.mediaStorage.reclaimUnreferenced(this.getMediaReferences())
    this.botDeliveries = []
    this.chatLunaState.clear()
    this.syncRuntimeBots()
    this.queueScenePersistence()
    this.notifySceneMutation()
  }

  storeMedia(input: { fileName: string; mimeType: string; dataBase64: string }): SandboxMedia {
    const media = this.mediaStorage.save(input)
    // 上传与发送是两步契约（MCP upload_media → send_message）。钉住正文，
    // 否则两步之间的任意场景变更会把尚未被引用的媒体当成孤儿回收。
    this.mediaStorage.pin(media.id)
    return media
  }

  async importAvatar(kind: 'user' | 'bot' | 'group', entityId: string, input?: string): Promise<string | undefined> {
    const value = input?.trim()
    if (!value) return
    if (value.startsWith('sandbox-media://')) return this.requireManagedAvatar(value)
    const dataUrl = value.match(/^data:([^;,]+);base64,(.+)$/s)
    if (dataUrl) return this.saveAvatar(`${kind}-${entityId}-avatar`, dataUrl[1], dataUrl[2])
    if (value.startsWith('base64://')) return this.saveAvatar(`${kind}-${entityId}-avatar.png`, 'image/png', value.slice(9))
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new SandboxDomainError('头像必须是受管媒体引用、Data URL、base64:// 或 HTTP(S) URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SandboxDomainError('头像 URL 仅支持 HTTP(S)')
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new SandboxDomainError(`头像下载失败：HTTP ${response.status}`)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_SIZE) {
      throw new SandboxDomainError('头像大小不能超过 10 MB')
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const content = Buffer.from(await response.arrayBuffer())
    if (content.length > MAX_MEDIA_SIZE) throw new SandboxDomainError('头像大小不能超过 10 MB')
    return this.saveAvatar(`${kind}-${entityId}-avatar`, mimeType, content.toString('base64'))
  }

  private saveAvatar(fileName: string, mimeType: string, dataBase64: string): string {
    if (!mimeType.startsWith('image/')) throw new SandboxDomainError(`头像必须是图片：${mimeType || '未知类型'}`)
    return this.mediaStorage.save({ fileName, mimeType, dataBase64 }).reference
  }

  private ensureStableAvatars(): void {
    for (const participant of this.scene.participants) {
      if (!participant.avatar) {
        participant.avatar = this.createDefaultAvatar(participant.kind)
      } else {
        this.rematerializeBuiltinAvatar(participant.avatar)
      }
    }
    for (const group of this.scene.groups) {
      if (!group.avatar) {
        group.avatar = this.createDefaultAvatar('group')
      } else {
        this.rematerializeBuiltinAvatar(group.avatar)
      }
    }
  }

  private rematerializeBuiltinAvatar(reference: string): boolean {
    if (this.hasManagedAvatar(reference)) return false
    const avatar = findBuiltinAvatarByReference(reference)
    if (!avatar) return false
    const restored = this.saveAvatar(
      `builtin-${avatar.kind}-${avatar.id}.svg`,
      'image/svg+xml',
      Buffer.from(avatar.svg).toString('base64'),
    )
    // 内容寻址必须恢复到原引用；不一致说明内置资源或哈希契约被破坏，不能静默换脸。
    if (restored !== reference) throw new SandboxDomainError(`内置头像引用恢复不一致：${reference}`)
    return true
  }

  private hasManagedAvatar(reference: string): boolean {
    const id = reference.match(/^sandbox-media:\/\/([a-f0-9]{32})$/)?.[1]
    return !!id && this.mediaStorage.exists(id)
  }

  private createDefaultAvatar(kind: 'user' | 'bot' | 'group'): string {
    const pool = BUILTIN_AVATARS[kind]
    const used = new Set(kind === 'group'
      ? this.scene.groups.map(({ avatar }) => avatar).filter((avatar): avatar is string => !!avatar)
      : this.scene.participants
          .filter((participant) => participant.kind === kind && participant.avatar)
          .map((participant) => participant.avatar!))
    // 先按内容寻址引用选出未占用项，再只物化被选中的图片，避免未分配池项成为无主媒体。
    const selected = pickUnusedBuiltinAvatar(
      pool,
      new Set(pool.filter((avatar) => used.has(getBuiltinAvatarReference(avatar)))),
    )
    return this.saveAvatar(
      `builtin-${kind}-${selected.id}.svg`,
      'image/svg+xml',
      Buffer.from(selected.svg).toString('base64'),
    )
  }

  private requireManagedAvatar(reference: string): string {
    const match = reference.match(/^sandbox-media:\/\/([a-f0-9]{32})$/)
    if (!match || !this.mediaStorage.exists(match[1])) throw new SandboxDomainError(`头像媒体不存在：${reference}`)
    const media = this.mediaStorage.readById(match[1])
    if (media.type !== 'image') throw new SandboxDomainError('头像媒体必须是图片')
    return reference
  }

  private normalizeLocalAvatar(kind: 'user' | 'bot' | 'group', entityId: string, input?: string): string {
    const value = input?.trim()
    if (!value) return this.createDefaultAvatar(kind)
    if (value.startsWith('sandbox-media://')) return this.requireManagedAvatar(value)
    const dataUrl = value.match(/^data:([^;,]+);base64,(.+)$/s)
    if (dataUrl) return this.saveAvatar(`${kind}-${entityId}-avatar`, dataUrl[1], dataUrl[2])
    if (value.startsWith('base64://')) return this.saveAvatar(`${kind}-${entityId}-avatar.png`, 'image/png', value.slice(9))
    throw new SandboxDomainError('外部头像 URL 需要先通过 importAvatar 导入受管媒体')
  }

  storeMediaBatch(inputs: Array<{ fileName: string; mimeType: string; dataBase64: string }>): SandboxMedia[] {
    const media: SandboxMedia[] = []
    try {
      for (const input of inputs) media.push(this.storeMedia(input))
      return media
    } catch (error) {
      for (const item of media) this.mediaStorage.remove(item)
      throw error
    }
  }

  async sendStoredMediaMessage(input: Pick<SendMessageInput, 'operatorId' | 'conversationId' | 'content' | 'replyToMessageId'> & { media: SandboxMedia[] }): Promise<SendMessageResult> {
    const context = this.getMessageContext(input)
    const text = input.content.trim()
    const content = text || input.media.map((item) => `[${this.getMediaLabel(item)}] ${item.name}`).join(' ')
    const message = this.appendMessage(input.operatorId, context.conversation.id, content, input.replyToMessageId, input.media)
    const elements = input.media.map((media) => {
      const source = media.type === 'image'
        ? `data:${media.mimeType};base64,${this.mediaStorage.read(media).dataBase64}`
        : media.reference
      return h(media.type === 'image' ? 'img' : media.type, {
        src: source,
        ...(media.type === 'image' ? { url: source } : { file: media.reference }),
        title: media.name,
        mime: media.mimeType,
        size: media.size,
      })
    })
    if (text) elements.push(h.text(text))
    const onebotMessage: Array<{ type: string; data: Record<string, string> }> = input.media.map((media) => ({
      type: media.type === 'audio' ? 'record' : media.type,
      data: { file: media.reference },
    }))
    if (context.reply) onebotMessage.unshift({ type: 'reply', data: { id: String(getOneBotMessageSequence(context.reply.id)) } })
    if (text) onebotMessage.push({ type: 'text', data: { text } })
    const rawMessage = `${context.reply ? `[CQ:reply,id=${getOneBotMessageSequence(context.reply.id)}]` : ''}${input.media.map((media) => `[CQ:${media.type === 'audio' ? 'record' : media.type},file=${media.reference}]`).join('')}${text}`
    await this.dispatchMessageToBots(context, message, elements, onebotMessage, rawMessage)
    return { messageId: message.id, revision: this.scene.revision }
  }

  get bot(): SandboxBot {
    const bot = this.runtimeBots.get(DEFAULT_BOT_ID) ?? this.runtimeBots.values().next().value
    if (!bot) throw new SandboxDomainError('机器人运行时不存在')
    return bot
  }

  getPersistenceStatus(): SandboxPersistenceStatus {
    return this.persistence?.getStatus() ?? {
      mode: 'memory',
      available: true,
      persisted: false,
    }
  }

  /**
   * 取得调试记录库。
   *
   * 「这条记录在不在」「读一页」「清一次」都归记录库自己，本类不再替它转述；这个入口只负责
   * 把记录库交出去。
   */
  getOneBotDebugStore(): SandboxOneBotDebugStore {
    return this.oneBotDebug
  }

  recordOneBotDebug(input: AppendOneBotDebugRecordInput): SandboxOneBotDebugRecord {
    const record = this.oneBotDebug.append(input)
    for (const listener of this.debugRecordListeners) listener(record)
    return record
  }

  waitForSceneReady(): Promise<void> {
    return this.sceneReady
  }

  async waitForPersistence(): Promise<void> {
    await this.sceneReady
    await Promise.all([
      this.oneBotDebug.waitForReady(),
      this.persistenceQueue,
      this.oneBotDebug.waitForPersistence(),
    ])
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async () => {
      for (const dispose of this.contextDisposers.splice(0)) dispose()
      this.chatLunaState.dispose()
      this.sceneMutationListeners.clear()
      this.debugRecordListeners.clear()
      this.runtimeBotsActive = false
      const runtimeDisposal = this.disposeRuntimeBots()
      try {
        await this.waitForPersistence()
      } finally {
        // 实例级临时目录只属于本实例，必须在落盘收尾后同步删除；
        // 否则每次插件重载都会在 data/chatluna/onebot-sandbox/ephemeral-media 下留一个孤儿目录。
        if (this.ownsMediaDirectory) this.mediaStorage.destroy()
      }
      await runtimeDisposal
    })()
    return this.disposePromise
  }

  getMediaDirectory(): string {
    return this.mediaDirectory
  }

  resetScene(): void {
    this.chatLunaState.clear()
    // 清理与场景重置同步入队；收尾等待走 waitForPersistence，不阻塞领域调用方。
    void this.oneBotDebug.clear()
    this.botDeliveries = []
    // 恢复到本实例的初始场景而非全局默认场景：测试空间的初始场景是空白，
    // 直接 createDefaultScene() 会引入默认机器人 20001，与主场景在全局
    // 运行时注册表中的同 ID 机器人冲突，导致空间内 reset 必定失败。
    // initialScene 在构造时已经收敛到保留上限内，因此这里不必再次淘汰。
    // 版本号继续递增而不是回到初始场景的值：expectedRevision 是乐观锁，版本回退会让重置前读到
    // 同一个版本号的过期快照重新通过校验。
    const revision = this.scene.revision + 1
    this.scene = structuredClone(this.initialScene)
    this.scene.revision = revision
    this.ensureStableAvatars()
    this.mediaStorage.reclaimUnreferenced(this.getMediaReferences())
    this.syncRuntimeBots()
    this.queueScenePersistence()
  }

  getBotDeliveries(input: GetSandboxBotDeliveriesInput = {}): SandboxBotDelivery[] {
    return structuredClone(this.botDeliveries.filter(({ messageId }) => (
      !input.messageId || messageId === input.messageId
    )))
  }

  getChatLunaStates(): SandboxChatLunaState[] {
    return this.chatLunaState.getStates()
  }

  getRuntimeBot(botId: string): SandboxBot {
    const bot = this.runtimeBots.get(botId)
    if (!bot) throw new SandboxDomainError(`机器人运行时不存在：${botId}`)
    return bot
  }

  getBotCapabilities(botId: string): SandboxOneBotCapability[] {
    const bot = this.getBots().find(({ id }) => id === botId)
    if (!bot) throw new SandboxDomainError(`机器人不存在：${botId}`)
    return getOneBotCapabilityMatrix(bot.implementation, bot.disabledCapabilities)
  }

  getVisibleSnapshot(operatorId: string, messageLimit = 50): SandboxSnapshot {
    this.getParticipant(operatorId)
    const limit = this.validateMessageLimit(messageLimit)
    const projection = projectVisibleConversations(this.scene, operatorId, limit)
    const messages = this.scene.messages.filter(({ id }) => projection.messageIds.has(id))
    // 只返回当前页消息直接引用的转发资源；嵌套资源由 getForwardMessage 按需读取。
    const visibleForwardIds = new Set(messages.flatMap(({ forwardId }) => forwardId ? [forwardId] : []))
    return structuredClone({
      ...this.scene,
      conversations: projection.conversations,
      conversationInstances: projection.conversationInstances,
      messages,
      forwards: this.getForwards().filter(({ id }) => visibleForwardIds.has(id)),
    })
  }

  getMessageHistory(input: GetMessageHistoryInput): SandboxMessageHistory {
    const conversation = this.getVisibleConversation(input.operatorId, input.conversationId)
    const limit = this.validateMessageLimit(input.limit ?? 50)
    const conversationMessageIds = readConversationMessageIds(this.scene, conversation.id)
    let end = conversationMessageIds.length
    if (input.beforeMessageId) {
      end = conversationMessageIds.indexOf(input.beforeMessageId)
      if (end < 0) throw new SandboxDomainError(`消息不存在：${input.beforeMessageId}`)
    }
    const start = Math.max(0, end - limit)
    const messageIds = conversationMessageIds.slice(start, end)
    const messagesById = new Map(this.scene.messages.map((message) => [message.id, message]))
    const messages = messageIds.flatMap((id) => messagesById.get(id) ?? [])
    // 与 getVisibleSnapshot 一致：历史页只附带直接引用的转发资源，嵌套资源按需读取。
    const visibleForwardIds = new Set(messages.flatMap(({ forwardId }) => forwardId ? [forwardId] : []))
    return {
      messages: structuredClone(messages),
      forwards: structuredClone(this.getForwards().filter(({ id }) => visibleForwardIds.has(id))),
      nextBeforeMessageId: start > 0 ? messageIds[0] : undefined,
    }
  }

  searchConversationMessages(input: SearchConversationMessagesInput): SandboxMessageSearchResult {
    const conversation = this.getVisibleConversation(input.operatorId, input.conversationId)
    const query = input.query.trim()
    const hasStart = input.createdAtStart !== undefined
    const hasEnd = input.createdAtEnd !== undefined
    if (hasStart !== hasEnd) throw new SandboxDomainError('消息日期筛选必须同时提供开始和结束时间')

    let createdAtStart: number | undefined
    let createdAtEnd: number | undefined
    if (hasStart && hasEnd) {
      createdAtStart = Date.parse(input.createdAtStart!)
      createdAtEnd = Date.parse(input.createdAtEnd!)
      if (!Number.isFinite(createdAtStart) || !Number.isFinite(createdAtEnd)) {
        throw new SandboxDomainError('消息日期筛选时间无效')
      }
      if (createdAtStart >= createdAtEnd) throw new SandboxDomainError('消息日期筛选结束时间必须晚于开始时间')
    }
    // 没有任何条件时不能回扫全量消息；仅日期筛选则允许空关键词。
    if (!query && createdAtStart === undefined) return { hits: [] }

    const limit = this.validateMessageLimit(input.limit ?? 50)
    const conversationMessageIds = readConversationMessageIds(this.scene, conversation.id)
    let end = conversationMessageIds.length
    if (input.beforeMessageId) {
      end = conversationMessageIds.indexOf(input.beforeMessageId)
      if (end < 0) throw new SandboxDomainError(`消息不存在：${input.beforeMessageId}`)
    }
    const needle = query.toLocaleLowerCase()
    const messagesById = new Map(this.scene.messages.map((message) => [message.id, message]))
    const hits: SandboxMessageSearchResult['hits'] = []
    // 从新到旧扫描命中；日期必须在游标扫描内过滤，否则分页会漏掉同日的后续消息。
    for (let index = end - 1; index >= 0; index -= 1) {
      const message = messagesById.get(conversationMessageIds[index])
      if (!message) continue
      if (createdAtStart !== undefined) {
        const createdAt = Date.parse(message.createdAt)
        if (!Number.isFinite(createdAt) || createdAt < createdAtStart || createdAt >= createdAtEnd!) continue
      }
      if (query && !message.content.toLocaleLowerCase().includes(needle)) continue
      hits.push({
        messageId: message.id,
        // 按消息实体自身的会话归属报告：在分支里命中继承前缀时报的是那条消息真正所属的来源
        // 会话，而不是被搜索的分支。一条逻辑消息只有一个会话身份。
        conversationId: message.conversationId,
        authorId: message.authorId,
        createdAt: message.createdAt,
        summary: message.content,
      })
      if (hits.length === limit) {
        return {
          hits,
          nextBeforeMessageId: index > 0 ? message.id : undefined,
        }
      }
    }
    return { hits }
  }

  createUser(input: CreateSandboxUserInput): void {
    const id = this.validateParticipantId(input.id)
    const name = this.validateName(input.name, '用户昵称')
    if (this.scene.participants.some((participant) => participant.id === id)) {
      throw new SandboxDomainError(`参与者已存在：${id}`)
    }

    const profile = normalizeAccountProfile(input.profile)
    const avatar = this.normalizeLocalAvatar('user', id, input.avatar)
    this.scene.participants.push({
      kind: 'user',
      id,
      name,
      avatar,
      ...(profile ? { profile } : {}),
    })
    // 环境管理属于测试前置配置，可静默建立关系；WebQQ 用户操作仍必须走好友申请审批。
    for (const bot of this.getBots()) this.addFriendship(id, bot.id)
    this.commitSceneMutation()
  }

  updateUser(input: UpdateSandboxUserInput): void {
    const user = this.getUsers().find(({ id }) => id === input.id)
    if (!user) throw new SandboxDomainError(`用户不存在：${input.id}`)
    const name = this.validateName(input.name, '用户昵称')
    const avatar = input.avatar !== undefined
      ? this.normalizeLocalAvatar('user', user.id, input.avatar)
      : (user.avatar ?? this.createDefaultAvatar('user'))
    let profile = user.profile
    // 头像导入可能失败，先完成所有校验和媒体写入，再修改场景，避免后续成功操作持久化半成品。
    if (input.profile !== undefined) profile = normalizeAccountProfile(input.profile)
    user.name = name
    user.avatar = avatar
    if (profile) user.profile = profile
    else delete user.profile
    this.commitSceneMutation()
  }

  deleteUser(input: DeleteSandboxUserInput): void {
    const index = this.scene.participants.findIndex(({ id, kind }) => id === input.id && kind === 'user')
    if (index < 0) throw new SandboxDomainError(`用户不存在：${input.id}`)
    this.scene.participants.splice(index, 1)
    const ownedGroupIds = new Set(this.scene.groups
      .filter(({ members }) => members.some(({ participantId, role }) => participantId === input.id && role === 'owner'))
      .map(({ id }) => id))
    this.scene.groups = this.scene.groups.filter(({ id }) => !ownedGroupIds.has(id))
    for (const group of this.scene.groups) {
      group.members = group.members.filter(({ participantId }) => participantId !== input.id)
      group.announcements = group.announcements.filter(({ authorId }) => authorId !== input.id)
    }
    this.scene.requests = this.scene.requests.filter(({ requesterId, targetId, groupId }) => requesterId !== input.id
      && targetId !== input.id
      && !ownedGroupIds.has(groupId ?? ''))
    this.scene.friendships = this.scene.friendships.filter(({ participantIds }) => !participantIds.includes(input.id))
    this.deleteConversations((conversation) => conversation.type === 'direct'
      ? !!conversation.participantIds?.includes(input.id)
      : ownedGroupIds.has(conversation.groupId ?? ''))
    this.commitSceneMutation()
  }

  createBot(input: CreateSandboxBotInput): void {
    const id = this.validateParticipantId(input.id)
    const name = this.validateName(input.name, '机器人昵称')
    if (this.scene.participants.some((participant) => participant.id === id)) {
      throw new SandboxDomainError(`参与者已存在：${id}`)
    }
    if (this.runtimeBotsActive) this.runtimeBotRegistry.assertAvailable(id, this.runtimeOwner)

    const disabledCapabilities = normalizeDisabledCapabilities(input.implementation, input.disabledCapabilities)
    const profile = normalizeAccountProfile(input.profile)
    const avatar = this.normalizeLocalAvatar('bot', id, input.avatar)
    this.scene.participants.push({
      kind: 'bot',
      id,
      name,
      avatar,
      implementation: input.implementation,
      enabled: input.enabled,
      ...(disabledCapabilities ? { disabledCapabilities } : {}),
      ...(profile ? { profile } : {}),
    })
    this.createRuntimeBot({
      selfId: id,
      name,
      avatar,
      implementation: input.implementation,
      disabledCapabilities,
    })
    for (const participant of this.scene.participants) {
      if (participant.id !== id) this.addFriendship(participant.id, id)
    }
    this.commitSceneMutation()
  }

  updateBot(input: UpdateSandboxBotInput): void {
    const bot = this.getBots().find(({ id }) => id === input.id)
    if (!bot) throw new SandboxDomainError(`机器人不存在：${input.id}`)
    const name = this.validateName(input.name, '机器人昵称')
    const avatar = input.avatar !== undefined
      ? this.normalizeLocalAvatar('bot', bot.id, input.avatar)
      : (bot.avatar ?? this.createDefaultAvatar('bot'))
    const disabledCapabilities = normalizeDisabledCapabilities(input.implementation, input.disabledCapabilities)
    let profile = bot.profile
    if (input.profile !== undefined) profile = normalizeAccountProfile(input.profile)
    bot.name = name
    bot.avatar = avatar
    bot.implementation = input.implementation
    bot.enabled = input.enabled
    if (disabledCapabilities) bot.disabledCapabilities = disabledCapabilities
    else delete bot.disabledCapabilities
    if (profile) bot.profile = profile
    else delete bot.profile
    const runtime = this.runtimeBots.get(bot.id)
    if (runtime) {
      runtime.user = { id: bot.id, name: bot.name, avatar: bot.avatar }
      runtime.status = bot.enabled ? 1 : 0
      runtime.updateImplementation(bot.implementation, bot.disabledCapabilities)
    }
    this.commitSceneMutation()
  }

  async updateBotSelfProfile(botId: string, input: {
    name?: string
    avatar?: string
    personalNote?: string
    sex?: SandboxAccountSex
  }) {
    const bot = this.getBots().find(({ id }) => id === botId)
    if (!bot) throw new SandboxDomainError(`机器人不存在：${botId}`)
    const name = input.name !== undefined ? this.validateName(input.name, '机器人昵称') : bot.name
    const avatar = input.avatar !== undefined
      ? (await this.importAvatar('bot', bot.id, input.avatar) ?? this.createDefaultAvatar('bot'))
      : (bot.avatar ?? this.createDefaultAvatar('bot'))
    const profile = input.personalNote !== undefined || input.sex !== undefined
      ? mergeAccountProfile(bot.profile, {
        ...(input.personalNote !== undefined ? { personalNote: input.personalNote } : {}),
        ...(input.sex !== undefined ? { sex: input.sex } : {}),
      })
      : bot.profile
    bot.name = name
    bot.avatar = avatar
    if (profile) bot.profile = profile
    else delete bot.profile
    const runtime = this.getRuntimeBot(botId)
    runtime.user = { id: bot.id, name: bot.name, avatar: bot.avatar }
    this.commitSceneMutation()
    return { status: 'ok', retcode: 0, data: null }
  }

  deleteBot(input: DeleteSandboxBotInput): void {
    const index = this.scene.participants.findIndex(({ id, kind }) => id === input.id && kind === 'bot')
    if (index < 0) throw new SandboxDomainError(`机器人不存在：${input.id}`)
    this.chatLunaState.deleteByBotParticipant(input.id)
    this.scene.participants.splice(index, 1)
    const runtime = this.runtimeBots.get(input.id)
    this.runtimeBots.delete(input.id)
    if (runtime) {
      this.runtimeBotRegistry.release(input.id, this.runtimeOwner)
      void runtime.dispose()
    }
    const ownedGroupIds = new Set(this.scene.groups
      .filter(({ members }) => members.some(({ participantId, role }) => participantId === input.id && role === 'owner'))
      .map(({ id }) => id))
    this.scene.groups = this.scene.groups.filter(({ id }) => !ownedGroupIds.has(id))
    for (const group of this.scene.groups) {
      group.members = group.members.filter(({ participantId }) => participantId !== input.id)
      group.announcements = group.announcements.filter(({ authorId }) => authorId !== input.id)
    }
    this.scene.requests = this.scene.requests.filter(({ requesterId, targetId, groupId }) => requesterId !== input.id
      && targetId !== input.id
      && !ownedGroupIds.has(groupId ?? ''))
    this.scene.friendships = this.scene.friendships.filter(({ participantIds }) => !participantIds.includes(input.id))
    this.deleteConversations((conversation) => conversation.type === 'direct'
      ? !!conversation.participantIds?.includes(input.id)
      : ownedGroupIds.has(conversation.groupId ?? ''))
    this.commitSceneMutation()
  }

  createGroup(input: CreateSandboxGroupInput): void {
    const id = this.validateGroupId(input.id)
    if (this.scene.groups.some((group) => group.id === id)) throw new SandboxDomainError(`群组已存在：${id}`)
    const members = this.validateGroupMembers(input.members)
    this.scene.groups.push({
      id,
      name: this.validateName(input.name, '群名称'),
      avatar: this.normalizeLocalAvatar('group', id, input.avatar),
      members,
      announcements: [],
    })
    this.syncGroupConversations(id)
    this.commitSceneMutation()
  }

  updateGroup(input: UpdateSandboxGroupInput): void {
    const group = this.scene.groups.find(({ id }) => id === input.id)
    if (!group) throw new SandboxDomainError(`群组不存在：${input.id}`)
    const name = this.validateName(input.name, '群名称')
    const avatar = input.avatar !== undefined
      ? this.normalizeLocalAvatar('group', group.id, input.avatar)
      : (group.avatar ?? this.createDefaultAvatar('group'))
    const members = this.validateGroupMembers(input.members)
    group.name = name
    group.avatar = avatar
    group.members = members
    this.syncGroupConversations(group.id)
    this.commitSceneMutation()
  }

  deleteGroup(input: DeleteSandboxGroupInput): void {
    const index = this.scene.groups.findIndex(({ id }) => id === input.id)
    if (index < 0) throw new SandboxDomainError(`群组不存在：${input.id}`)
    this.scene.groups.splice(index, 1)
    this.scene.requests = this.scene.requests.filter(({ groupId }) => groupId !== input.id)
    this.deleteConversations((conversation) => conversation.groupId === input.id)
    this.commitSceneMutation()
  }

  async performFriendAction(input: PerformFriendActionInput): Promise<PerformFriendActionResult> {
    if (this.isBot(input.operatorId)) {
      const bot = this.getBots().find(({ id }) => id === input.operatorId)!
      if (!bot.enabled) throw new SandboxDomainError(`机器人已停用：${bot.id}`)
    }
    if (this.isBot(input.operatorId) && input.action === 'handle-request') {
      const request = this.scene.requests.find(({ id, type }) => id === input.requestId && type === 'friend')
      if (!request || request.targetId !== input.operatorId) throw new SandboxDomainError(`好友申请不存在：${input.requestId}`)
      await this.getRuntimeBot(input.operatorId).internal.set_friend_add_request({
        flag: input.requestId,
        approve: input.approve,
      })
      return { revision: this.scene.revision }
    }
    this.getParticipant(input.operatorId)
    if (input.action === 'handle-request') {
      return this.handleUserRelationshipRequest(input)
    }

    const target = this.getParticipant(input.targetId)
    if (target.id === input.operatorId) throw new SandboxDomainError('不能对自己执行好友操作')
    const friendship = this.getFriendship(input.operatorId, target.id)

    if (input.action === 'request') {
      if (friendship) throw new SandboxDomainError('已经是好友关系')
      if (this.scene.requests.some(({ type, requesterId, targetId }) => type === 'friend'
        && ((requesterId === input.operatorId && targetId === target.id)
          || (requesterId === target.id && targetId === input.operatorId)))) {
        throw new SandboxDomainError('双方已有待处理的好友申请')
      }
      const request = {
        id: `request:friend:${Random.id()}`,
        type: 'friend' as const,
        requesterId: input.operatorId,
        targetId: target.id,
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
        comment: input.comment?.trim() || undefined,
      }
      this.scene.requests.push(request)
      this.commitSceneMutation()
      if (this.isBot(target.id)) await this.dispatchFriendRequest(target.id, input.operatorId, request.id, request.comment)
      return { revision: this.scene.revision, requestId: request.id }
    }

    if (!friendship) throw new SandboxDomainError('好友关系不存在')
    if (input.action === 'set-remark') {
      this.applyFriendRemark(friendship, input.operatorId, input.remark)
      return { revision: this.scene.revision }
    }

    if (input.action === 'poke') {
      if (this.isBot(target.id)) await this.dispatchBotNotice(target.id, input.operatorId, 'notify')
      const conversation = input.conversationId
        ? this.getVisibleConversation(input.operatorId, input.conversationId)
        : findDirectRootConversation(this.scene, input.operatorId, target.id)
      if (!conversation) throw new SandboxDomainError('戳一戳必须在可见会话中发起')
      const group = conversation.groupId
        ? this.scene.groups.find(({ id }) => id === conversation.groupId)
        : undefined
      if (group && !group.members.some(({ participantId }) => participantId === target.id)) {
        throw new SandboxDomainError('目标用户不在当前群组中')
      }
      if (!group && (conversation.type !== 'direct' || !conversation.participantIds?.includes(target.id))) {
        throw new SandboxDomainError('目标用户不在当前私聊中')
      }
      const getDisplayName = (participantId: string) => group?.members.find((member) => member.participantId === participantId)?.card
        || this.getParticipant(participantId).name
      this.appendMessage(
        input.operatorId,
        conversation.id,
        `${getDisplayName(input.operatorId)} 戳了戳 ${getDisplayName(target.id)}`,
        undefined,
        undefined,
        { type: 'poke', targetId: target.id },
      )
      return { revision: this.scene.revision }
    }

    if (input.action !== 'delete') throw new SandboxDomainError(`不支持的好友操作：${Reflect.get(input, 'action') ?? 'unknown'}`)

    this.scene.friendships = this.scene.friendships.filter(({ id }) => id !== friendship.id)
    if (this.isBot(target.id)) {
      await this.dispatchBotNotice(target.id, input.operatorId, 'friend_del')
    }
    this.commitSceneMutation()
    return { revision: this.scene.revision }
  }

  async performGroupAction(input: PerformGroupActionInput): Promise<PerformGroupActionResult> {
    // 机器人处理协议能力覆盖的群操作时必须经过自身 OneBot action，确保事件中的 self_id 与实际机器人一致。
    // 主动申请入群等沙盒参与者操作则继续落到下方统一路径，避免 WebQQ 因操作者种类出现行为差异。
    if (this.isBot(input.operatorId)) {
      const bot = this.getBots().find(({ id }) => id === input.operatorId)!
      if (!bot.enabled) throw new SandboxDomainError(`机器人已停用：${bot.id}`)
      const runtime = this.getRuntimeBot(bot.id)
      if (input.action === 'handle-request') {
        const request = this.scene.requests.find(({ id, type }) => id === input.requestId && type === 'group')
        if (!request) throw new SandboxDomainError(`群申请不存在：${input.requestId}`)
        await runtime.internal.set_group_add_request({
          flag: input.requestId,
          sub_type: request.subType ?? 'add',
          approve: input.approve,
        })
        return { revision: this.scene.revision }
      }
      if (input.action === 'kick') {
        await runtime.internal._request('set_group_kick', { group_id: input.groupId, user_id: input.targetId })
        return { revision: this.scene.revision }
      }
      if (input.action === 'set-admin') {
        await runtime.internal._request('set_group_admin', { group_id: input.groupId, user_id: input.targetId, enable: input.enabled })
        return { revision: this.scene.revision }
      }
      if (input.action === 'transfer-owner') {
        // WebQQ 的群主转让是“当前操作者”的客户端行为，不应伪造为 NapCat/LLBot 均不存在的原始 action。
        // 直接进入统一领域操作，仍会以该机器人身份执行权限检查和状态变更。
        await this.performBotGroupAction(bot.id, {
          action: 'transfer-owner',
          groupId: input.groupId,
          targetId: input.targetId,
        })
        return { revision: this.scene.revision }
      }
      if (input.action === 'set-card') {
        await runtime.internal._request('set_group_card', { group_id: input.groupId, user_id: input.targetId, card: input.card })
        return { revision: this.scene.revision }
      }
      if (input.action === 'set-title') {
        await runtime.internal._request('set_group_special_title', { group_id: input.groupId, user_id: input.targetId, special_title: input.title })
        return { revision: this.scene.revision }
      }
      if (input.action === 'set-name') {
        await runtime.internal._request('set_group_name', { group_id: input.groupId, group_name: input.name })
        return { revision: this.scene.revision }
      }
    }
    this.getParticipant(input.operatorId)
    if (input.action === 'handle-request') return this.handleUserGroupRequest(input)

    const group = this.scene.groups.find(({ id }) => id === input.groupId)
    if (!group) throw new SandboxDomainError(`群组不存在：${input.groupId}`)

    if (input.action === 'request-join') {
      if (group.members.some(({ participantId }) => participantId === input.operatorId)) throw new SandboxDomainError('已经是群成员')
      if (this.scene.requests.some(({ type, subType, requesterId, groupId }) => type === 'group'
        && (subType ?? 'add') === 'add' && requesterId === input.operatorId && groupId === group.id)) {
        throw new SandboxDomainError('已有待处理的入群申请')
      }
      const request = {
        id: `request:group:${Random.id()}`,
        type: 'group' as const,
        subType: 'add' as const,
        requesterId: input.operatorId,
        groupId: group.id,
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
        comment: input.comment?.trim() || undefined,
      }
      this.scene.requests.push(request)
      this.commitSceneMutation()
      await this.dispatchGroupRequest(group, request)
      return { revision: this.scene.revision, requestId: request.id }
    }

    const actor = this.requireGroupMember(group, input.operatorId)
    if (input.action === 'invite') {
      const target = this.getParticipant(input.targetId)
      if (group.members.some(({ participantId }) => participantId === target.id)) throw new SandboxDomainError('目标已经是群成员')
      // 与 QQ 一致：只能从自己的好友里挑人邀请，非好友只能自己按群号申请入群。
      if (!this.getFriendship(input.operatorId, target.id)) throw new SandboxDomainError(`只能邀请好友入群：${target.id} 不是 ${input.operatorId} 的好友`)
      if (this.scene.requests.some(({ type, subType, targetId, groupId }) => type === 'group'
        && subType === 'invite' && targetId === target.id && groupId === group.id)) {
        throw new SandboxDomainError('已有待处理的群邀请')
      }
      const request = {
        id: `request:group:${Random.id()}`,
        type: 'group' as const,
        subType: 'invite' as const,
        requesterId: input.operatorId,
        targetId: target.id,
        groupId: group.id,
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
        comment: input.comment?.trim() || undefined,
      }
      this.scene.requests.push(request)
      this.commitSceneMutation()
      await this.dispatchGroupRequest(group, request)
      return { revision: this.scene.revision, requestId: request.id }
    }

    if (input.action === 'leave') {
      const denial = await this.relationshipActions.leaveGroup({ group, actor })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'leave'))
      return { revision: this.scene.revision }
    }

    if (input.action === 'set-name') {
      const denial = await this.relationshipActions.renameGroup({ group, actor, name: input.name })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-name'))
      return { revision: this.scene.revision }
    }

    const target = this.requireGroupMember(group, input.targetId)
    if (input.action === 'kick') {
      const denial = await this.relationshipActions.kickGroupMember({ group, actor, target })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'kick'))
      return { revision: this.scene.revision }
    }

    if (input.action === 'set-admin') {
      const denial = await this.relationshipActions.setGroupAdmin({ group, actor, target, enabled: input.enabled })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-admin'))
      return { revision: this.scene.revision }
    }

    if (input.action === 'transfer-owner') {
      const denial = await this.relationshipActions.transferGroupOwner({ group, actor, target })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'transfer-owner'))
      return { revision: this.scene.revision }
    }

    if (input.action === 'set-card') {
      const denial = await this.relationshipActions.setGroupCard({ group, actor, target, card: input.card })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-card'))
      return { revision: this.scene.revision }
    }

    if (input.action === 'set-title') {
      const denial = this.relationshipActions.setGroupMemberTitle({ actor, target, title: input.title })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-title'))
      return { revision: this.scene.revision }
    }

    if (input.action !== 'poke') throw new SandboxDomainError(`不支持的群组操作：${Reflect.get(input, 'action') ?? 'unknown'}`)
    const conversation = input.conversationId
      ? this.getVisibleConversation(input.operatorId, input.conversationId)
      : findGroupRootConversation(this.scene, group.id)
    if (!conversation || conversation.groupId !== group.id) throw new SandboxDomainError('群内戳一戳必须在当前群会话中发起')
    await this.dispatchGroupNotice(group, 'notify', {
      sub_type: 'poke',
      user_id: Number(input.operatorId),
      target_id: Number(target.participantId),
    })
    const getDisplayName = (participantId: string) => group.members.find((member) => member.participantId === participantId)?.card
      || this.getParticipant(participantId).name
    this.appendMessage(
      input.operatorId,
      conversation.id,
      `${getDisplayName(input.operatorId)} 戳了戳 ${getDisplayName(target.participantId)}`,
      undefined,
      undefined,
      { type: 'poke', targetId: target.participantId },
    )
    return { revision: this.scene.revision }
  }

  async handleBotFriendRequest(botId: string, input: { flag: string; approve: boolean; remark?: string }) {
    if (!this.isBot(botId)) throw new SandboxDomainError(`机器人不存在：${botId}`)
    // 机器人通道按「发给自己的好友申请」查找；用户通道没有这个条件，两条通道的输入本来就不同。
    const request = this.scene.requests.find(({ id, type, targetId }) => id === input.flag && type === 'friend' && targetId === botId)
    if (!request) throw new SandboxDomainError(`好友申请不存在：${input.flag}`)
    this.relationshipActions.settleFriendRequest({
      requestId: request.id,
      requesterId: request.requesterId,
      targetId: botId,
      approve: input.approve,
      // 备注只有机器人通道支持：`set_friend_add_request` 带 remark，用户通道没有这个参数。
      onApproved: (friendship) => {
        const remark = input.remark?.trim()
        if (remark) friendship.remarks[botId] = remark
      },
    })
    return { status: 'ok', retcode: 0, data: null }
  }

  async handleBotGroupRequest(botId: string, input: { flag: string; subType: 'add' | 'invite'; approve: boolean; reason?: string }) {
    if (!this.isBot(botId)) throw new SandboxDomainError(`机器人不存在：${botId}`)
    // 机器人通道按 OneBot 的子类型语义查找：调用方必须传子类型，传错就当找不到这条申请。
    const request = this.scene.requests.find(({ id, type, subType }) => id === input.flag
      && type === 'group' && (subType ?? 'add') === input.subType)
    if (!request) throw new SandboxDomainError(`群申请不存在：${input.flag}`)
    const group = this.scene.groups.find(({ id }) => id === request.groupId)
    if (!group) throw new SandboxDomainError(`群组不存在：${request.groupId}`)

    if (input.subType === 'invite') {
      if (request.targetId !== botId) throw new SandboxDomainError('只能处理发给自己的群邀请')
    } else if (denyGroupAuthority(this.requireGroupMember(group, botId))) {
      // 与用户通道同一道角色判定，只有措辞不同：机器人通道这句已被按文案断言，逐字保留。
      throw new SandboxDomainError('机器人没有审批入群申请的权限')
    }

    await this.relationshipActions.settleGroupRequest({
      group,
      requestId: request.id,
      participantId: input.subType === 'invite' ? botId : request.requesterId,
      operatorId: input.subType === 'invite' ? request.requesterId : botId,
      subType: input.subType,
      approve: input.approve,
    })
    return { status: 'ok', retcode: 0, data: null }
  }

  deleteBotFriend(botId: string, userId: string): void {
    const friendship = this.getFriendship(botId, userId)
    if (!friendship) throw new SandboxDomainError('好友关系不存在')
    this.scene.friendships = this.scene.friendships.filter(({ id }) => id !== friendship.id)
    this.commitSceneMutation()
  }

  /**
   * 机器人通道的好友动作，与 {@link performBotGroupAction} 对称。
   *
   * 备注写入落到与用户通道同一段规则上（{@link applyFriendRemark}）：仓库里只有一份「非空写入、
   * 空串删除」的判定，两条通道因此不会漂移。拒绝的三句文案也与用户通道逐字相同。
   */
  performBotFriendAction(botId: string, input: { action: 'set-remark'; targetId: string; remark: string }) {
    if (!this.isBot(botId)) throw new SandboxDomainError(`机器人不存在：${botId}`)
    const target = this.getParticipant(input.targetId)
    if (target.id === botId) throw new SandboxDomainError('不能对自己执行好友操作')
    const friendship = this.getFriendship(botId, target.id)
    if (!friendship) throw new SandboxDomainError('好友关系不存在')
    this.applyFriendRemark(friendship, botId, input.remark)
    return { status: 'ok', retcode: 0, data: null }
  }

  /**
   * 好友备注的写入规则，两条通道唯一一份。
   *
   * 空串表示清除而不是写入空串：那是两种实现配置的真实语义（`set_friend_remark` 的 `remark`
   * 默认空串），也是 `get_friend_list` 的 `nick` 能回落空串的前提。
   */
  private applyFriendRemark(friendship: SandboxFriendship, operatorId: string, remark: string): void {
    const next = remark.trim()
    if (next) friendship.remarks[operatorId] = next
    else delete friendship.remarks[operatorId]
    this.commitSceneMutation()
  }

  async performBotGroupAction(botId: string, input:
  | { action: 'kick'; groupId: string; targetId: string }
  | { action: 'set-admin'; groupId: string; targetId: string; enabled: boolean }
  | { action: 'transfer-owner'; groupId: string; targetId: string }
  | { action: 'set-card'; groupId: string; targetId: string; card: string }
  | { action: 'set-title'; groupId: string; targetId: string; title: string }
  | { action: 'set-ban'; groupId: string; targetId: string; durationSeconds: number }
  | { action: 'set-name'; groupId: string; name: string }
  | { action: 'leave'; groupId: string }) {
    const group = this.scene.groups.find(({ id }) => id === input.groupId)
    if (!group) throw new SandboxDomainError(`群组不存在：${input.groupId}`)
    const actor = this.requireGroupMember(group, botId)

    if (input.action === 'leave') {
      const denial = await this.relationshipActions.leaveGroup({ group, actor })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'leave'))
      return { status: 'ok', retcode: 0, data: null }
    }

    if (input.action === 'set-name') {
      const denial = await this.relationshipActions.renameGroup({ group, actor, name: input.name })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-name'))
      return { status: 'ok', retcode: 0, data: null }
    }

    const target = this.requireGroupMember(group, input.targetId)
    if (input.action === 'kick') {
      const denial = await this.relationshipActions.kickGroupMember({ group, actor, target })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'kick'))
      return { status: 'ok', retcode: 0, data: null }
    }

    if (input.action === 'set-admin') {
      const denial = await this.relationshipActions.setGroupAdmin({ group, actor, target, enabled: input.enabled })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-admin'))
      return { status: 'ok', retcode: 0, data: null }
    }

    if (input.action === 'transfer-owner') {
      const denial = await this.relationshipActions.transferGroupOwner({ group, actor, target })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'transfer-owner'))
      return { status: 'ok', retcode: 0, data: null }
    }

    if (input.action === 'set-title') {
      const denial = this.relationshipActions.setGroupMemberTitle({ actor, target, title: input.title })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-title'))
      return { status: 'ok', retcode: 0, data: null }
    }

    if (input.action === 'set-ban') {
      const { durationSeconds } = input
      const denial = this.relationshipActions.muteGroupMember({ actor, target, durationSeconds })
      if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, durationSeconds > 0 ? 'mute' : 'unmute'))
      return { status: 'ok', retcode: 0, data: null }
    }

    const denial = await this.relationshipActions.setGroupCard({ group, actor, target, card: input.card })
    if (denial) throw new SandboxDomainError(describeGroupActionDenial(denial, 'set-card'))
    return { status: 'ok', retcode: 0, data: null }
  }

  /**
   * 在某个联系人或群组下新建一个空白会话实例。
   *
   * 传入会话实例时归一化到它的根会话：层级严格两层。可见性完全继承根会话，因此这里只要求
   * 目标会话对操作者可见，不引入所有权维度。
   */
  createConversationInstance(input: CreateConversationInstanceInput): { conversationId: string, revision: number } {
    const target = this.getVisibleConversation(input.operatorId, input.rootConversationId)
    const instance = insertConversationInstance(this.scene, {
      id: Random.id(),
      rootConversationId: target.rootConversationId,
      title: input.title?.trim() || DEFAULT_CONVERSATION_INSTANCE_TITLE,
    })
    this.commitSceneMutation()
    return { conversationId: instance.id, revision: this.scene.revision }
  }

  /**
   * 从某条消息分叉出一个会话实例：新实例只记下「来源会话 + 分叉点消息」，一条消息都不复制。
   *
   * 因此创建瞬间完成、与历史长短无关，同一段历史开多少个分支都不占额外的场景消息额度。
   * 分支的历史 = 来源会话里分叉点及其之前的那一段，加上分支自己的消息，由
   * {@link readConversationMessageIds} 在读取时拼接。来源可以是另一个实例，存储层级仍是两层。
   */
  branchConversationInstance(input: BranchConversationInstanceInput): { conversationId: string, revision: number } {
    const source = this.getVisibleConversation(input.operatorId, input.conversationId)
    if (!readConversationMessageIds(this.scene, source.id).includes(input.messageId)) {
      throw new SandboxDomainError(`消息不存在：${input.messageId}`)
    }
    const message = this.scene.messages.find(({ id }) => id === input.messageId)
    if (!message) throw new SandboxDomainError(`消息不存在：${input.messageId}`)
    // 事件消息不是可操作的消息，因此不能当分叉点；判据与右键菜单同一份。
    if (denyMessageCapability('branch', this.toMessageCapabilityInput(message, source, input.operatorId))) {
      throw new SandboxDomainError(`事件消息不能作为分叉点：${input.messageId}`)
    }
    const instance = insertConversationInstance(this.scene, {
      id: Random.id(),
      rootConversationId: source.rootConversationId,
      title: input.title?.trim() || `分支：${this.describeConversation(input.operatorId, source)}`,
      forkPoint: { conversationId: source.id, messageId: input.messageId },
    })
    this.commitSceneMutation()
    return { conversationId: instance.id, revision: this.scene.revision }
  }

  /**
   * 给一个会话实例改名。目标是根会话时按「会话实例不存在」拒绝：根会话的名字由参与者关系
   * 与群组决定，改名不是它的合法操作。
   */
  renameConversationInstance(input: RenameConversationInstanceInput): { revision: number } {
    const target = this.getVisibleConversation(input.operatorId, input.conversationId)
    renameInstanceTitle(this.scene, target.id, input.title)
    this.commitSceneMutation()
    return { revision: this.scene.revision }
  }

  /**
   * 删除一个会话实例，连带清理它的消息、失去引用的合并转发资源以及不再被任何引用持有的媒体。
   *
   * 根会话不提供这条路径：它的存在由参与者关系与群组决定，解除关系或解散群组才是让它消失的
   * 手段，那条路径由 {@link deleteConversations} 承担。
   */
  deleteConversationInstance(input: DeleteConversationInstanceInput): { revision: number } {
    const target = this.getVisibleConversation(input.operatorId, input.conversationId)
    this.cascadeRemovedConversations(removeConversationInstance(this.scene, target.id))
    this.commitSceneMutation()
    return { revision: this.scene.revision }
  }

  /** 会话的人类可读名称：实例用自己的标题，群聊用群名称，私聊用对端昵称。 */
  private describeConversation(operatorId: string, conversation: ResolvedConversation): string {
    if (conversation.title) return conversation.title
    if (conversation.type === 'group') {
      return this.scene.groups.find(({ id }) => id === conversation.groupId)?.name ?? conversation.id
    }
    const peerId = resolveConversationPeerId(conversation, operatorId)
    return peerId ? this.getParticipant(peerId).name : conversation.id
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const { result, delivery } = this.startMessageSend(input)
    await delivery
    return { ...result, revision: this.scene.revision }
  }

  // 同步完成校验与消息落库并立即返回，机器人投递在后台继续；
  // WebQQ 依赖此方法让用户消息即时显示，不被插件处理时长（如图片渲染）阻塞。
  startMessageSend(input: SendMessageInput): { result: SendMessageResult; delivery: Promise<void> } {
    if (!input.content.trim()) throw new SandboxDomainError('消息内容不能为空')
    const context = this.getMessageContext(input)
    const message = this.appendMessage(input.operatorId, context.conversation.id, input.content.trim(), input.replyToMessageId)
    const elements = h.parse(message.content)
    const onebotMessage = [
      ...(context.reply ? [{ type: 'reply', data: { id: String(getOneBotMessageSequence(context.reply.id)) } }] : []),
      ...toOneBotMessageSegments(message.content),
    ]
    const delivery = this.dispatchMessageToBots(context, message, elements, onebotMessage, toOneBotRawMessage(onebotMessage))
    return { result: { messageId: message.id, revision: this.scene.revision }, delivery }
  }

  // WebQQ 多选与 OneBot send_forward_msg 共用同一领域 builder。
  // 机器人操作者必须走自身 OneBot action，保持能力禁用、调试记录与真实操作通道一致。
  async sendForwardMessage(input: SendForwardMessageInput): Promise<SendForwardMessageResult> {
    if (this.isBot(input.operatorId)) {
      const bot = this.getBots().find(({ id }) => id === input.operatorId)!
      if (!bot.enabled) throw new SandboxDomainError(`机器人已停用：${bot.id}`)
      const conversation = this.getVisibleConversation(input.operatorId, input.conversationId)
      const params: Record<string, unknown> = {
        messages: this.toOneBotForwardNodePayloads(this.buildForwardNodes(input)),
      }
      if (conversation.type === 'group') params.group_id = Number(conversation.groupId)
      else params.user_id = Number(resolveConversationPeerId(conversation, input.operatorId))
      const result = await this.getRuntimeBot(bot.id).internal._request('send_forward_msg', params) as {
        data?: { message_id?: number | string; forward_id?: string; res_id?: string }
      }
      const messageId = resolveOneBotMessageId(bot.implementation, result?.data?.message_id, this.scene.messages.map(({ id }) => id))
        ?? String(result?.data?.message_id ?? '')
      const message = this.scene.messages.find(({ id }) => id === messageId)
      const forwardId = message?.forwardId
        ?? (typeof result?.data?.forward_id === 'string' ? result.data.forward_id : undefined)
        ?? (typeof result?.data?.res_id === 'string' ? result.data.res_id : undefined)
      if (!message || !forwardId) throw new SandboxDomainError('合并转发发送失败：未返回有效资源')
      return { messageId: message.id, forwardId, revision: this.scene.revision }
    }
    const { result, delivery } = this.startForwardMessage(input)
    // WebQQ 必须即时收到外层消息结果；机器人投递继续在后台进行。
    void delivery.catch(() => {})
    return result
  }

  // MCP 可等待该入口的 delivery，保证同步回复已进入发送前 cursor 对应的事件流；
  // WebQQ 与 OneBot action 则只消费 result，并让投递在后台继续。
  startForwardMessage(input: SendForwardMessageInput): { result: SendForwardMessageResult; delivery: Promise<void> } {
    const context = this.getMessageContext({
      operatorId: input.operatorId,
      conversationId: input.conversationId,
    })
    const nodes = this.buildForwardNodes(input)
    const title = this.resolveForwardTitle(input)
    const forward: SandboxForward = {
      id: Random.id(),
      authorId: context.operator.id,
      createdAt: new Date().toISOString(),
      ...(title ? { title } : {}),
      nodes,
    }
    this.getForwards().push(forward)
    const content = this.formatForwardPreview(nodes)
    const message = this.appendMessage(context.operator.id, context.conversation.id, content, undefined, undefined, undefined, undefined, forward.id)
    const onebotMessage = [{ type: 'forward', data: { id: forward.id } }]
    const delivery = this.dispatchMessageToBots(
      context,
      message,
      [h('forward', { id: forward.id })],
      onebotMessage,
      toOneBotRawMessage(onebotMessage),
    )
    return {
      result: { messageId: message.id, forwardId: forward.id, revision: this.scene.revision },
      delivery,
    }
  }

  // bot action 与用户交互最终都落到这里，保证场景转发资源唯一。
  async applyForwardMessage(input: SendForwardMessageInput): Promise<SendForwardMessageResult> {
    const { result, delivery } = this.startForwardMessage(input)
    // OneBot action 返回前不等待目标插件处理，避免机器人向自身会话发送时形成调用环。
    void delivery.catch(() => {})
    return result
  }

  getForwardMessage(input: GetForwardMessageInput): SandboxForward {
    this.getParticipant(input.operatorId)
    const forwardId = input.forwardId?.trim()
      || this.resolveForwardIdFromMessage(input.operatorId, input.messageId)
    if (!forwardId) throw new SandboxDomainError('缺少合并转发 ID')
    const forward = this.getForwards().find(({ id }) => id === forwardId)
    if (!forward) throw new SandboxDomainError(`合并转发不存在：${forwardId}`)
    // 资源本身不绑定会话：外层消息直接引用，或从已可见转发资源的嵌套节点进入，都允许展开。
    if (!this.canAccessForward(input.operatorId, forward.id)) {
      throw new SandboxDomainError(`合并转发不存在：${forwardId}`)
    }
    return structuredClone(forward)
  }

  private getForwards(): SandboxForward[] {
    if (!this.scene.forwards) this.scene.forwards = []
    return this.scene.forwards
  }

  private normalizeSceneForwards(snapshot: SandboxSnapshot): SandboxSnapshot {
    snapshot.forwards = Array.isArray(snapshot.forwards) ? snapshot.forwards : []
    // 会话实例集合与 forwards 同样在读取路径补空数组，避免旧快照或半成品导入炸掉解析；
    // 那条不变量归解析模块所有，这里只调用它，不自己动实例集合。
    return normalizeSceneConversationInstances(snapshot)
  }

  private canAccessForward(operatorId: string, forwardId: string, seen = new Set<string>()): boolean {
    if (seen.has(forwardId)) return false
    seen.add(forwardId)
    const linkedMessages = this.scene.messages.filter(({ forwardId: id }) => id === forwardId)
    for (const message of linkedMessages) {
      if (findVisibleConversation(this.scene, operatorId, message.conversationId)) return true
    }
    // 嵌套资源：只要某个已可见父转发的节点引用它，就允许继续读取详情。
    for (const parent of this.getForwards()) {
      if (!parent.nodes.some((node) => node.forwardId === forwardId)) continue
      if (this.canAccessForward(operatorId, parent.id, seen)) return true
    }
    return false
  }

  private resolveForwardIdFromMessage(operatorId: string, rawMessageId?: string): string | undefined {
    if (!rawMessageId?.trim()) return undefined
    const messageId = resolveOneBotMessageId(this.implementationOf(operatorId), rawMessageId, this.scene.messages.map(({ id }) => id)) ?? rawMessageId
    const message = this.scene.messages.find(({ id }) => id === messageId)
    if (!message?.forwardId) throw new SandboxDomainError(`消息不是合并转发：${rawMessageId}`)
    if (!findVisibleConversation(this.scene, operatorId, message.conversationId)) {
      throw new SandboxDomainError(`消息不存在：${rawMessageId}`)
    }
    if (isRecalledMessage(message)) throw new SandboxDomainError(`消息已撤回：${rawMessageId}`)
    return message.forwardId
  }

  /**
   * 与 QQ 一致：消息全部选自同一个私聊时标题是「A和B的聊天记录」，其余情况（群聊、跨会话、自定义节点）
   * 不写标题，卡片显示默认的「群聊的聊天记录」。调用前 buildForwardNodes 已校验过消息可见。
   */
  private resolveForwardTitle(input: SendForwardMessageInput): string | undefined {
    if (!input.messageIds?.length || input.nodes?.length) return undefined
    const conversationIds = new Set(input.messageIds.map((id) => this.scene.messages.find((message) => message.id === id.trim())?.conversationId))
    if (conversationIds.size !== 1) return undefined
    const [conversationId] = conversationIds
    const conversation = conversationId ? findVisibleConversation(this.scene, input.operatorId, conversationId) : undefined
    if (conversation?.type !== 'direct' || !conversation.participantIds) return undefined
    const names = conversation.participantIds.map((id) => this.scene.participants.find((participant) => participant.id === id)?.name ?? id)
    return `${names[0]}和${names[1]}的聊天记录`
  }

  private buildForwardNodes(input: SendForwardMessageInput): SandboxForwardNode[] {
    if (input.messageIds?.length && input.nodes?.length) {
      throw new SandboxDomainError('合并转发不能同时传入 messageIds 与 nodes')
    }
    if (input.messageIds?.length) return this.buildReferenceForwardNodes(input.operatorId, input.messageIds)
    if (input.nodes?.length) return this.buildExplicitForwardNodes(input.operatorId, input.nodes)
    throw new SandboxDomainError('合并转发至少需要一个消息节点')
  }

  private buildReferenceForwardNodes(operatorId: string, messageIds: string[]): SandboxForwardNode[] {
    const uniqueIds = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))]
    if (!uniqueIds.length) throw new SandboxDomainError('合并转发至少需要一个消息节点')
    if (uniqueIds.length > MAX_FORWARD_NODES) throw new SandboxDomainError(`合并转发节点不能超过 ${MAX_FORWARD_NODES} 条`)
    const messages = uniqueIds.map((messageId) => {
      const message = this.scene.messages.find(({ id }) => id === messageId)
      if (!message) throw new SandboxDomainError(`消息不存在：${messageId}`)
      const conversation = findVisibleConversation(this.scene, operatorId, message.conversationId)
      if (!conversation) {
        throw new SandboxDomainError(`消息不存在：${messageId}`)
      }
      // 与右键多选读同一份能力位：事件消息与已撤回消息都进不了合并转发。
      const denial = denyMessageCapability('forward', this.toMessageCapabilityInput(message, conversation, operatorId))
      if (denial === 'event-message') throw new SandboxDomainError(`事件消息不能合并转发：${messageId}`)
      if (denial) throw new SandboxDomainError(`已撤回消息不能合并转发：${messageId}`)
      return message
    })
    // 多选发送按时间稳定排序，不使用点击顺序。
    // createdAt 相同时回退到场景插入顺序，避免 Random.id 字典序把后发消息排到前面。
    const messageOrder = new Map(this.scene.messages.map((message, index) => [message.id, index]))
    messages.sort((left, right) => {
      const time = left.createdAt.localeCompare(right.createdAt)
      if (time) return time
      return (messageOrder.get(left.id) ?? 0) - (messageOrder.get(right.id) ?? 0)
    })
    return messages.map((message) => this.toForwardNodeFromMessage(message))
  }

  private buildExplicitForwardNodes(operatorId: string, nodes: SandboxForwardNodeInput[]): SandboxForwardNode[] {
    if (nodes.length > MAX_FORWARD_NODES) throw new SandboxDomainError(`合并转发节点不能超过 ${MAX_FORWARD_NODES} 条`)
    return nodes.map((node, index) => {
      if (node.type === 'reference') {
        const [built] = this.buildReferenceForwardNodes(operatorId, [node.messageId])
        return built
      }
      const userId = node.userId.trim()
      const nickname = node.nickname.trim() || userId
      if (!userId) throw new SandboxDomainError(`合并转发节点 #${index + 1} 缺少 user_id`)
      const content = node.content.trim()
      const media = node.media?.length ? node.media.map(toMediaMetadata) : undefined
      if (!content && !media?.length && !node.forwardId) {
        throw new SandboxDomainError(`合并转发节点 #${index + 1} 不能为空`)
      }
      if (node.forwardId && !this.getForwards().some(({ id }) => id === node.forwardId)) {
        throw new SandboxDomainError(`嵌套合并转发不存在：${node.forwardId}`)
      }
      if (media?.some(({ id, reference }) => reference !== `sandbox-media://${id}`)) {
        throw new SandboxDomainError(`合并转发节点 #${index + 1} 包含无效媒体引用`)
      }
      return {
        userId,
        nickname,
        content: content || (media?.length
          ? media.map((item) => `[${this.getMediaLabel(item)}] ${item.name}`).join(' ')
          : '[合并转发]'),
        createdAt: node.createdAt ?? new Date().toISOString(),
        ...(media ? { media } : {}),
        ...(node.forwardId ? { forwardId: node.forwardId } : {}),
      }
    })
  }

  private toForwardNodeFromMessage(message: SandboxMessage): SandboxForwardNode {
    const author = this.scene.participants.find(({ id }) => id === message.authorId)
    const conversation = resolveConversation(this.scene, message.conversationId)
    const groupMember = conversation?.type === 'group'
      ? this.scene.groups.find(({ id }) => id === conversation.groupId)
        ?.members.find(({ participantId }) => participantId === message.authorId)
      : undefined
    return {
      userId: message.authorId,
      nickname: groupMember?.card?.trim() || author?.name || message.authorId,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.media?.length ? { media: structuredClone(message.media) } : {}),
      sourceMessageId: message.id,
      ...(message.forwardId ? { forwardId: message.forwardId } : {}),
    }
  }

  private formatForwardPreview(nodes: SandboxForwardNode[]): string {
    // 自定义节点可以同时带文字、媒体与嵌套转发，三者都要进摘要；与 client/webqq/forward-preview.ts 同步。
    const lines = nodes.slice(0, 4).map((node) => {
      const text = forwardNodeText(node).replace(/\s+/g, ' ').trim()
      const parts = [
        text,
        ...(!text && node.media?.length ? node.media.map((item) => `[${this.getMediaLabel(item)}] ${item.name}`) : []),
        ...(node.forwardId ? ['[合并转发]'] : []),
      ].filter(Boolean)
      return `${node.nickname}：${parts.join(' ') || '[消息]'}`
    })
    return lines.join('\n') || '[合并转发]'
  }

  private toOneBotForwardNodePayloads(nodes: SandboxForwardNode[]): Array<{ type: 'node'; data: Record<string, unknown> }> {
    return nodes.map((node) => {
      if (node.sourceMessageId) {
        return { type: 'node', data: { id: node.sourceMessageId } }
      }
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
        },
      }
    })
  }

  async sendMediaMessage(input: SendMediaMessageInput): Promise<SendMessageResult> {
    const { result, delivery } = this.startMediaMessageSend(input)
    await delivery
    return { ...result, revision: this.scene.revision }
  }

  startMediaMessageSend(input: SendMediaMessageInput): { result: SendMessageResult; delivery: Promise<void> } {
    if (!input.media.length) throw new SandboxDomainError('至少需要一个媒体文件')
    // 先校验会话与操作者，再落盘媒体；中途任一文件校验失败时清理已写入的文件，避免留下孤儿媒体。
    const context = this.getMessageContext(input)
    const media: SandboxMedia[] = []
    try {
      for (const file of input.media) media.push(this.storeMedia(file))
    } catch (error) {
      for (const saved of media) this.mediaStorage.remove(saved)
      throw error
    }
    const text = input.content?.trim() ?? ''
    // 占位 content 仅用于会话预览与历史可读性，派发给机器人的消息只携带媒体段与用户真实文本。
    const content = text || media.map((item) => `[${this.getMediaLabel(item)}] ${item.name}`).join(' ')
    const message = this.appendMessage(input.operatorId, context.conversation.id, content, input.replyToMessageId, media)
    const elements = media.map((item) => {
      // ChatLuna 的图片转换器只读取 img.src/url，不会解析 sandbox-media RPC 引用；
      // 因此这里必须把受控媒体正文转成 Data URL，避免模型只收到媒体 ID 或哈希文本。
      const source = item.type === 'image'
        ? `data:${item.mimeType};base64,${this.mediaStorage.read(item).dataBase64}`
        : item.reference
      return h(item.type === 'image' ? 'img' : item.type, {
        src: source,
        ...(item.type === 'image' ? { url: source } : { file: item.reference }),
        title: item.name,
        mime: item.mimeType,
        size: item.size,
      })
    })
    if (text) elements.push(h.text(text))
    const onebotMessage: SandboxOneBotMessageSegment[] = [
      ...(context.reply ? [{ type: 'reply', data: { id: String(getOneBotMessageSequence(context.reply.id)) } }] : []),
      ...media.map((item) => ({ type: item.type === 'audio' ? 'record' : item.type, data: { file: item.reference } })),
      ...(text ? [{ type: 'text', data: { text } }] : []),
    ]
    // raw message 与另两路同源：手搓那份与助手函数逐段对得上（回复段、媒体段、文本段），
    // 但没有任何东西保证它继续一致。媒体段只带文件引用这处口径不动，改它会改变被测插件收到的
    // 事件保真度，归「OneBot 事件构造的两个方向」候选。
    const delivery = this.dispatchMessageToBots(context, message, elements, onebotMessage, toOneBotRawMessage(onebotMessage))
    return { result: { messageId: message.id, revision: this.scene.revision }, delivery }
  }

  getMediaContent(input: GetMediaContentInput): SandboxMediaContent {
    const visibleConversationIds = listVisibleConversationIds(this.scene, input.operatorId)
    this.getParticipant(input.operatorId)
    const messageMedia = this.scene.messages
      .filter(({ conversationId }) => visibleConversationIds.has(conversationId))
      .flatMap(({ media }) => media ?? [])
      .find(({ id }) => id === input.mediaId)
    if (messageMedia) return this.mediaStorage.read(messageMedia)
    // 合并转发详情中的媒体只挂在节点上；嵌套资源按 canAccessForward 递归可达，与 getForwardMessage 一致。
    const forwardMedia = this.getForwards()
      .filter(({ id }) => this.canAccessForward(input.operatorId, id))
      .flatMap(({ nodes }) => nodes.flatMap(({ media }) => media ?? []))
      .find(({ id }) => id === input.mediaId)
    if (forwardMedia) return this.mediaStorage.read(forwardMedia)
    const avatarReference = [...this.scene.participants.map(({ avatar }) => avatar), ...this.scene.groups.map(({ avatar }) => avatar)]
      .find((reference) => reference === `sandbox-media://${input.mediaId}`)
    if (!avatarReference) throw new SandboxDomainError(`媒体不存在或不可见：${input.mediaId}`)
    return this.mediaStorage.readById(input.mediaId)
  }

  /**
   * 三条发送路径共同的投递入口：把已落库的这条消息交给投递模块。
   *
   * 这里只补一件发送路径知道而投递模块不知道的事——引用回复要按作者标识查参与者，而参与者集合
   * 归场景所有。接收机器人推导、事件字段构造、上下文跟随、中间件等待与投递记录都在模块里。
   */
  private dispatchMessageToBots(
    context: SandboxMessageContext,
    message: SandboxMessage,
    elements: ReturnType<typeof h>[],
    onebotMessage: SandboxOneBotMessageSegment[],
    rawMessage: string,
  ): Promise<void> {
    return this.inboundDelivery.deliverMessage({
      context,
      messageId: message.id,
      elements,
      segments: onebotMessage,
      rawMessage,
      quote: context.reply ? this.resolveInboundQuote(context.reply) : undefined,
      replyToMessageId: context.reply?.id,
    })
  }

  setGroupAnnouncement(input: SetGroupAnnouncementInput): void {
    const group = this.requireAnnouncementGroup(input.operatorId, input.groupId)
    const content = input.content.trim()
    if (!content) throw new SandboxDomainError('群公告不能为空')

    group.announcements.unshift({
      id: Random.id(),
      authorId: input.operatorId,
      content,
      createdAt: new Date().toISOString(),
    })
    this.commitSceneMutation()
  }

  deleteGroupAnnouncement(input: DeleteGroupAnnouncementInput): void {
    const group = this.requireAnnouncementGroup(input.operatorId, input.groupId)
    const index = group.announcements.findIndex(({ id }) => id === input.announcementId)
    if (index < 0) throw new SandboxDomainError(`群公告不存在：${input.announcementId}`)
    group.announcements.splice(index, 1)
    this.commitSceneMutation()
  }

  /**
   * 读取一个群的全部公告，顺序就是存储顺序（`setGroupAnnouncement` 用 `unshift`，最新在前）。
   *
   * 与写入、删除同一道定位，因此机器人只读得到自己所在群的公告；不在群里时按同一句拒绝，
   * 而不是返回空数组——空数组会让插件以为群里没有公告。读取不产生场景变更。
   */
  listGroupAnnouncements(input: ListGroupAnnouncementsInput): SandboxGroupAnnouncement[] {
    return structuredClone(this.requireAnnouncementGroup(input.operatorId, input.groupId).announcements)
  }

  /** 群公告读写共用的定位：参与者与群都必须存在，且该参与者在群里。 */
  private requireAnnouncementGroup(operatorId: string, groupId: string): SandboxGroup {
    const participant = this.getParticipant(operatorId)
    const group = this.scene.groups.find(({ id }) => id === groupId)
    if (!group) throw new SandboxDomainError(`群组不存在：${groupId}`)
    if (!group.members.some(({ participantId }) => participantId === participant.id)) {
      throw new SandboxDomainError(`参与者不在群组中：${operatorId}`)
    }
    return group
  }

  /**
   * 一个机器人此刻该看见的群系统消息，按场景里申请的既有顺序返回。
   *
   * 审批权限用关系规则模块那一份 `denyGroupAuthority`，与 `set_group_add_request` 的入群申请
   * 分支同源；群邀请的判据同样与那条通道一致（`targetId === botId`）。因此列出来的每一条都能
   * 直接接上审批，机器人看不见的群的申请一条都不出现。
   *
   * 返回一条平列而不是两个桶：上游的 `count` 限的是「一次取多少条系统消息」这个总量，取回来
   * 之后才分桶，按桶各截一次会让插件在沙盒上看到上游给不出的组合。
   */
  getBotGroupSystemMessages(botId: string): SandboxGroupSystemMessage[] {
    if (!this.isBot(botId)) throw new SandboxDomainError(`机器人不存在：${botId}`)
    return this.scene.requests.flatMap((request) => {
      if (request.type !== 'group') return []
      const group = this.scene.groups.find(({ id }) => id === request.groupId)
      if (!group) return []
      const invite = (request.subType ?? 'add') === 'invite'
      if (invite ? request.targetId !== botId : !this.canBotHandleJoinRequest(group, botId)) return []
      return [{
        kind: invite ? 'invite' as const : 'join' as const,
        requestId: request.id,
        groupId: group.id,
        groupName: group.name,
        initiatorId: request.requesterId,
        initiatorName: this.getParticipant(request.requesterId).name,
        comment: request.comment ?? '',
        checked: request.status !== 'pending',
      }]
    })
  }

  /** 机器人在这个群里有没有审批入群申请的权限；不在群里也算没有，因为那个群对它不可见。 */
  private canBotHandleJoinRequest(group: SandboxGroup, botId: string): boolean {
    const member = group.members.find(({ participantId }) => participantId === botId)
    return !!member && !denyGroupAuthority(member)
  }

  // 表情回应写入消息状态，使 get_msg、场景快照和消息历史都能读回同一份回应事实。
  // 机器人操作者必须走 set_msg_emoji_like，以便能力禁用与调试记录和真实 OneBot 通道一致。
  async setMessageReaction(input: SetMessageReactionInput): Promise<{ revision: number }> {
    // 会话归属只在这里判定，且必须在分流之前：机器人操作者要绕一圈自身 OneBot action，
    // 而 action 表面没有「会话」这一级，走到那里就再也看不见请求声明的会话了。
    this.assertReactionConversationMatches(input)
    if (this.isBot(input.operatorId)) {
      const bot = this.getBots().find(({ id }) => id === input.operatorId)!
      if (!bot.enabled) throw new SandboxDomainError(`机器人已停用：${bot.id}`)
      await this.getRuntimeBot(bot.id).internal._request('set_msg_emoji_like', {
        message_id: input.messageId,
        emoji_id: input.emojiId,
        set: input.enabled,
      })
      return { revision: this.scene.revision }
    }
    this.applyMessageReaction(input)
    return { revision: this.scene.revision }
  }

  /**
   * 请求声明了会话时，要求它就是目标消息自身的归属会话。
   *
   * 在分支里对继承前缀贴表情因此被拒——那段历史是与原会话共享的同一份记录，在分支视图里只读。
   * 不声明会话表示按消息自身的归属执行：插件通过原始 OneBot 寻址的是根会话的一条普通消息，
   * 拒绝它会让沙盒表现出真实环境不存在的错误。
   *
   * 消息本身不存在时这里放行，由写入路径给出统一的「消息不存在」。
   */
  private assertReactionConversationMatches(input: SetMessageReactionInput): void {
    if (!input.conversationId) return
    const message = this.scene.messages.find(({ id }) => id === input.messageId)
    if (message && message.conversationId !== input.conversationId) {
      throw new SandboxDomainError(`消息不存在：${input.messageId}`)
    }
  }

  /**
   * bot action 与用户交互最终都落到这里，保证场景回应事实唯一。
   *
   * 不接受会话：会话归属是请求层的边界，由 {@link setMessageReaction} 在分流前判定；
   * 这条写入路径只认消息实体，因此插件通过原始 OneBot 作用到继承前缀仍然生效。
   */
  applyMessageReaction(input: Omit<SetMessageReactionInput, 'conversationId'>): void {
    const emojiId = input.emojiId.trim()
    if (!emojiId) throw new SandboxDomainError('表情 ID 不能为空')
    this.getParticipant(input.operatorId)
    const message = this.scene.messages.find(({ id }) => id === input.messageId)
    if (!message) throw new SandboxDomainError(`消息不存在：${input.messageId}`)
    const conversation = findVisibleConversation(this.scene, input.operatorId, message.conversationId)
    if (!conversation) {
      throw new SandboxDomainError(`消息不存在：${input.messageId}`)
    }
    // 私聊和群聊共用回应事实；会话可见性已在上方统一校验。
    // 事件消息不接受回应，真实 QQ 里系统提示不是一条可操作的消息；
    // 撤回后保留历史回应，但禁止继续新增或取消，避免把历史事实改写成当前操作。
    const denial = denyMessageCapability('react', this.toMessageCapabilityInput(message, conversation, input.operatorId))
    if (denial) throw new SandboxDomainError(describeReactionDenial(denial, input.messageId))
    // 与撤回一致地覆盖同一广播组，避免同一条逻辑消息的副本之间回应不一致。
    for (const target of this.scene.messages.filter(({ id, broadcastId }) => id === message.id
      || (!!message.broadcastId && broadcastId === message.broadcastId))) {
      const reactions = target.reactions ?? []
      const reaction = reactions.find((item) => item.emojiId === emojiId)
      if (!input.enabled) {
        if (reaction) reaction.participantIds = reaction.participantIds.filter((id) => id !== input.operatorId)
      } else if (!reaction) {
        reactions.push({ emojiId, participantIds: [input.operatorId] })
      } else if (!reaction.participantIds.includes(input.operatorId)) {
        reaction.participantIds.push(input.operatorId)
      }
      const remaining = reactions.filter(({ participantIds }) => participantIds.length)
      if (remaining.length) target.reactions = remaining
      else delete target.reactions
    }
    this.commitSceneMutation()
  }

  async recallMessage(input: RecallMessageInput): Promise<{ revision: number }> {
    if (this.isBot(input.operatorId)) {
      const bot = this.getBots().find(({ id }) => id === input.operatorId)!
      if (!bot.enabled) throw new SandboxDomainError(`机器人已停用：${bot.id}`)
      // 机器人操作者必须走自身 OneBot action（操作通道约束），保持能力校验与调试记录一致。
      await this.getRuntimeBot(bot.id).internal._request('delete_msg', { message_id: input.messageId })
      return { revision: this.scene.revision }
    }
    this.getParticipant(input.operatorId)
    await this.recallVisibleMessage(input.operatorId, input.messageId, input.conversationId)
    return { revision: this.scene.revision }
  }

  clearConversationMessages(input: ClearConversationMessagesInput): { revision: number } {
    const conversation = this.getVisibleConversation(input.operatorId, input.conversationId)
    const removedMessageIds = new Set(this.scene.messages
      .filter(({ conversationId }) => conversationId === conversation.id)
      .map(({ id }) => id))
    clearConversationMessageIds(this.scene, conversation.id)
    this.scene.messages = this.scene.messages.filter(({ conversationId }) => conversationId !== conversation.id)
    this.chatLunaState.deleteByConversationIds(new Set([conversation.id]))
    this.botDeliveries = this.botDeliveries.filter(({ messageId }) => !removedMessageIds.has(messageId))
    this.pruneUnreferencedForwards()
    // 保留逻辑会话实体，只删除其历史引用，确保下一条消息从空上下文开始。
    this.commitSceneMutation()
    return { revision: this.scene.revision }
  }

  async recallBotMessage(botId: string, rawMessageId: string, conversationId?: string): Promise<void> {
    const messageId = resolveOneBotMessageId(this.implementationOf(botId), rawMessageId, this.scene.messages.map(({ id }) => id))
    await this.recallVisibleMessage(botId, messageId ?? rawMessageId, conversationId)
  }

  // 撤回是生命周期状态：权威场景保留正文/媒体/回复/回应/思考，仅标记 recalled 并向机器人派发 notice。
  private async recallVisibleMessage(operatorId: string, messageId: string, conversationId?: string): Promise<void> {
    const message = this.scene.messages.find(({ id }) => id === messageId)
    if (!message || (conversationId && message.conversationId !== conversationId)) throw new SandboxDomainError(`消息不存在：${messageId}`)
    const conversation = findVisibleConversation(this.scene, operatorId, message.conversationId)
    if (!conversation) throw new SandboxDomainError(`消息不存在：${messageId}`)
    const group = conversation.type === 'group'
      ? this.scene.groups.find(({ id }) => id === conversation.groupId)
      : undefined
    // 事件消息、已撤回消息与群角色阶梯都由共享判据回答，右键菜单读的是同一份答案；
    // 文案由 describeRecallDenial 还原成收敛前的那几句。
    const denial = denyMessageCapability('recall', { message, conversation, operatorId, group })
    if (denial) throw new SandboxDomainError(describeRecallDenial(denial, message, operatorId))
    const recalledAt = new Date().toISOString()
    const recalled = this.scene.messages.filter(({ id, broadcastId }) => id === message.id
      || (!!message.broadcastId && broadcastId === message.broadcastId))
    for (const target of recalled) {
      target.lifecycle = {
        status: 'recalled',
        operatorId,
        recalledAt,
      }
    }
    this.commitSceneMutation()
    if (group) {
      // message_id 按每个接收机器人的实现给：SnowLuma 是哈希 ID，不是消息序号。
      await this.dispatchGroupNotice(group, 'group_recall', (botId) => ({
        user_id: Number(message.authorId),
        operator_id: Number(operatorId),
        message_id: getOneBotMessageId(this.implementationOf(botId), message.id),
      }), { messageId: message.id })
      return
    }
    if (conversation.type !== 'direct') return
    await Promise.all(conversation.participantIds!.map(async (participantId) => {
      const bot = this.getBots().find(({ id }) => id === participantId)
      if (!bot?.enabled) return
      await this.dispatchFriendRecallNotice(bot.id, conversation, message.id)
    }))
  }

  private async dispatchFriendRecallNotice(botId: string, conversation: ResolvedConversation, messageId: string): Promise<void> {
    const bot = this.runtimeBots.get(botId)
    if (!bot) return
    const peerId = resolveConversationPeerId(conversation, botId)
    if (!peerId) return
    const session = bot.session({
      type: 'message-deleted',
      timestamp: Date.now(),
      user: { id: peerId, name: this.getParticipant(peerId).name },
      channel: { id: conversation.id, type: 1 },
      message: { id: messageId, messageId },
    })
    Object.assign(session, {
      onebot: {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(botId),
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: Number(peerId),
        message_id: getOneBotMessageId(this.implementationOf(botId), messageId),
      },
    })
    await this.inboundDelivery.dispatchEvent(bot, session)
    // 与群通知路径一致：OneBot 插件监听原始 notice，标准事件与原始事件复用同一个 Session。
    ;(this.ctx.emit as unknown as (session: unknown, name: string, payload: unknown) => void)(session, 'notice', session)
  }

  private appendMessage(
    authorId: string,
    conversationId: string,
    content: string,
    replyToMessageId?: string,
    media?: SandboxMedia[],
    event?: SandboxMessage['event'],
    broadcastId?: string,
    forwardId?: string,
  ): SandboxMessage {
    requireConversation(this.scene, conversationId)

    const message: SandboxMessage = {
      id: Random.id(),
      authorId,
      conversationId,
      content,
      createdAt: new Date().toISOString(),
      replyToMessageId,
      broadcastId,
      // 只保留媒体元数据：上游（MCP 上传缓存）会把 dataBase64 挂在同一个对象上，
      // 直接存进场景会让正文 base64 随每次整场景落盘写进数据库。
      media: media?.map(toMediaMetadata),
      event,
      ...(forwardId ? { forwardId } : {}),
    }
    if (!event && this.isBot(authorId)) {
      const trace = this.chatLunaState.traceFor(authorId, conversationId)
      if (trace) message.chatLuna = { thought: '', trace }
    } else if (!event) {
      this.chatLunaState.clearReplyContext(conversationId)
    }
    this.scene.messages.push(message)
    appendConversationMessageId(this.scene, conversationId, message.id)
    if (!event && this.isBot(authorId)) {
      this.chatLunaState.recordReplyMessage(authorId, conversationId, message.id)
    }
    this.commitSceneMutation()
    return message
  }

  // 本轮结果只归档到最后一条机器人回复：分段发送时思考与用量属于整轮，挂在收尾的气泡上。
  // 回复晚于回合结束陆续发出时会再次归档，列表里前面几段上的结果随之移除，只保留各自的出处。
  private archiveChatLunaResult(
    _botParticipantId: string,
    _conversationId: string,
    result: SandboxMessageChatLuna,
    replyMessageIds: readonly string[],
  ): void {
    const targetIds = new Set(replyMessageIds)
    const replies = this.scene.messages.filter((message) => targetIds.has(message.id))
    const message = replies.at(-1)
    if (!message) return

    for (const previous of replies.slice(0, -1)) {
      if (!previous.chatLuna) continue
      const trace = previous.chatLuna.trace
      if (trace) previous.chatLuna = { thought: '', trace }
      else delete previous.chatLuna
    }
    const trace = message.chatLuna?.trace
    message.chatLuna = {
      thought: result.thought,
      ...(result.thoughtDurationMs === undefined ? {} : { thoughtDurationMs: result.thoughtDurationMs }),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(trace ? { trace } : {}),
    }
    if (!message.chatLuna.thought && !message.chatLuna.usage && !message.chatLuna.trace) delete message.chatLuna
    this.commitSceneMutation()
  }

  private async loadSceneAfterDatabaseReady(persistence: SandboxScenePersistence): Promise<SandboxSceneLoadResult> {
    let result = await persistence.load()
    if (result.kind !== 'unavailable' || result.reason !== 'missing-service') return result

    const deadline = Date.now() + this.databaseReadyTimeoutMs
    // Minato 驱动与本插件都在 ready 阶段启动，database 可能要等异步驱动完成后才注册。
    // 这里只重试 missing-service；query-failed 代表数据库已经可读到但查询失败，绝不能重试成“空库”。
    while (!this.disposed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
      if (this.disposed) break
      result = await persistence.load()
      if (result.kind !== 'unavailable' || result.reason !== 'missing-service') return result
    }
    return result
  }

  private async restoreScene(): Promise<void> {
    await this.oneBotDebug.waitForReady()
    const persistence = this.persistence
    if (!persistence) return
    const result = await this.loadSceneAfterDatabaseReady(persistence)
    if (result.kind === 'loaded') {
      // 未发布阶段直接补齐 forwards，避免本地旧快照缺字段导致读取路径崩溃。
      this.scene = this.normalizeSceneForwards(structuredClone(result.scene))
      // 配置调小上限后，恢复的旧场景必须立刻收敛，否则第一次写入仍然是超限的完整场景。
      // 必须排在头像规范化之前：后者结尾按最终引用集回收媒体，淘汰要先落定。
      const trimmed = this.reclaimSceneMessages()
      const normalized = await this.normalizePersistedAvatars()
      this.syncRuntimeBots()
      if (normalized || trimmed) {
        await persistence.save(this.getSnapshot())
      }
      // 恢复不会产生新的领域变更，因此保留持久化 revision；广播只负责唤醒可能提前挂载的客户端。
      this.notifySceneMutation()
      return
    }
    if (result.kind === 'missing') {
      this.ensureStableAvatars()
      this.syncRuntimeBots()
      await persistence.save(this.getSnapshot())
      return
    }
    // 数据库暂不可用或查询失败都不能证明旧场景不存在；禁止后续 mutation 写库、清媒体或覆盖真实数据。
    this.scenePersistenceAuthoritative = false
    const reason = result.reason === 'missing-service'
      ? `等待 Koishi Database 服务 ${this.databaseReadyTimeoutMs}ms 后仍不可用`
      : result.error instanceof Error ? result.error.message : '数据库查询失败'
    this.ctx.logger('onebot-sandbox').warn(`场景持久化暂不可用，已保留当前进程内场景且不会覆盖数据库：${reason}`)
  }

  private async normalizePersistedAvatars(): Promise<boolean> {
    let changed = false
    for (const participant of this.scene.participants) {
      const previous = participant.avatar
      if (!previous) {
        participant.avatar = this.createDefaultAvatar(participant.kind)
        changed = true
        continue
      }
      if (previous.startsWith('sandbox-media://')) {
        if (this.rematerializeBuiltinAvatar(previous)) changed = true
        else if (!this.hasManagedAvatar(previous)) {
          this.ctx.logger('onebot-sandbox').warn(`参与者头像媒体不存在，已保留原引用等待恢复：${participant.id}`)
        }
        continue
      }
      try {
        participant.avatar = await this.importAvatar(participant.kind, participant.id, previous)
      } catch (error) {
        this.ctx.logger('onebot-sandbox').warn('%s\n%s', `参与者头像规范化失败，已替换为默认值：${participant.id}`, errorDetail(error))
        participant.avatar = this.createDefaultAvatar(participant.kind)
      }
      changed = true
    }
    for (const group of this.scene.groups) {
      const previous = group.avatar
      if (!previous) {
        group.avatar = this.createDefaultAvatar('group')
        changed = true
        continue
      }
      if (previous.startsWith('sandbox-media://')) {
        if (this.rematerializeBuiltinAvatar(previous)) changed = true
        else if (!this.hasManagedAvatar(previous)) {
          this.ctx.logger('onebot-sandbox').warn(`群头像媒体不存在，已保留原引用等待恢复：${group.id}`)
        }
        continue
      }
      try {
        group.avatar = await this.importAvatar('group', group.id, previous)
      } catch (error) {
        this.ctx.logger('onebot-sandbox').warn('%s\n%s', `群头像规范化失败，已替换为默认值：${group.id}`, errorDetail(error))
        group.avatar = this.createDefaultAvatar('group')
      }
      changed = true
    }
    this.mediaStorage.reclaimUnreferenced(this.getMediaReferences())
    return changed
  }

  private getMediaReferences(): Set<string> {
    return new Set([
      ...this.scene.participants.flatMap(({ avatar }) => avatar ? [avatar] : []),
      ...this.scene.groups.flatMap(({ avatar }) => avatar ? [avatar] : []),
      ...this.scene.messages.flatMap(({ media }) => media?.map(({ reference }) => reference) ?? []),
      // 合并转发节点内的媒体也必须计入引用，避免场景回收删掉详情里的图片。
      ...this.getForwards().flatMap(({ nodes }) => nodes.flatMap(({ media }) => media?.map(({ reference }) => reference) ?? [])),
    ])
  }

  private commitSceneMutation(): void {
    this.scene.revision += 1
    // 保留上限必须在媒体回收和落盘之前收敛，否则被淘汰消息的媒体会多活一个 revision，
    // 而这一轮写入的仍然是超限后的完整场景。
    this.reclaimSceneMessages()
    this.mediaStorage.reclaimUnreferenced(this.getMediaReferences())
    this.queueScenePersistence()
    this.notifySceneMutation()
  }

  /**
   * 条数上限与场景 JSON 字节上限同时约束场景消息，达到任一上限就从最旧消息开始淘汰。
   * 级联清理会话的 messageIds、因此失去引用的合并转发资源与机器人投递记录；媒体回收
   * 由调用方在本函数之后按引用集统一执行。
   */
  private reclaimSceneMessages(): boolean {
    const overflow = this.scene.messages.length - this.sceneMessageLimit
    const removed: SandboxMessage[] = overflow > 0 ? this.scene.messages.splice(0, overflow) : []
    // 字节上限按整块落盘的真实体积收敛。逐条 stringify 是 O(n²)，这里按当前平均单条
    // 体积估算需要淘汰的条数，再用实测字节数复核，循环至多迭代常数次。
    while (this.scene.messages.length) {
      const sceneBytes = Buffer.byteLength(JSON.stringify(this.scene), 'utf8')
      if (sceneBytes <= this.sceneMessageMaxBytes) break
      const messagesBytes = Buffer.byteLength(JSON.stringify(this.scene.messages), 'utf8')
      const average = Math.max(1, Math.ceil(messagesBytes / this.scene.messages.length))
      const drop = Math.min(
        this.scene.messages.length,
        Math.max(1, Math.ceil((sceneBytes - this.sceneMessageMaxBytes) / average)),
      )
      removed.push(...this.scene.messages.splice(0, drop))
      // 消息之外的场景内容（参与者、群、转发、请求）本身可能就超过字节上限；
      // 消息清空后无法继续收敛，此时循环由 length 条件终止而不是无限重试。
    }
    if (!removed.length) return false

    const removedIds = new Set(removed.map(({ id }) => id))
    pruneConversationMessageIds(this.scene, removedIds)
    this.botDeliveries = this.botDeliveries.filter(({ messageId }) => !removedIds.has(messageId))
    // 失去外层引用的合并转发资源必须一起回收，否则 getMediaReferences 会永久钉住节点媒体。
    this.pruneUnreferencedForwards()
    return true
  }

  private notifySceneMutation(): void {
    if (!this.sceneMutationListeners.size) return
    const snapshot = this.getSnapshot()
    for (const listener of this.sceneMutationListeners) listener(snapshot)
  }

  private queueScenePersistence(): void {
    const persistence = this.persistence
    if (!persistence || !this.scenePersistenceAuthoritative) return
    const snapshot = this.getSnapshot()
    this.persistenceQueue = this.persistenceQueue.then(() => persistence.save(snapshot))
  }

  private validateParticipantId(value: string): string {
    const id = value.trim()
    if (!/^\d+$/.test(id)) throw new SandboxDomainError('QQ ID 必须是数字字符串')
    return id
  }

  private validateGroupId(value: string): string {
    const id = value.trim()
    if (!/^\d+$/.test(id)) throw new SandboxDomainError('群号必须是数字字符串')
    return id
  }

  private validateName(value: string, field: string): string {
    const name = value.trim()
    if (!name) throw new SandboxDomainError(`${field}不能为空`)
    return name
  }

  private getUsers(): SandboxUser[] {
    return this.scene.participants.filter((participant): participant is SandboxUser => participant.kind === 'user')
  }

  private getBots(): SandboxBotProfile[] {
    return this.scene.participants.filter((participant): participant is SandboxBotProfile => participant.kind === 'bot')
  }

  private getUser(userId: string) {
    const user = this.getUsers().find(({ id }) => id === userId)
    if (!user) throw new SandboxDomainError(`用户不存在：${userId}`)
    return user
  }

  private getVisibleConversation(operatorId: string, conversationId: string) {
    this.getParticipant(operatorId)
    return requireVisibleConversation(this.scene, operatorId, conversationId)
  }

  private resolveInboundQuote(reply: SandboxMessage): InboundQuotedMessage {
    const author = this.scene.participants.find(({ id }) => id === reply.authorId)
    return {
      id: reply.id,
      messageId: reply.id,
      content: reply.content,
      elements: h.parse(reply.content),
      timestamp: new Date(reply.createdAt).getTime(),
      user: {
        id: reply.authorId,
        name: author?.name,
        isBot: author?.kind === 'bot',
      },
    }
  }

  private getMessageContext(input: Pick<SendMessageInput, 'operatorId' | 'conversationId' | 'replyToMessageId'>): SandboxMessageContext {
    const operator = this.getParticipant(input.operatorId)
    const conversation = this.getVisibleConversation(input.operatorId, input.conversationId)
    const group = conversation.groupId
      ? this.scene.groups.find(({ id }) => id === conversation.groupId)
      : undefined
    if (conversation.type === 'group' && (!group || !group.members.some(({ participantId }) => participantId === operator.id))) {
      throw new SandboxDomainError(`群聊关系不存在：${input.conversationId}`)
    }
    const peerId = resolveConversationPeerId(conversation, input.operatorId)
    const peer = peerId ? this.getParticipant(peerId) : undefined
    const reply = input.replyToMessageId
      ? this.scene.messages.find(({ id }) => id === input.replyToMessageId)
      : undefined
    // 回复目标只要在当前会话里可读即可：自有消息或它的继承前缀。分支里「在分叉点那句话上
    // 换一种问法」是最自然的用法，要求归属等于当前会话会让分界线以上完全惰性。
    if (input.replyToMessageId
      && (!reply || !readConversationMessageIds(this.scene, conversation.id).includes(input.replyToMessageId))) {
      throw new SandboxDomainError(`回复消息不存在：${input.replyToMessageId}`)
    }
    // 系统提示不是可引用的消息；引用一条已撤回的消息会让撤回经引用旁路重新露出原文。
    // 机器人表面早已按后一条办（toUniversalMessage 在引用目标已撤回时不给 quote），写入路径与它一致。
    const replyDenial = reply
      && denyMessageCapability('reply', this.toMessageCapabilityInput(reply, conversation, input.operatorId))
    if (replyDenial) throw new SandboxDomainError(describeReplyDenial(replyDenial, input.replyToMessageId!))
    return { operator, peer, conversation, group, reply }
  }

  /**
   * 消息能力判据的入参：群组按会话归属解析，因此调用方不必各自记得群聊要多带一个实体。
   *
   * 判据不做可见性校验——各入口自己已经用 {@link findVisibleConversation} 或
   * {@link getVisibleConversation} 判过，这里只把已经解析出的会话交给判据。
   */
  private toMessageCapabilityInput(
    message: SandboxMessage,
    conversation: ResolvedConversation,
    operatorId?: string,
  ): MessageCapabilityInput {
    return {
      message,
      conversation,
      operatorId,
      group: conversation.type === 'group'
        ? this.scene.groups.find(({ id }) => id === conversation.groupId)
        : undefined,
    }
  }

  private getMediaLabel(media: SandboxMedia): string {
    return media.type === 'image' ? '图片' : media.type === 'audio' ? '语音' : media.type === 'video' ? '视频' : '文件'
  }

  private validateMessageLimit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new SandboxDomainError('消息分页大小必须在 1 到 100 之间')
    return value
  }

  private createRuntimeBot(config: SandboxBot.Config) {
    this.runtimeBotRegistry.claim(config.selfId, this.runtimeOwner)
    try {
      const bot = new SandboxBot(this.ctx, this, config, this.inboundEventConversations)
      this.runtimeBots.set(config.selfId, bot)
      return bot
    } catch (error) {
      this.runtimeBotRegistry.release(config.selfId, this.runtimeOwner)
      throw error
    }
  }

  private syncRuntimeBots(): void {
    if (!this.runtimeBotsActive) return
    const botIds = new Set(this.getBots().map(({ id }) => id))
    for (const [botId, runtime] of this.runtimeBots) {
      if (botIds.has(botId)) continue
      this.runtimeBots.delete(botId)
      this.runtimeBotRegistry.release(botId, this.runtimeOwner)
      void runtime.dispose()
    }
    for (const profile of this.getBots()) {
      const runtime = this.runtimeBots.get(profile.id) ?? this.createRuntimeBot({
        selfId: profile.id,
        name: profile.name,
        avatar: profile.avatar,
        implementation: profile.implementation,
        disabledCapabilities: profile.disabledCapabilities,
      })
      runtime.user = { id: profile.id, name: profile.name, avatar: profile.avatar }
      runtime.status = profile.enabled ? 1 : 0
      runtime.updateImplementation(profile.implementation, profile.disabledCapabilities)
    }
  }

  private async disposeRuntimeBots(): Promise<void> {
    const runtimes = [...this.runtimeBots]
    this.runtimeBots.clear()
    for (const [botId] of runtimes) this.runtimeBotRegistry.release(botId, this.runtimeOwner)
    await Promise.all(runtimes.map(([, runtime]) => runtime.dispose()))
  }

  private handleUserRelationshipRequest(input: Extract<PerformFriendActionInput, { action: 'handle-request' }>): PerformFriendActionResult | Promise<PerformGroupActionResult> {
    const request = this.scene.requests.find(({ id }) => id === input.requestId)
    if (!request) throw new SandboxDomainError(`关系申请不存在：${input.requestId}`)
    if (request.type === 'friend') {
      // 机器人的决定必须由机器人自己经 OneBot action 作出，这条守卫属于用户 adapter。
      if (this.isBot(request.targetId)) throw new SandboxDomainError('机器人申请必须由机器人处理')
      if (request.targetId !== input.operatorId) throw new SandboxDomainError('只能处理发给自己的好友申请')
      this.relationshipActions.settleFriendRequest({
        requestId: request.id,
        requesterId: request.requesterId,
        targetId: input.operatorId,
        approve: input.approve,
      })
      return { revision: this.scene.revision }
    }

    return this.handleUserGroupRequest({
      action: 'handle-request',
      operatorId: input.operatorId,
      requestId: input.requestId,
      approve: input.approve,
    })
  }

  private async handleUserGroupRequest(input: Extract<PerformGroupActionInput, { action: 'handle-request' }>): Promise<PerformGroupActionResult> {
    const request = this.scene.requests.find(({ id, type }) => id === input.requestId && type === 'group')
    if (!request) throw new SandboxDomainError(`群申请不存在：${input.requestId}`)
    const group = this.scene.groups.find(({ id }) => id === request.groupId)
    if (!group) throw new SandboxDomainError(`群组不存在：${request.groupId}`)
    const subType = request.subType ?? 'add'

    let participantId = request.requesterId
    if (subType === 'invite') {
      // 与好友申请同源的守卫：邀请机器人入群这件事只能由那个机器人自己决定。
      if (this.isBot(request.targetId)) throw new SandboxDomainError('机器人邀请必须由机器人处理')
      if (request.targetId !== input.operatorId) throw new SandboxDomainError('只能处理发给自己的群邀请')
      if (!request.targetId) throw new SandboxDomainError('群申请缺少目标参与者')
      participantId = request.targetId
    } else if (denyGroupAuthority(this.requireGroupMember(group, input.operatorId))) {
      // 与机器人通道同一道角色判定，只有措辞不同：这句已被按文案断言，逐字保留。
      throw new SandboxDomainError('只有群主或管理员可以处理入群申请')
    }

    await this.relationshipActions.settleGroupRequest({
      group,
      requestId: request.id,
      participantId,
      operatorId: input.operatorId,
      subType,
      approve: input.approve,
    })
    return { revision: this.scene.revision }
  }

  private requireGroupMember(group: SandboxGroup, participantId: string) {
    const member = group.members.find((item) => item.participantId === participantId)
    if (!member) throw new SandboxDomainError(`参与者不在群组中：${participantId}`)
    return member
  }

  private removeRelationshipRequest(requestId: string): void {
    this.scene.requests = this.scene.requests.filter(({ id }) => id !== requestId)
  }

  private async addApprovedGroupMember(group: SandboxGroup, participantId: string, operatorId: string, subType: 'add' | 'invite') {
    this.getParticipant(participantId)
    if (!group.members.some((member) => member.participantId === participantId)) {
      group.members.push({ participantId, role: 'member' })
      this.syncGroupConversations(group.id)
    }
    this.commitSceneMutation()
    await this.dispatchGroupNotice(group, 'group_increase', {
      sub_type: subType === 'add' ? 'approve' : 'invite',
      operator_id: Number(operatorId),
      user_id: Number(participantId),
    })
  }

  private removeGroupMember(group: SandboxGroup, participantId: string) {
    group.members = group.members.filter((member) => member.participantId !== participantId)
    this.scene.requests = this.scene.requests.filter((request) => request.groupId !== group.id
      || (request.requesterId !== participantId && request.targetId !== participantId))
    this.syncGroupConversations(group.id)
    this.commitSceneMutation()
  }

  private addFriendship(firstId: string, secondId: string): SandboxFriendship {
    const existing = this.getFriendship(firstId, secondId)
    if (existing) return existing
    const friendship = createFriendship(firstId, secondId)
    this.scene.friendships.push(friendship)
    ensureDirectRootConversation(this.scene, firstId, secondId)
    return friendship
  }

  private getFriendship(firstId: string, secondId: string) {
    return this.scene.friendships.find(({ participantIds }) => participantIds.includes(firstId) && participantIds.includes(secondId))
  }

  private getParticipant(id: string): SandboxUser | SandboxBotProfile {
    const user = this.getUsers().find((item) => item.id === id)
    const bot = this.getBots().find((item) => item.id === id)
    if (user) return user
    if (bot) return bot
    throw new SandboxDomainError(`参与者不存在：${id}`)
  }

  private isBot(id: string | undefined): boolean {
    return !!id && this.getBots().some((bot) => bot.id === id)
  }

  /** 操作者是机器人时取它的实现配置；WebQQ 用户的操作不经 OneBot，按默认的 NapCat 口径解析数字 ID。 */
  private implementationOf(participantId: string): SandboxImplementationProfile {
    return this.getBots().find(({ id }) => id === participantId)?.implementation ?? 'napcat'
  }

  private async dispatchFriendRequest(botId: string, userId: string, flag: string, comment?: string) {
    const bot = this.runtimeBots.get(botId)
    if (!bot) throw new SandboxDomainError(`机器人运行时不存在：${botId}`)
    const session = bot.session({
      type: 'friend-request',
      timestamp: Date.now(),
      user: { id: userId, name: this.getUser(userId).name },
    })
    Object.assign(session, {
      onebot: {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(botId),
        post_type: 'request',
        request_type: 'friend',
        user_id: Number(userId),
        comment,
        flag,
      },
    })
    await this.inboundDelivery.dispatchEvent(bot, session)
  }

  private async dispatchBotNotice(botId: string, userId: string, noticeType: 'notify' | 'friend_del') {
    const bot = this.runtimeBots.get(botId)
    if (!bot) throw new SandboxDomainError(`机器人运行时不存在：${botId}`)
    const session = bot.session({
      type: 'notice',
      timestamp: Date.now(),
      user: { id: userId, name: this.getUser(userId).name },
      // channelId 使用沙盒私聊会话 ID 而非 adapter-onebot 的 `private:QQ号`，
      // 插件收到事件后 session.send() 才能直接回落到同一会话。
      channel: { id: resolveDirectConversationId(this.scene, userId, botId), type: 1 },
    })
    if (noticeType === 'notify') {
      // adapter-onebot 把 notify/poke 映射为 type=notice、subtype=poke 并附带 targetId；
      // 插件靠这些字段过滤戳一戳，缺失会导致监听器永远不匹配（如"被戳后回复"类插件）。
      Object.assign(session, { subtype: 'poke', targetId: botId })
    }
    Object.assign(session, {
      onebot: {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(botId),
        post_type: 'notice',
        notice_type: noticeType,
        sub_type: noticeType === 'notify' ? 'poke' : undefined,
        user_id: Number(userId),
        target_id: Number(botId),
      },
    })
    await this.inboundDelivery.dispatchEvent(bot, session)
  }

  private async dispatchGroupRequest(group: SandboxGroup, request: SandboxSnapshot['requests'][number]) {
    const subType = request.subType ?? 'add'
    const botIds = subType === 'invite' && this.isBot(request.targetId)
      ? [request.targetId as string]
      : group.members.flatMap(({ participantId, role }) => this.isBot(participantId) && (role === 'owner' || role === 'admin') ? [participantId] : [])
    await Promise.all(botIds.map(async (botId) => {
      const bot = this.getRuntimeBot(botId)
      const session = bot.session({
        type: 'guild-request',
        timestamp: Date.now(),
        guild: { id: group.id, name: group.name },
        user: { id: request.requesterId, name: this.getParticipant(request.requesterId).name },
      })
      Object.assign(session, {
        onebot: {
          time: Math.floor(Date.now() / 1000),
          self_id: Number(botId),
          post_type: 'request',
          request_type: 'group',
          sub_type: subType,
          group_id: Number(group.id),
          user_id: Number(request.requesterId),
          comment: request.comment,
          flag: request.id,
        },
      })
      await this.inboundDelivery.dispatchEvent(bot, session)
    }))
  }

  private async dispatchGroupNotice(
    group: SandboxGroup,
    noticeType: string,
    data: Record<string, unknown> | ((botId: string) => Record<string, unknown>),
    options: { messageId?: string } = {},
  ): Promise<void> {
    const botIds = group.members.flatMap(({ participantId }) => this.isBot(participantId) ? [participantId] : [])
    await Promise.all(botIds.map(async (botId) => {
      const bot = this.getRuntimeBot(botId)
      const noticeData = typeof data === 'function' ? data(botId) : data
      const userId = noticeData.user_id === undefined ? undefined : String(noticeData.user_id)
      const operatorId = noticeData.operator_id === undefined ? undefined : String(noticeData.operator_id)
      const user = userId ? this.getParticipant(userId) : undefined
      const operator = operatorId ? this.getParticipant(operatorId) : undefined
      const member = userId ? group.members.find(({ participantId }) => participantId === userId) : undefined
      const standardType = noticeType === 'group_increase'
        ? (userId === botId ? 'guild-added' : 'guild-member-added')
        : noticeType === 'group_decrease'
          ? (userId === botId ? 'guild-removed' : 'guild-member-removed')
          : noticeType === 'group_name'
            ? 'guild-updated'
            : noticeType === 'group_admin' || noticeType === 'group_card' || noticeType === 'group_owner'
              ? 'guild-member-updated'
              : noticeType === 'group_recall'
                ? 'message-deleted'
                : 'notice'
      const session = bot.session({
        type: standardType,
        timestamp: Date.now(),
        guild: { id: group.id, name: group.name },
        // channelId 与消息事件一致使用沙盒群会话 ID，插件在通知回调里 session.send() 才能落回本群。
        channel: { id: resolveGroupConversationId(this.scene, group.id), type: 0 },
        user: user ? { id: user.id, name: user.name, avatar: user.avatar, isBot: this.isBot(user.id) } : undefined,
        operator: operator ? { id: operator.id, name: operator.name, avatar: operator.avatar, isBot: this.isBot(operator.id) } : undefined,
        member: member && user ? {
          user: { id: user.id, name: user.name, avatar: user.avatar, isBot: this.isBot(user.id) },
          name: user.name,
          nick: member.card ?? user.name,
          roles: [{ id: member.role }],
        } : undefined,
        message: options.messageId ? { id: options.messageId, messageId: options.messageId } : undefined,
      })
      if (noticeType === 'notify' && noticeData.sub_type === 'poke') {
        // 与 adapter-onebot 对齐：群戳一戳的 session 需要 subtype=poke 与 targetId，插件靠它们过滤事件。
        Object.assign(session, {
          subtype: 'poke',
          targetId: noticeData.target_id === undefined ? undefined : String(noticeData.target_id),
        })
      }
      Object.assign(session, {
        onebot: {
          time: Math.floor(Date.now() / 1000),
          self_id: Number(botId),
          post_type: 'notice',
          notice_type: noticeType,
          group_id: Number(group.id),
          ...noticeData,
        },
      })
      await this.inboundDelivery.dispatchEvent(bot, session)
      if (standardType !== 'notice') {
        // OneBot 插件仍会监听原始 notice；标准事件和原始事件必须复用同一个 Session，
        // 避免重复派发 internal/session 导致调试记录和等待器各收到两次。
        ;(this.ctx.emit as unknown as (session: unknown, name: string, payload: unknown) => void)(session, 'notice', session)
      }
    }))
  }

  private deleteConversations(predicate: (conversation: ResolvedConversation) => boolean): void {
    this.cascadeRemovedConversations(removeConversations(this.scene, predicate))
  }

  /**
   * 会话消失后的级联清理，按已被移出会话集合的 ID 执行。删除根会话、删除会话实例与解散
   * 群组走同一条清理路径，避免「删实例」漏掉其中任何一步。
   */
  private cascadeRemovedConversations(removedIds: ReadonlySet<string>): void {
    if (!removedIds.size) return
    const removedMessageIds = new Set(this.scene.messages
      .filter(({ conversationId }) => removedIds.has(conversationId))
      .map(({ id }) => id))
    this.chatLunaState.deleteByConversationIds(removedIds)
    // 媒体回收改由 commitSceneMutation 统一按引用扫描，避免共享头像/附件被提前删除。
    this.scene.messages = this.scene.messages.filter(({ conversationId }) => !removedIds.has(conversationId))
    this.botDeliveries = this.botDeliveries.filter(({ messageId }) => !removedMessageIds.has(messageId))
    // 删除会话消息后级联清理不再被任何存活消息/嵌套节点引用的 forward，
    // 否则 getMediaReferences 会永久钉住节点媒体，且残留 authorId 会卡住后续 replaceScene。
    this.pruneUnreferencedForwards()
  }

  // 从仍被消息引用的外层 forward 出发 BFS，保留可达嵌套资源，删除其余孤儿。
  private pruneUnreferencedForwards(): void {
    const forwards = this.getForwards()
    if (!forwards.length) return
    const byId = new Map(forwards.map((forward) => [forward.id, forward]))
    const reachable = new Set<string>()
    const queue: string[] = []
    for (const message of this.scene.messages) {
      if (!message.forwardId || !byId.has(message.forwardId) || reachable.has(message.forwardId)) continue
      reachable.add(message.forwardId)
      queue.push(message.forwardId)
    }
    while (queue.length) {
      const current = byId.get(queue.shift()!)
      if (!current) continue
      for (const node of current.nodes) {
        if (!node.forwardId || !byId.has(node.forwardId) || reachable.has(node.forwardId)) continue
        reachable.add(node.forwardId)
        queue.push(node.forwardId)
      }
    }
    if (reachable.size === forwards.length) return
    this.scene.forwards = forwards.filter(({ id }) => reachable.has(id))
  }

  private validateGroupMembers(members: SandboxSnapshot['groups'][number]['members']) {
    const participantIds = new Set<string>()
    let ownerId = ''
    const result = members.map((member) => {
      if (participantIds.has(member.participantId)) throw new SandboxDomainError(`群成员重复：${member.participantId}`)
      const user = this.getUsers().find(({ id }) => id === member.participantId)
      const bot = this.getBots().find(({ id }) => id === member.participantId)
      if (!user && !bot) throw new SandboxDomainError(`群成员不存在：${member.participantId}`)
      if (member.role === 'owner') {
        // 普通用户和虚拟 OneBot 机器人共享同一套群角色，群主只要求是有效参与者。
        if (ownerId) throw new SandboxDomainError('群组只能有一个群主')
        ownerId = member.participantId
      }
      participantIds.add(member.participantId)
      return {
        participantId: member.participantId,
        card: member.card?.trim() || undefined,
        role: member.role,
        title: member.title?.trim() || undefined,
        mutedUntil: isSandboxGroupMemberMuted(member) ? member.mutedUntil : undefined,
        area: member.area?.trim() || undefined,
        joinTime: typeof member.joinTime === 'number' ? Math.trunc(member.joinTime) : undefined,
        lastSentTime: typeof member.lastSentTime === 'number' ? Math.trunc(member.lastSentTime) : undefined,
        level: member.level?.trim() || undefined,
        unfriendly: typeof member.unfriendly === 'boolean' ? member.unfriendly : undefined,
        titleExpireTime: typeof member.titleExpireTime === 'number' ? Math.trunc(member.titleExpireTime) : undefined,
        cardChangeable: typeof member.cardChangeable === 'boolean' ? member.cardChangeable : undefined,
      }
    })
    if (!ownerId) throw new SandboxDomainError('群组必须有一个群主')
    return result
  }

  private syncGroupConversations(groupId: string): void {
    const group = this.scene.groups.find(({ id }) => id === groupId)
    if (!group) return
    ensureGroupRootConversation(this.scene, groupId)
  }
}

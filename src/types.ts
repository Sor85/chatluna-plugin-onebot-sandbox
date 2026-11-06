
// 账号资料、好友备注、群成员资料和机器人运行资料保持独立类型，避免把备注/群名片误当成全局资料。
export type SandboxAccountSex = 'male' | 'female' | 'unknown'

export interface SandboxAccountProfile {
  personalNote?: string
  sex?: SandboxAccountSex
  age?: number
  qid?: string
  level?: number
  loginDays?: number
  regTime?: number
  city?: string
  country?: string
  birthdayYear?: number
  birthdayMonth?: number
  birthdayDay?: number
  labels?: string[]
  isVip?: boolean
  isYearsVip?: boolean
  vipLevel?: number
}

interface SandboxParticipantBase {
  id: string
  name: string
  avatar?: string
  // 全局账号资料；好友备注和群成员资料不在这里。
  profile?: SandboxAccountProfile
}

export type SandboxEntitySource =
  | { type: 'main', name: string }
  | { type: 'test-space', spaceId: string, name: string }

export interface SandboxUser extends SandboxParticipantBase {
  kind: 'user'
}

export type CreateSandboxUserInput = Omit<SandboxUser, 'kind'>

export type UpdateSandboxUserInput = CreateSandboxUserInput

export interface DeleteSandboxUserInput {
  id: string
}

export type SandboxImplementationProfile = 'napcat' | 'llbot' | 'snowluma'

// 机器人运行资料：实现配置、启用状态和能力覆盖，独立于账号资料。
export interface SandboxBotRuntimeProfile {
  implementation: SandboxImplementationProfile
  enabled: boolean
  disabledCapabilities?: string[]
}

export interface SandboxBotProfile extends SandboxParticipantBase, SandboxBotRuntimeProfile {
  kind: 'bot'
}

export type CreateSandboxBotInput = Omit<SandboxBotProfile, 'kind'>

export type UpdateSandboxBotInput = CreateSandboxBotInput

export type SandboxDirectoryBot = SandboxBotProfile & { source: SandboxEntitySource }

export type SandboxParticipant = SandboxUser | SandboxBotProfile

export function isSandboxUser(participant: SandboxParticipant): participant is SandboxUser {
  return participant.kind === 'user'
}

export function isSandboxBot(participant: SandboxParticipant): participant is SandboxBotProfile {
  return participant.kind === 'bot'
}

export function getSandboxUsers(snapshot: Pick<SandboxSnapshot, 'participants'>): SandboxUser[] {
  return snapshot.participants.filter(isSandboxUser)
}

export function getSandboxBots(snapshot: Pick<SandboxSnapshot, 'participants'>): SandboxBotProfile[] {
  return snapshot.participants.filter(isSandboxBot)
}

export interface DeleteSandboxBotInput {
  id: string
}

export type SandboxGroupRole = 'owner' | 'admin' | 'member'

export interface SandboxGroupMember {
  participantId: string
  card?: string
  role: SandboxGroupRole
  // 专属头衔由群主授予，与群名片相互独立，同一参与者在不同群组各自持有。
  title?: string
  // 禁言到期时间；仅在未到期时表示成员处于禁言状态，过期条目由读取方按当前时间判断。
  mutedUntil?: string
  // 以下字段属于群成员资料，不回写到账号全局资料。
  area?: string
  joinTime?: number
  lastSentTime?: number
  level?: string
  unfriendly?: boolean
  titleExpireTime?: number
  cardChangeable?: boolean
}

// 禁言状态按到期时间保存，读取方统一在此判断是否仍然生效，避免各处重复比较时间。
export function isSandboxGroupMemberMuted(member: Pick<SandboxGroupMember, 'mutedUntil'>, now = Date.now()): boolean {
  return !!member.mutedUntil && new Date(member.mutedUntil).getTime() > now
}

export interface SandboxGroupAnnouncement {  id: string
  authorId: string
  content: string
  createdAt: string
}

export interface SandboxGroup {
  id: string
  name: string
  avatar?: string
  members: SandboxGroupMember[]
  announcements: SandboxGroupAnnouncement[]
}

export interface CreateSandboxGroupInput {
  id: string
  name: string
  avatar?: string
  members: SandboxGroupMember[]
}

export interface UpdateSandboxGroupInput extends CreateSandboxGroupInput {}

export interface DeleteSandboxGroupInput {
  id: string
}

export type ManageSandboxEnvironmentInput =
  | { action: 'create-user', data: CreateSandboxUserInput }
  | { action: 'update-user', data: UpdateSandboxUserInput }
  | { action: 'delete-user', data: DeleteSandboxUserInput }
  | { action: 'create-bot', data: CreateSandboxBotInput }
  | { action: 'update-bot', data: UpdateSandboxBotInput }
  | { action: 'delete-bot', data: DeleteSandboxBotInput }
  | { action: 'create-group', data: CreateSandboxGroupInput }
  | { action: 'update-group', data: UpdateSandboxGroupInput }
  | { action: 'delete-group', data: DeleteSandboxGroupInput }

export interface SandboxDirectConversation {
  id: string
  type: 'direct'
  participantIds: readonly [string, string]
  groupId?: never
  messageIds: string[]
  hasMoreMessages?: boolean
}

export interface SandboxGroupConversation {
  id: string
  type: 'group'
  groupId: string
  participantIds?: never
  messageIds: string[]
  hasMoreMessages?: boolean
}

export type SandboxConversation = SandboxDirectConversation | SandboxGroupConversation

/**
 * 分叉点：会话实例记录的来源消息，它界定继承前缀的范围。
 *
 * 只记这一对「来源会话 + 来源消息」，不存一份前缀消息 ID 快照：消息只追加不插入，因此
 * 「来源会话当前列表到分叉点为止」与「分叉时刻的前缀」在正常路径上等价，两者只在来源会话
 * 被清空或被保留窗口淘汰时不同，而那两种情况下消息正文本身已经不存在，多存一份 ID 列表
 * 也救不回来。
 */
export interface SandboxConversationForkPoint {
  /** 来源会话 ID，可以是根会话也可以是另一个会话实例。 */
  conversationId: string
  /** 分叉点消息 ID；它及其之前的那一段是继承前缀，分叉点本身包含在内。 */
  messageId: string
}

/**
 * 会话实例：根会话下的一条独立对话线，拥有自己的消息与标题。
 *
 * 只保存所属根会话 ID；参与者对与群号一律从根会话读，因此关系变更不需要同步两处。
 * 可见性完全继承根会话，不引入创建者或所有权维度。会话实例不出现在根会话集合里，
 * 既有「遍历根会话」的实现因此默认只看到根会话。
 */
export interface SandboxConversationInstance {
  id: string
  rootConversationId: string
  title: string
  /** 分叉点；缺失表示这条对话线只有自有消息。 */
  forkPoint?: SandboxConversationForkPoint
  /**
   * 自有消息，继承前缀不在其中——分支不复制消息，同一条逻辑消息在场景里只有一个身份。
   * 需要「这个会话由哪些消息组成」时读会话解析模块的 readConversationMessageIds。
   */
  messageIds: string[]
  hasMoreMessages?: boolean
}

export function createDirectConversationId(firstId: string, secondId: string): string {
  const [left, right] = [firstId, secondId].sort()
  return `private:${left}:${right}`
}

export function createGroupConversationId(groupId: string): string {
  return `group:${groupId}`
}

/**
 * 机器人回复在 ChatLuna v2 trace 里的位置：会话 ID 加回合与步序，对应 trace 页
 * `/traces/:sessionId?turn=&step=` 的深链。取自产生这条回复的那一步模型调用。
 */
export interface SandboxMessageTraceReference {
  sessionId: string
  turn: number
  step: number
}

export interface SandboxMessageChatLuna {
  thought: string
  thoughtDurationMs?: number
  usage?: SandboxChatLunaTokenUsage
  trace?: SandboxMessageTraceReference
}

export interface SandboxMessageReaction {
  emojiId: string
  participantIds: string[]
}

// 可见消息不携带 lifecycle；一旦进入撤回状态，撤回者与时间必须作为完整事实同时存在。
export interface SandboxRecalledMessageLifecycle {
  status: 'recalled'
  operatorId: string
  recalledAt: string
}

// 合并转发节点保存作者快照与正文/媒体；删除参与者或改名不影响历史 node。
export interface SandboxForwardNode {
  userId: string
  nickname: string
  content: string
  createdAt: string
  media?: SandboxMedia[]
  // 引用节点可保留来源消息 ID，便于调试与测试断言。
  sourceMessageId?: string
  // 节点本身是嵌套合并转发时，只保存转发资源 ID，详情再按资源读取。
  forwardId?: string
}

// 合并转发是独立资源：外层消息只挂 forwardId，完整 node 列表通过资源读取。
export interface SandboxForward {
  id: string
  authorId: string
  createdAt: string
  /** 卡片标题。从私聊多选转发时为「A和B的聊天记录」；缺省（群聊来源、自定义节点）显示「群聊的聊天记录」。 */
  title?: string
  nodes: SandboxForwardNode[]
}

// OneBot 自定义节点与领域 builder 共用同一输入形状。
export type SandboxForwardNodeInput =
  | {
    type: 'reference'
    messageId: string
  }
  | {
    type: 'custom'
    userId: string
    nickname: string
    content: string
    createdAt?: string
    media?: SandboxMedia[]
    forwardId?: string
  }

interface SandboxMessageBase {
  id: string
  authorId: string
  conversationId: string
  content: string
  createdAt: string
  replyToMessageId?: string
  broadcastId?: string
  media?: SandboxMedia[]
  // 外层消息只挂资源 ID；完整 node 列表保存在场景 forwards 集合中。
  forwardId?: string
  // 表情回应按 emoji 聚合参与者，与真实 QQ 一致：同一人对同一 emoji 只计一次。
  reactions?: SandboxMessageReaction[]
  // 本轮 ChatLuna 思考内容随消息一起落场景快照，多轮对话后仍能查看历史思考。
  chatLuna?: SandboxMessageChatLuna
  // 仅用于戳一戳等消息事件；撤回不再占用 event，改用 lifecycle。
  event?: {
    type: 'poke'
    targetId: string
  }
}

// 撤回是消息生命周期状态，不是新的系统消息；权威场景始终保留原文与附属事实。
export type SandboxMessage = SandboxMessageBase & (
  | { lifecycle?: undefined }
  | { lifecycle: SandboxRecalledMessageLifecycle }
)

/**
 * 合并转发节点自己的正文。
 *
 * 自定义节点可以同时带文字、媒体与嵌套转发，文字照常保留；但带嵌套转发时，`[合并转发]` 占位与
 * 引用一条合并转发消息带来的摘要都和嵌套卡片重复，不算正文。服务端摘要、OneBot 节点与界面共用这一条。
 */
export function forwardNodeText(node: Pick<SandboxForwardNode, 'content' | 'forwardId' | 'sourceMessageId'>): string {
  if (node.forwardId && (node.sourceMessageId || node.content.trim() === '[合并转发]')) return ''
  return node.content
}

export function isRecalledMessage(
  message: SandboxMessage | undefined | null,
): message is SandboxMessage & { lifecycle: SandboxRecalledMessageLifecycle } {
  return message?.lifecycle?.status === 'recalled'
}

export function formatRecalledMessageEventText(
  message: SandboxMessage & { lifecycle: SandboxRecalledMessageLifecycle },
  operatorName: string,
): string {
  return `${operatorName || message.lifecycle.operatorId} 撤回了一条消息`
}

export interface SandboxBotDelivery {
  id: string
  recipientBotId: string
  messageId: string
  conversationId: string
  createdAt: string
}

export interface SandboxChatLunaTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface SandboxChatLunaState {
  botParticipantId: string
  conversationId: string
  thinking: boolean
  usage?: SandboxChatLunaTokenUsage
  updatedAt: string
}

export type SandboxPersistenceMode = 'memory' | 'database'

export interface SandboxPersistenceStatus {
  mode: SandboxPersistenceMode
  available: boolean
  persisted: boolean
  message?: string
}

export type SandboxOneBotDebugDirection = 'action' | 'event'
export type SandboxOneBotDebugStatus = 'success' | 'error'

export interface SandboxOneBotDebugError {
  code: string
  message: string
  retryable: boolean
  traceId: string
}

/**
 * 一次原始 OneBot action 与触发它的入站事件来源会话之间的关系观察。
 *
 * 真实 QQ 的 action 表面没有「会话」这一级，插件只能按账号或群号寻址。沙盒对写入和读取作了
 * 相反的取舍，两者都留成可断言的证据而不是警告日志：
 *
 * - 写入落点不归位。回复落到根会话是测试者在界面上看得见的事实，替插件归位会让沙盒行为与真实
 *   环境分叉，而分叉过的沙盒证明不了任何事情，因此只记 `reply-left-event-conversation`。
 * - 读取跟随来源会话。历史查询的结果会静默变成模型输入，照字面答成根会话会让插件在会话实例里
 *   读到另一条对话线的历史，分支测试因此不成立；跟随记 `history-followed-event-conversation`。
 */
export interface SandboxOneBotConversationObservation {
  kind: 'reply-left-event-conversation' | 'history-followed-event-conversation'
  /** 触发这次 action 的入站事件来自哪个会话；一定是会话实例。 */
  eventConversationId: string
  /** action 实际操作了哪个会话：写入是落点（来源实例的根会话），读取是真正读到的那个会话。 */
  conversationId: string
}

export interface SandboxOneBotDebugRecord {
  id: string
  /** 空间内单调递增、回收后也不复用的序号。 */
  sequence: number
  createdAt: string
  botId: string
  implementation: SandboxImplementationProfile
  direction: SandboxOneBotDebugDirection
  /** 插件实际请求的 action 名；事件方向则为原始事件类型。 */
  requestedAction: string
  /** 能力矩阵中的规范 action；事件方向与 requestedAction 相同。 */
  action: string
  /** 仅当 requestedAction 通过矩阵别名命中时存在。 */
  matchedAlias?: string
  status: SandboxOneBotDebugStatus
  durationMs: number
  payload?: unknown
  result?: unknown
  entities: {
    userId?: string
    groupId?: string
    conversationId?: string
    messageId?: string
  }
  error?: SandboxOneBotDebugError
  /**
   * 仅当这次 action 与触发它的入站事件来源会话之间产生了值得断言的关系时存在：
   * 回复落到了根会话，或历史读取跟随了来源实例。
   */
  conversationObservation?: SandboxOneBotConversationObservation
}

export type SandboxConsoleOneBotDebugRecord = SandboxOneBotDebugRecord & { source: SandboxEntitySource }

export interface GetSandboxOneBotDebugRecordsInput {
  botId?: string
  direction?: SandboxOneBotDebugDirection
  /** 匹配规范 action，并自动覆盖能力矩阵声明的全部别名。 */
  action?: string
  /** 仅精确匹配插件实际请求名。 */
  requestedAction?: string
  /**
   * 按调用结果筛选；省略时两种结果都返回。
   *
   * 取值集合就是记录自己的状态词汇，因此「只看成功的」与「只看失败的」是对称的两种筛选。
   * 此前这里是 `errorsOnly` 布尔，只能表达其中一半。
   */
  status?: SandboxOneBotDebugStatus
  /** 按创建时间正序或倒序，默认倒序。 */
  order?: 'asc' | 'desc'
  /** 每页条数，默认 50，最大 200。 */
  limit?: number
  /** 分页游标：倒序仅返回 sequence 更小的记录，正序仅返回 sequence 更大的记录。 */
  beforeSequence?: number
}

export interface SandboxOneBotDebugLargeValueSummary {
  kind: 'large-value'
  encoding: 'base64' | 'data-url'
  mimeType?: string
  charCount: number
  byteLength: number
  sha256: string
}

export interface SandboxOneBotDebugCapacity {
  recordCount: number
  totalBytes: number
  maxRecords: number
  maxBytes: number
}

export interface SandboxOneBotDebugRecordsPage<T extends SandboxOneBotDebugRecord = SandboxOneBotDebugRecord> {
  records: T[]
  hasMore: boolean
  /** 下一页应传入的 beforeSequence。 */
  nextCursor?: number
  /** 当前仍保留的最早 sequence；游标过期恢复时可用。 */
  earliestCursor?: number
  capacity: SandboxOneBotDebugCapacity
}

export interface GetSandboxOneBotDebugRecordInput {
  recordId: string
  /** 仅单条详情允许展开大型值；列表接口不得接受此参数。 */
  includeLargeValues?: boolean
}

export interface ClearSandboxOneBotDebugRecordsResult {
  cleared: number
}

/**
 * 可预期的领域业务拒绝：参数不合法、权限不足、场景一致性校验不通过这类由领域规则主动作出的判定。
 *
 * 它存在的唯一理由是让上层能把「领域说不」与「实现出错」分开：MCP 侧只把未预期异常
 * 降级成 `internal_error` 并把堆栈写进 Logger，而领域拒绝的消息对外部测试控制器有用，必须原样透出。
 * 基础设施故障（数据库不可用）与内部不变量违背不属于此类，应继续抛普通 `Error`。
 */
export class SandboxDomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxDomainError'
  }
}

/** 指定的 AI 测试空间不存在；对外归一为 `space_not_found`（HTTP 404），而不是笼统的领域拒绝。 */
export class SandboxSpaceNotFoundError extends SandboxDomainError {
  constructor(spaceId: string) {
    super(`AI 测试空间不存在：${spaceId}`)
    this.name = 'SandboxSpaceNotFoundError'
  }
}

export class SandboxOneBotDebugCursorExpiredError extends SandboxDomainError {
  readonly code = 'cursor_expired' as const

  constructor(
    message: string,
    readonly earliestCursor?: number,
  ) {
    super(message)
    this.name = 'SandboxOneBotDebugCursorExpiredError'
  }
}

export type SandboxMediaType = 'image' | 'file' | 'audio' | 'video'


export interface SandboxMedia {
  id: string
  type: SandboxMediaType
  name: string
  mimeType: string
  size: number
  reference: string
}

export interface SandboxRelationshipRequest {
  id: string
  type: 'friend' | 'group'
  subType?: 'add' | 'invite'
  requesterId: string
  targetId?: string
  groupId?: string
  status: 'pending'
  createdAt: string
  comment?: string
}

export interface SandboxFriendship {
  id: string
  participantIds: [string, string]
  remarks: Record<string, string>
  createdAt: string
}

export interface SandboxSnapshot {
  revision: number
  participants: SandboxParticipant[]
  groups: SandboxGroup[]
  conversations: SandboxConversation[]
  // 会话实例是独立集合：既有「遍历根会话」的实现因此默认只看到根会话，需要全部会话的
  // 少数路径（消息搜索、保留窗口裁剪、场景导出）经会话解析模块显式合并两个集合。
  // 读取路径统一把缺失值规范成 []，以便旧测试夹具与未改动的客户端空快照继续通过类型检查。
  conversationInstances?: SandboxConversationInstance[]
  messages: SandboxMessage[]
  // 合并转发资源与消息解耦；重启后仍可按 forwardId 展开完整 node。
  // 读取路径统一把缺失值规范成 []，以便旧测试夹具与未改动的客户端空快照继续通过类型检查。
  forwards?: SandboxForward[]
  friendships: SandboxFriendship[]
  requests: SandboxRelationshipRequest[]
}

export type SandboxFriendAction =
  | { action: 'request'; targetId: string; comment?: string }
  | { action: 'handle-request'; requestId: string; approve: boolean }
  | { action: 'delete'; targetId: string }
  | { action: 'set-remark'; targetId: string; remark: string }
  | { action: 'poke'; targetId: string; conversationId?: string }

export type PerformFriendActionInput = SandboxFriendAction extends infer Action
  ? Action extends SandboxFriendAction ? Action & { operatorId: string } : never
  : never

export interface PerformFriendActionResult {
  revision: number
  requestId?: string
}

export type SandboxGroupAction =
  | { action: 'request-join'; groupId: string; comment?: string }
  | { action: 'invite'; groupId: string; targetId: string; comment?: string }
  | { action: 'handle-request'; requestId: string; approve: boolean }
  | { action: 'leave'; groupId: string }
  | { action: 'kick'; groupId: string; targetId: string }
  | { action: 'set-admin'; groupId: string; targetId: string; enabled: boolean }
  | { action: 'transfer-owner'; groupId: string; targetId: string }
  | { action: 'set-card'; groupId: string; targetId: string; card: string }
  | { action: 'set-title'; groupId: string; targetId: string; title: string }
  | { action: 'set-name'; groupId: string; name: string }
  | { action: 'poke'; groupId: string; targetId: string; conversationId?: string }

export type PerformGroupActionInput = SandboxGroupAction extends infer Action
  ? Action extends SandboxGroupAction ? Action & { operatorId: string } : never
  : never

export interface PerformGroupActionResult {
  revision: number
  requestId?: string
}

export interface SandboxAppearance {
  sandboxTimBubbleTail: boolean
  // 亮色主题下对方气泡的轮廓：shadow 是源插件的半透明白底加投影，outline 是白底加细描边。
  sandboxIncomingBubbleStyle: 'shadow' | 'outline'
  // WebQQ 的强调色：出站气泡、发送框、选中态都取它，不跟随 v2 主题的 primary。
  sandboxAccentColor: string
  // 只控制 WebQQ 呈现；关闭时隐藏原气泡并显示撤回事件，底层数据仍保留。
  sandboxMarkRecalledMessages: boolean
}

export interface SandboxWorkspaceState {
  snapshot: SandboxSnapshot
  chatLunaStates: SandboxChatLunaState[]
  appearance: SandboxAppearance
  persistence: SandboxPersistenceStatus
}

export interface GetSandboxWorkspaceInput {
  operatorId?: string
  messageLimit?: number
}

export interface GetSandboxBotDeliveriesInput {
  messageId?: string
}

export interface GetMessageHistoryInput {
  operatorId: string
  conversationId: string
  beforeMessageId?: string
  limit?: number
}

export interface SandboxMessageHistory {
  messages: SandboxMessage[]
  // 历史页直接引用的转发资源；嵌套详情仍按 getForwardMessage 按需读取。
  forwards?: SandboxForward[]
  nextBeforeMessageId?: string
}

// 当前会话内按正文和/或创建时间查找：游标语义与 getMessageHistory 一致，命中只返回摘要。
export interface SearchConversationMessagesInput {
  operatorId: string
  conversationId: string
  query: string
  // 成对提供，使用 [createdAtStart, createdAtEnd) 半开区间。
  createdAtStart?: string
  createdAtEnd?: string
  beforeMessageId?: string
  limit?: number
}

export interface SandboxMessageSearchHit {
  messageId: string
  /**
   * 命中消息真正归属的会话。在分支里搜到继承前缀时它是那条消息所属的来源会话而不是分支——
   * 一条逻辑消息只有一个会话身份，按分支重复报告会让结果随分支数膨胀。
   */
  conversationId: string
  authorId: string
  createdAt: string
  // 命中摘要使用消息 content 原文；撤回消息仍可搜到底层正文。
  summary: string
}

export interface SandboxMessageSearchResult {
  // 由新到旧排列，便于搜索面板直接渲染。
  hits: SandboxMessageSearchHit[]
  nextBeforeMessageId?: string
}

// WebQQ 消息列表外层卡片用的轻量预览，不替代完整 SandboxForward 资源。
export interface SandboxForwardPreview {
  title: string
  total: number
  lines: string[]
}

export interface SendMessageInput {
  operatorId: string
  conversationId: string
  content: string
  replyToMessageId?: string
}

export interface SendMessageResult {
  messageId: string
  revision: number
}

export interface CreateConversationInstanceInput {
  operatorId: string
  /** 所属会话；传入会话实例时归一化到它的根会话，不产生第三层。 */
  rootConversationId: string
  title?: string
}

export interface BranchConversationInstanceInput {
  operatorId: string
  /** 分叉来源会话，可以是根会话也可以是会话实例。 */
  conversationId: string
  /** 分叉点消息；它及其之前的那一段成为新实例的继承前缀，不复制消息。 */
  messageId: string
  title?: string
}

/** 会话实例变更返回完整工作区状态外加新会话 ID，客户端一次请求完成状态替换与选中。 */
export interface SandboxConversationInstanceResult extends SandboxWorkspaceState {
  conversationId: string
}

export interface RenameConversationInstanceInput {
  operatorId: string
  conversationId: string
  title: string
}

export interface DeleteConversationInstanceInput {
  operatorId: string
  conversationId: string
}

export interface SendForwardMessageInput {
  operatorId: string
  conversationId: string
  // WebQQ 多选：服务端按 createdAt + id 稳定排序后生成引用 node。
  messageIds?: string[]
  // OneBot 或内部 builder：可混合引用节点与自定义节点。
  nodes?: SandboxForwardNodeInput[]
}

export interface SendForwardMessageResult extends SendMessageResult {
  forwardId: string
}

export interface GetForwardMessageInput {
  operatorId: string
  // 标准 get_forward_msg 使用转发资源 ID；兼容 message_id 时由调用方解析外层消息。
  forwardId?: string
  messageId?: string
}

export interface RecallMessageInput {
  operatorId: string
  conversationId?: string
  messageId: string
}

export interface ClearConversationMessagesInput {
  operatorId: string
  conversationId: string
}

export interface SetMessageReactionInput {
  operatorId: string
  /**
   * 请求发起时所在的会话。给出时要求它就是消息自身的归属会话，因此在分支里对继承前缀贴表情
   * 会被拒——继承前缀是与原会话共享的同一份记录，在分支视图里只读。
   *
   * 省略表示按消息自身的归属执行：插件通过原始 OneBot 寻址的是根会话的一条普通消息，
   * 只读约束的是用户在分支视图里的入口，不是消息实体的生命周期。
   */
  conversationId?: string
  messageId: string
  emojiId: string
  enabled: boolean
}

export interface SendMediaFileInput {
  fileName: string
  mimeType: string
  dataBase64: string
}

export interface SendMediaMessageInput {
  operatorId: string
  conversationId: string
  media: SendMediaFileInput[]
  content?: string
  replyToMessageId?: string
}

export interface GetMediaContentInput {
  operatorId: string
  mediaId: string
}

export interface SandboxMediaContent extends SandboxMedia {
  dataBase64: string
}

export interface SetGroupAnnouncementInput {
  operatorId: string
  groupId: string
  content: string
}

export interface DeleteGroupAnnouncementInput {
  operatorId: string
  groupId: string
  announcementId: string
}

export interface ListGroupAnnouncementsInput {
  operatorId: string
  groupId: string
}

/**
 * 一条群系统消息：待审批的入群申请或群邀请，按调用方机器人能看见的那些投影出来。
 *
 * 字段是领域事实而不是 OneBot 字段名——各实现配置对同一件事用的键并不相同（LLBot 的入群
 * 申请是 `requester_uin`，NapCat 两个桶共用同一份 schema，SnowLuma 干脆不分桶），
 * 翻译留在机器人适配器里。
 */
export interface SandboxGroupSystemMessage {
  /** 入群申请还是群邀请；两者在 OneBot 返回里落进不同的桶。 */
  kind: 'join' | 'invite'
  /** 申请标识；它同时就是审批这条申请要传的 flag。 */
  requestId: string
  groupId: string
  groupName: string
  /** 入群申请的申请人，或群邀请的邀请人。 */
  initiatorId: string
  initiatorName: string
  /** 申请附言，缺省为空串。 */
  comment: string
  /** 是否已处理；沙盒场景只保存待处理申请，因此当前恒为 false。 */
  checked: boolean
}

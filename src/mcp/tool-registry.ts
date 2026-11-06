import { createHash, randomBytes } from 'node:crypto'
import {
  normalizeFriendshipRemarks,
  normalizeGroupMemberFromUnknown,
  parseAccountProfileFromUnknown,
} from '../account-profile'
import type { SandboxWakeupRules, SandboxWakeupTarget } from '../chatluna/wakeup'
import type { SandboxControlService } from '../control-service'
import {
  ensureDirectRootConversation,
  ensureGroupRootConversation,
  listRootConversationInstances,
  listRootConversations,
  readConversationMessageIds,
  resolveConversation,
  type ResolvedConversation,
} from '../conversation-resolution'
import { getOneBotCapabilityMatrix } from '../onebot-profiles'
import { DEFAULT_DEBUG_PAGE_SIZE, MAX_DEBUG_PAGE_SIZE } from '../onebot-debug'
import type { SandboxTestSpaceService } from '../test-spaces'
import type {
  SandboxForwardNodeInput,
  SandboxImplementationProfile,
  SandboxMedia,
  SandboxOneBotDebugDirection,
  SandboxOneBotDebugRecordsPage,
  SandboxOneBotDebugStatus,
  SandboxSnapshot,
} from '../types'
import { SandboxOneBotDebugCursorExpiredError } from '../types'
import { argumentsFingerprint, asRecord, optionalBoolean, optionalEnum, optionalNumber, requireNumber, requireString } from './arguments'
import {
  DEFAULT_TEST_CALL_PAGE_SIZE,
  MAX_TEST_CALL_PAGE_SIZE,
  type ListSandboxTestCallRecordsInput,
  type SandboxTestCallRecordsPage,
} from './call-records'
import {
  encodePageCursor,
  readPageCursor,
} from './page-cursor'
import {
  SandboxMcpError,
  SANDBOX_MCP_EVENT_TYPES,
  type SandboxTestCallRecord,
  type SandboxTestCallTransport,
  type SandboxMcpEvent,
  type SandboxMcpEventCursor,
  type SandboxMcpEventType,
  type SandboxMcpExport,
  type SandboxMcpToolCapability,
} from './types'

/**
 * 一次工具调用要扣的配额档。它同时是并发档：两者此前各写一句表达式，逐项比对后只有一处不同
 * ——只读档不占并发闸门——因此条目上只放一个分类，那一处差异写成调用治理里的一行。
 */
export type SandboxMcpToolQuota = 'read' | 'mutation' | 'wait' | 'upload'

/**
 * 显式空间标识的解析方式，不能从配额档推导。
 *
 * - `mutation`：按写操作解析。缺少 spaceId 且实例启用了 AI 测试空间时直接拒绝。清理 OneBot
 *   调试记录属于调试类（配额档为只读）却按写操作解析，正是「不能从配额推导」的那个反例。
 * - `read`：按读取解析。省略 spaceId 时读主场景。
 * - `none`：治理不代它解析。三族工具落在这里，理由各自成立：没有空间参数的（服务自述、空间
 *   清单、测试调用记录）无从解析；空间生命周期那五个由测试空间服务自己校验状态，经空间三态
 *   判定会把「空间当前不可修改」这类领域拒绝改写成空间不可用。
 */
export type SandboxMcpSpaceResolution = 'none' | 'read' | 'mutation'

/**
 * 等待类工具的返回形状：等到与超时是两个互斥分支。
 *
 * 此前是 `matched: boolean` 加可选载荷，于是「匹配到了但没有事件」在类型上合法，三处执行体各写
 * 一句 `!matched || !event` 防守一个不该存在的状态。换成判别式之后 `matched` 分支必带事件、
 * `timeout` 分支必带原因，防守退成一次判别。
 */
export type SandboxMcpWaitResult =
  | { outcome: 'matched'; event: SandboxMcpEvent; cursor: SandboxMcpEventCursor }
  | { outcome: 'timeout'; reason: 'timeout'; cursor: SandboxMcpEventCursor }

/** 一次性破坏性操作确认令牌的登记内容。 */
export interface SandboxMcpConfirmation {
  credentialId: string
  tool: string
  argumentsHash: string
  revision: number
  expiresAt: number
}

/**
 * 一次工具调用可用的窄运行时。
 *
 * 执行体是自由函数，只经这份 interface 触达测试控制服务，不持有服务本身，也不用方法名字符串
 * 转发——后者会让类型检查失效，写错一个名字要等到真的调用那个工具才发现。
 */
export interface SandboxMcpToolRuntime {
  /** 本次调用的控制服务：按条目的 `spaceResolution` 解析；`none` 时是主场景控制服务。 */
  readonly control: SandboxControlService
  /** 承载本次调用的协议表述，只用于服务自述与调用记录标注。 */
  readonly transport: SandboxTestCallTransport
  /** 发起本次调用的测试凭证标识，用于登记一次性确认令牌。 */
  readonly credentialId: string
  /** 参数里的空间标识原文；事件归属与媒体缓存键都取它。 */
  readonly spaceId?: string
  currentCursor(): SandboxMcpEventCursor
  /** 追加一条事件；省略 `spaceId` 时按本次调用的空间归属写入。 */
  appendEvent(type: SandboxMcpEventType, data: unknown, spaceId?: string): SandboxMcpEventCursor
  waitFor(args: Record<string, unknown>, predicate: (event: SandboxMcpEvent) => boolean): Promise<SandboxMcpWaitResult>
  /** 被测机器人当前的唤醒规则；省略 `target` 时同时给出私聊与群聊两份通用规则。 */
  readWakeupRules(targets?: readonly SandboxWakeupTarget[]): SandboxWakeupRules
  requireTestSpaces(): SandboxTestSpaceService
  rememberUploadedMedia(mediaId: string, media: SandboxMedia): void
  findUploadedMedia(mediaId: string): SandboxMedia | undefined
  rememberConfirmation(token: string, confirmation: SandboxMcpConfirmation): void
  listCallRecords(input: ListSandboxTestCallRecordsInput): SandboxTestCallRecordsPage
  getCallRecord(recordId: string): SandboxTestCallRecord
  clearCallRecords(): { cleared: number }
}

/**
 * 一个工具的全部事实。
 *
 * 名字、能力范围、说明与参数 schema 是它的对外自述；配额档、空间解析方式、幂等与确认令牌两个
 * 标记是调用治理读的字段；执行体挂在同一条条目上，因此「声明了工具但没有分派」这个状态不可
 * 表达——没有条目就没有工具，有条目就一定能执行。
 */
export interface SandboxMcpToolEntry extends SandboxMcpToolCapability {
  readonly quota: SandboxMcpToolQuota
  readonly spaceResolution: SandboxMcpSpaceResolution
  /** 同键重放返回首次结果。参数里的 `idempotencyKey` 必填由执行体之外的治理读取。 */
  readonly idempotent: boolean
  /** 需要版本绑定的一次性确认令牌，令牌校验与作用域游标失效由治理负责。 */
  readonly requiresConfirmation: boolean
  run(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>): unknown
}

// —— 工具参数 JSON Schema ——
// MCP 客户端只能从 tools/list 的 inputSchema 学习参数契约（实际校验在执行体内部完成），因此这里
// 的 schema 是给 AI 消费者的文档，必须与实现保持一致。它内联在条目上而不是另立一张按名字连接的
// 表：那种连接写法「按名字取，取不到就给一个空 schema」会让一个打错的键静默产出空 schema，而
// schema 是 AI 消费者唯一能学到参数契约的地方。
/**
 * 枚举参数的取值集合。
 *
 * 对外声明的 `enum` 与执行体的取值校验读同一个数组，因此「声明里写了但实现不认」或反过来都不可
 * 表达。带上领域类型注解而不是 `as const`：写错一个字面量在类型检查阶段就会红，而不是等到某次
 * 调用被判成非法。
 */
const RECORD_ORDERS: readonly ('asc' | 'desc')[] = ['asc', 'desc']
const ONEBOT_DEBUG_DIRECTIONS: readonly SandboxOneBotDebugDirection[] = ['event', 'action']
const ONEBOT_DEBUG_STATUSES: readonly SandboxOneBotDebugStatus[] = ['success', 'error']
const TEST_CALL_STATUSES: readonly SandboxTestCallRecord['status'][] = ['success', 'error']
const TEST_CALL_TRANSPORTS: readonly SandboxTestCallTransport[] = ['mcp', 'http', 'chatluna']

const SPACE_REQUIRED = { type: 'string', description: 'AI 测试空间 ID，由 create_test_space 返回；修改与等待类操作必填' }
const SPACE_OPTIONAL = { type: 'string', description: 'AI 测试空间 ID；省略时读取主场景' }
// 幂等窗口的具体数值由服务实例的配置决定，不能写死在这里：读取工具声明的那一处会按实际配置改写
// 这条描述，否则非默认部署会向 AI 消费者发布一份错误的契约。
const IDEMPOTENCY_KEY = { type: 'string', description: '幂等键；使用相同键重放时参数必须逐字段一致' }
const CURSOR = {
  type: 'object',
  properties: { epoch: { type: 'string' }, sequence: { type: 'number' } },
  required: ['epoch', 'sequence'],
  // 等待机器人对某次操作的反应时要传那次操作返回的 cursorBefore，不是它返回的 cursor：同步回复在
  // 操作返回之前就已经进入事件流，用操作后的游标会把它漏掉。这条口径写在参数上，因此每个等待类
  // 工具都读得到，不必在每个发送类工具的描述里重复一遍。
  description: '事件游标。等待某次操作引发的事件时传那次操作返回的 cursorBefore；从当前位置开始等待时传 get_server_info 返回的 cursor。破坏性操作后游标失效需重新获取',
}
const TIMEOUT_SECONDS = { type: 'number', minimum: 1, maximum: 120, description: '等待超时秒数，默认 30' }

/**
 * 分页参数：四个 list 工具对外只有这两个。
 *
 * 游标是服务端编码的不透明字符串，因此「哪个游标在哪种取值下有效」不再是消费者要判断的事——
 * 序号、时间戳与破平键怎么编码归服务端。`limit` 沿用既有口径：类型不对显式失败、越界按声明的
 * 上下限收敛。
 */
const PAGE_CURSOR = {
  type: 'string',
  description: '分页游标：原样传回上一页结果里的 nextPageCursor 即可续页，省略时从第一页开始。它是服务端编码的不透明字符串，不要自己拼，也不要传给另一族记录的工具',
}

function pageLimit(defaultSize: number, maxSize: number) {
  return { type: 'number', minimum: 1, maximum: maxSize, description: `每页条数，默认 ${defaultSize}，最大 ${maxSize}` }
}

/**
 * 会话列表的每页条数。
 *
 * 两族记录页各自的数值由它们的记录库导出，会话列表没有记录库，因此在这里声明一次——声明与执行体
 * 读同一对常量，不会出现「schema 写着 200、执行体夹到 100」这种只能靠调用发现的漂移。
 */
const DEFAULT_CONVERSATION_PAGE_SIZE = 50
const MAX_CONVERSATION_PAGE_SIZE = 200

const OPERATOR_ID = { type: 'string', description: '操作者参与者 ID（十进制数字字符串）' }
const PARTICIPANT_ID = { type: 'string', description: '参与者 ID（十进制数字字符串）' }
const IMPLEMENTATION = { type: 'string', enum: ['napcat', 'llbot', 'snowluma'] }
// 调用标注参数：每次调用都被写进测试调用记录，也是 list_test_call_records 的筛选维度。它对全部
// 工具生效而非某个工具的业务参数，因此由 withTestRunId 统一注入，不逐个工具书写。
const TEST_RUN_ID = { type: 'string', description: '本次测试编排的标识；写入测试调用记录，可用 list_test_call_records 按它回溯同一轮编排的全部调用' }

/**
 * 关系操作的取值组合：每种动作各自声明必填参数。
 *
 * 领域层的好友动作与群动作本来就是判别联合（`SandboxFriendAction`、`SandboxGroupAction`），对外
 * 声明此前把它拍平成一袋可选参数，哪个动作要哪些参数只写在每个参数的描述里——消费者得先读完九条
 * 散文才知道 `set-card` 要带 `card`。这里把同一个判别联合还原成 `oneOf`，与环境变更那族的写法一致。
 *
 * 扁平 `properties` 与基础 `required` 都保留：只读 `properties` 的客户端看得见全部参数，读得懂
 * `oneOf` 的客户端多知道每种动作各自的必填项。分支只用 `const` 钉住 `action` 并补 `required`，因此
 * 任何一次调用恰好匹配一个分支。
 */
function actionVariants(variants: Readonly<Record<string, readonly string[]>>) {
  return Object.entries(variants).map(([action, required]) => ({
    title: action,
    properties: { action: { const: action } },
    ...(required.length ? { required: [...required] } : {}),
  }))
}

const FRIEND_ACTION_VARIANTS = {
  request: ['targetId'],
  'handle-request': ['requestId', 'approve'],
  delete: ['targetId'],
  'set-remark': ['targetId', 'remark'],
  poke: ['targetId'],
} as const

const GROUP_ACTION_VARIANTS = {
  'request-join': ['groupId'],
  invite: ['groupId', 'targetId'],
  'handle-request': ['requestId', 'approve'],
  leave: ['groupId'],
  kick: ['groupId', 'targetId'],
  'set-admin': ['groupId', 'targetId', 'enabled'],
  'transfer-owner': ['groupId', 'targetId'],
  'set-card': ['groupId', 'targetId', 'card'],
  'set-title': ['groupId', 'targetId', 'title'],
  'set-name': ['groupId', 'name'],
  poke: ['groupId', 'targetId'],
} as const
const ACCOUNT_PROFILE_PROPERTIES = {
  personalNote: { type: 'string', description: '个性签名' },
  sex: { type: 'string', enum: ['unknown', 'male', 'female'], description: '也接受 OneBot 的 0、1、2' },
  age: { type: 'number' },
  qid: { type: 'string', description: 'QID' },
  level: { type: 'number', description: '账号等级' },
  loginDays: { type: 'number', description: '连续登录天数' },
  regTime: { type: 'number', description: '注册时间，Unix 秒' },
  city: { type: 'string' },
  country: { type: 'string' },
  birthdayYear: { type: 'number' },
  birthdayMonth: { type: 'number' },
  birthdayDay: { type: 'number' },
  labels: { type: 'array', items: { type: 'string' }, description: '兴趣标签' },
  isVip: { type: 'boolean' },
  isYearsVip: { type: 'boolean' },
  vipLevel: { type: 'number' },
}
// 未建模字段会被丢弃；OneBot 风格的 snake_case 别名（personal_note / long_nick、login_days、
// reg_time、birthday_*、is_vip、is_years_vip、vip_level）同样被接受，不再逐个列出。
const PROFILE = {
  type: 'object',
  description: '账号资料；未建模字段会被丢弃，无法解析出任何字段时不设置资料',
  properties: ACCOUNT_PROFILE_PROPERTIES,
}
const PROFILE_PATCH = {
  ...PROFILE,
  // 描述里推荐用 null 清除资料，因此类型必须真的接受 null——只写 object 会让文档推荐的输入按
  // JSON Schema 非法，客户端可能在发出前就拒绝它。
  type: ['object', 'null'],
  description: '账号资料；整体替换。显式传 null、空对象或无法解析的值即清除资料，省略则保持原资料不变',
}
const FRIENDSHIP_REMARKS = {
  type: 'object',
  description: '好友备注，键为参与者 ID、值为该参与者给对方设置的备注；空字符串会被丢弃',
  additionalProperties: { type: 'string' },
}
const GROUP_MEMBERS = {
  type: 'array',
  description: '完整成员列表，必须且只能包含一个 owner',
  items: {
    type: 'object',
    // 未建模字段会被丢弃；snake_case 别名（user_id、muted_until、join_time、last_sent_time、
    // title_expire_time、card_changeable）同样被接受。
    properties: {
      participantId: PARTICIPANT_ID,
      role: { type: 'string', enum: ['owner', 'admin', 'member'] },
      card: { type: 'string', description: '群名片' },
      title: { type: 'string', description: '专属头衔' },
      mutedUntil: { type: 'string', description: '禁言到期时间，ISO 8601' },
      area: { type: 'string', description: '地区' },
      joinTime: { type: 'number', description: '入群时间，Unix 秒' },
      lastSentTime: { type: 'number', description: '最后发言时间，Unix 秒' },
      level: { type: 'string', description: '群等级' },
      unfriendly: { type: 'boolean', description: '是否不良记录成员' },
      titleExpireTime: { type: 'number', description: '头衔到期时间，Unix 秒' },
      cardChangeable: { type: 'boolean', description: '是否允许修改群名片' },
    },
    required: ['participantId', 'role'],
  },
}

// 判别联合：每种环境变更各自声明必填字段，MCP 客户端不必从一段散文描述里猜参数。
const ENVIRONMENT_CHANGE_SCHEMAS = [
  {
    title: 'create-user',
    description: '创建普通用户',
    properties: {
      action: { const: 'create-user' },
      data: {
        type: 'object',
        properties: { id: PARTICIPANT_ID, name: { type: 'string' }, avatar: { type: 'string' }, profile: PROFILE },
        required: ['id', 'name'],
      },
    },
  },
  {
    title: 'update-user',
    description: '整体替换用户资料；省略 avatar 表示清除头像',
    properties: {
      action: { const: 'update-user' },
      data: {
        type: 'object',
        properties: { id: PARTICIPANT_ID, name: { type: 'string' }, avatar: { type: 'string' }, profile: PROFILE_PATCH },
        required: ['id', 'name'],
      },
    },
  },
  {
    title: 'create-bot',
    description: '创建虚拟 OneBot 机器人；机器人 ID 不得与其他活动场景冲突（主场景默认机器人为 20001）',
    properties: {
      action: { const: 'create-bot' },
      data: {
        type: 'object',
        properties: {
          id: PARTICIPANT_ID,
          name: { type: 'string' },
          implementation: { ...IMPLEMENTATION, description: '协议实现，默认 napcat' },
          enabled: { type: 'boolean', description: '默认 true' },
          avatar: { type: 'string' },
          disabledCapabilities: { type: 'array', items: { type: 'string' }, description: '禁用的能力 ID' },
          profile: PROFILE,
        },
        required: ['id', 'name'],
      },
    },
  },
  {
    title: 'update-bot',
    description: '局部更新机器人资料；只有显式提供的字段会被修改，省略 implementation 不会改变协议实现',
    properties: {
      action: { const: 'update-bot' },
      data: {
        type: 'object',
        properties: {
          id: PARTICIPANT_ID,
          name: { type: 'string' },
          implementation: IMPLEMENTATION,
          enabled: { type: 'boolean' },
          avatar: { type: 'string' },
          disabledCapabilities: { type: 'array', items: { type: 'string' } },
          profile: PROFILE_PATCH,
        },
        required: ['id'],
      },
    },
  },
  {
    title: 'set-capabilities',
    description: '整体替换机器人的能力禁用列表，不修改其他机器人资料',
    properties: {
      action: { const: 'set-capabilities' },
      data: {
        type: 'object',
        properties: { id: PARTICIPANT_ID, disabledCapabilities: { type: 'array', items: { type: 'string' } } },
        required: ['id'],
      },
    },
  },
  {
    title: 'create-group',
    description: '创建群组并自动建立群会话',
    properties: {
      action: { const: 'create-group' },
      data: {
        type: 'object',
        properties: { id: PARTICIPANT_ID, name: { type: 'string' }, avatar: { type: 'string' }, members: GROUP_MEMBERS },
        required: ['id', 'name'],
      },
    },
  },
  {
    title: 'update-group',
    description: '更新群名称；提供 members 时整体替换成员列表',
    properties: {
      action: { const: 'update-group' },
      data: {
        type: 'object',
        properties: { id: PARTICIPANT_ID, name: { type: 'string' }, avatar: { type: 'string' }, members: GROUP_MEMBERS },
        required: ['id', 'name'],
      },
    },
  },
  {
    title: 'set-friendship',
    description: '建立或解除好友关系；建立时自动创建私聊会话',
    properties: {
      action: { const: 'set-friendship' },
      data: {
        type: 'object',
        properties: {
          firstId: PARTICIPANT_ID,
          secondId: PARTICIPANT_ID,
          enabled: { type: 'boolean', description: '默认 true；false 表示解除好友关系' },
          remarks: FRIENDSHIP_REMARKS,
        },
        required: ['firstId', 'secondId'],
      },
    },
  },
].map((schema) => ({ type: 'object', ...schema, required: ['action', 'data'] }))

// —— 工具返回 JSON Schema ——
// 消费者对返回值的了解此前全靠「调一次看看」：等待类最需要声明，因为四个 `wait_for_*` 的成功载荷键
// 各不相同，而它们是编排里调用最频繁的一族。按 MCP 规范，声明了 outputSchema 的工具必须返回符合它的
// `structuredContent`，因此只给结果是对象的工具声明。SDK 用的是低层 `Server` 而不是
// `McpServer.registerTool`，不会自动校验，声明与实际返回是否一致由测试钉住。
//
// 覆盖范围先小后大，判据是「返回形状能不能从工具名与参数推断出来」：`get_scene_snapshot` 能，
// `wait_for_message` 不能。其余工具留待后续，不给它们空声明。

/** 结果里的事件游标。与入参那个 `CURSOR` 分开：描述要答的是「这个游标能拿去做什么」。 */
const EVENT_CURSOR_RESULT = {
  type: 'object',
  properties: { epoch: { type: 'string' }, sequence: { type: 'number' } },
  required: ['epoch', 'sequence'],
  description: '本次调用结束时的事件游标；同一空间（或主场景）里发生破坏性操作后，此前取得的游标在该空间内失效，其他空间不受影响',
}

const EVENT_RESULT = {
  type: 'object',
  properties: {
    cursor: EVENT_CURSOR_RESULT,
    spaceId: { type: 'string', description: '事件归属的 AI 测试空间；主场景事件不带此字段' },
    type: { type: 'string', enum: [...SANDBOX_MCP_EVENT_TYPES] },
    createdAt: { type: 'string', description: 'ISO 8601 时间' },
    data: { description: '事件载荷，形状随事件类型变化' },
  },
  required: ['cursor', 'type', 'createdAt', 'data'],
}

/**
 * 等待类结果的判别式声明。
 *
 * 扁平 `properties` 加两个 `oneOf` 分支，与参数侧的取值组合同一个写法：只读 `properties` 的客户端
 * 看得见全部字段，读得懂 `oneOf` 的客户端多知道哪个分支带哪个字段。分支各自用 `const` 钉住
 * `outcome`，因此一次返回恰好匹配一个分支。
 */
function waitOutputSchema(
  matchedPayload: Record<string, Record<string, unknown>>,
  description: string,
  optionalPayload: Record<string, Record<string, unknown>> = {},
) {
  return {
    type: 'object',
    description,
    properties: {
      outcome: { type: 'string', enum: ['matched', 'timeout'], description: 'matched 等到了匹配项，timeout 到超时都没等到' },
      ...matchedPayload,
      ...optionalPayload,
      reason: { type: 'string', enum: ['timeout'], description: '仅 timeout 分支出现' },
      cursor: EVENT_CURSOR_RESULT,
    },
    required: ['outcome', 'cursor'],
    oneOf: [
      { title: 'matched', properties: { outcome: { const: 'matched' } }, required: Object.keys(matchedPayload) },
      { title: 'timeout', properties: { outcome: { const: 'timeout' } }, required: ['reason'] },
    ],
  }
}

const WAIT_EVENT_OUTPUT = waitOutputSchema(
  { event: EVENT_RESULT },
  '等到匹配事件时带 event，到超时都没等到时带 reason；两种结果都带 cursor。',
)

const WAIT_MESSAGE_OUTPUT = waitOutputSchema(
  { event: EVENT_RESULT },
  '等到消息时带 event（传了 settleSeconds 时另带 events），到超时都没等到时带 reason。',
  {
    events: {
      type: 'array',
      items: EVENT_RESULT,
      description: '仅在传了 settleSeconds 时出现：静默期内收集到的完整消息序列，event 是其中最后一条。不传 settleSeconds 时匹配到第一条即返回，结果里没有本字段',
    },
  },
)

const WAIT_ONEBOT_ACTION_OUTPUT = waitOutputSchema(
  { record: { type: 'object', description: 'OneBot 调试记录，字段与 get_onebot_debug_record 返回的单条记录一致' } },
  '等到调用时直接带匹配到的调试记录，不必再从通用事件载荷里解包；到超时都没等到时带 reason。',
)

const WAIT_CHATLUNA_STATE_OUTPUT = waitOutputSchema(
  { state: { type: 'object', description: 'ChatLuna 对话状态，字段与 chatluna.state 事件的载荷一致' } },
  '等到状态变更时带 state，到超时都没等到时带 reason。',
)

/**
 * 发送类结果的两个游标。
 *
 * `cursorBefore` 是发送前的位置、`cursor` 是发送后的位置，两者最容易被搞混：等待机器人
 * 对本次发送的反应必须用 `cursorBefore`，同步回复在调用返回之前就已经进入事件流。
 */
const SEND_CURSORS = {
  cursorBefore: { ...EVENT_CURSOR_RESULT, description: '发送前的事件游标：等待被测机器人对本次发送的反应时传它，同步回复在本次调用返回之前就已进入事件流' },
  cursor: { ...EVENT_CURSOR_RESULT, description: '发送后的事件游标：只用于「从这里开始等下一件事」，用它等本次发送引发的回复会漏掉同步回复' },
}

const SEND_MESSAGE_OUTPUT = {
  type: 'object',
  properties: {
    messageId: { type: 'string' },
    revision: { type: 'number', description: '发送后的场景版本' },
    ...SEND_CURSORS,
  },
  required: ['messageId', 'revision', 'cursorBefore', 'cursor'],
}

const SEND_FORWARD_MESSAGE_OUTPUT = {
  type: 'object',
  properties: {
    messageId: { type: 'string', description: '外层合并转发消息 ID' },
    forwardId: { type: 'string', description: '合并转发资源 ID，可直接传给 get_forward_message' },
    revision: { type: 'number', description: '发送后的场景版本' },
    ...SEND_CURSORS,
  },
  required: ['messageId', 'forwardId', 'revision', 'cursorBefore', 'cursor'],
}

/** 四个破坏性工具共用一份声明：它们对外都只答新版本与新游标，执行体只负责改场景。 */
const DESTRUCTIVE_OUTPUT = {
  type: 'object',
  description: '破坏性操作完成后，本空间（或主场景）此前取得的事件游标、幂等键与确认令牌全部失效，其他空间不受影响；结果给出新的场景版本与可继续使用的游标。',
  properties: {
    revision: { type: 'number', description: '操作后的场景版本' },
    cursor: EVENT_CURSOR_RESULT,
  },
  required: ['revision', 'cursor'],
}

const SERVER_INFO_OUTPUT = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    testApiVersion: { type: 'number', description: '测试 API 版本；破坏性变更走新版本而不是原地改' },
    transport: { type: 'string', enum: ['streamable-http', 'http', 'chatluna'], description: '承载本次调用的协议表述：streamable-http 是 MCP，http 是 HTTP 测试接口，chatluna 是注册给 ChatLuna 机器人的工具。据此决定错误信封按 JSON-RPC 还是按 HTTP 状态码解析，chatluna 没有信封，错误以工具错误文本给出' },
    stateless: { type: 'boolean' },
    cursor: { ...EVENT_CURSOR_RESULT, description: '当前事件游标：从当前位置开始等待时传它' },
  },
  required: ['name', 'testApiVersion', 'transport', 'stateless', 'cursor'],
}

// —— 参数与领域助手 ——

function requireImplementation(value: unknown): SandboxImplementationProfile {
  // 非法值必须显式失败：静默回落到 napcat 会让测试控制器以为自己在测另一个协议。
  if (value === 'napcat' || value === 'llbot' || value === 'snowluma') return value
  throw new SandboxMcpError('invalid_arguments', `implementation 必须是 napcat、llbot 或 snowluma：${String(value)}`)
}

function requireCapabilityList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new SandboxMcpError('invalid_arguments', 'disabledCapabilities 必须是字符串数组')
  return value.map(String)
}

function assertRevision(control: SandboxControlService, value: unknown) {
  // 先判类型：非数值经 `Number(...)` 会变成 NaN 并与任何版本都不相等，于是一次拼错的参数会报成
  // 「场景版本已变化」，把调用方推向「重读快照再重试」这条永远走不通的路。
  if (requireNumber(value, 'expectedRevision') !== control.getSnapshot().revision) {
    throw new SandboxMcpError('revision_conflict', '场景版本已变化，请重新读取快照')
  }
}

/**
 * 会话在 MCP 表面的形状：解析结果加上它的消息列表。
 *
 * 消息列表是外部测试控制器读会话内容的入口，因此这里显式带上它；列表本身经会话解析模块的唯一
 * 读取口取，不在 MCP 层自己拼。
 */
function toMcpConversation(snapshot: SandboxSnapshot, conversation: ResolvedConversation) {
  return { ...conversation, messageIds: readConversationMessageIds(snapshot, conversation.id) }
}

/**
 * 能力覆盖矩阵。
 *
 * 复用 requireImplementation 的显式失败规则，不在这里二次实现判定。inputSchema 声明了 enum 但
 * 两种协议表述都只把它当文档暴露、不做参数校验，校验责任落在工具执行体内部。implementation 在
 * get_capability_matrix 上是可选参数，省略时仍默认 napcat。
 *
 * 导出供 `onebot-sandbox://capabilities/*` 各实现的只读资源复用：那几条路径与本工具答的是同一件事。
 */
export function readCapabilityMatrix(control: SandboxControlService, implementation: unknown) {
  const profile = implementation === undefined ? 'napcat' : requireImplementation(implementation)
  const snapshot = control.getSnapshot()
  const existing = snapshot.participants.find((participant) => participant.kind === 'bot' && participant.implementation === profile)
  if (existing?.kind === 'bot') return control.getBotCapabilities(existing.id)
  return getOneBotCapabilityMatrix(profile)
}

/**
 * 被测机器人当前的唤醒规则。
 *
 * 传了会话就按投递时的路由身份解析（机器人、群号、会话 ID、发言者，见 `readWakeupTargets`）：v2 的路由规则
 * 可以按其中任意一维覆盖唤醒配置。会话实例用它自己的 ID，v2 把实例当作独立的频道路由，答案可能与根会话
 * 不同。省略会话时给出私聊与群聊两份通用规则：按会话、机器人或发言者写的覆盖会明确标成待判定。
 */
function getWakeupRules(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  if (args.conversationId === undefined) {
    if (args.botId !== undefined || args.operatorId !== undefined) {
      throw new SandboxMcpError('invalid_arguments', 'botId 与 operatorId 只能与 conversationId 一起传')
    }
    return runtime.readWakeupRules()
  }
  const conversationId = requireString(args.conversationId, 'conversationId')
  const snapshot = runtime.control.getSnapshot()
  const conversation = resolveConversation(snapshot, conversationId)
  if (!conversation) throw new SandboxMcpError('conversation_not_found', `会话不存在：${conversationId}`)
  const botId = args.botId === undefined ? undefined : requireString(args.botId, 'botId')
  const operatorId = args.operatorId === undefined ? undefined : requireString(args.operatorId, 'operatorId')
  const targets = readWakeupTargets(snapshot, conversation, botId, operatorId)
  return { conversationId, ...runtime.readWakeupRules(targets) }
}

/**
 * 一条会话上每个被测机器人各自的路由身份。
 *
 * 字段与 `inbound-delivery.ts` 投递时构造的 Session 一致：频道 ID 是会话 ID，群聊带群号，用户是发言者。
 * 同一条群消息会投给群里每个机器人，各自按自己的 selfId 解析规则，因此一个机器人一份答案；传了 botId
 * 只答那一个。私聊的发言者就是会话里那位普通用户；群聊的发言者要调用方用 operatorId 指定。
 */
function readWakeupTargets(
  snapshot: SandboxSnapshot,
  conversation: ResolvedConversation,
  botId: string | undefined,
  operatorId: string | undefined,
): SandboxWakeupTarget[] {
  const isBot = (id: string) => snapshot.participants.find((participant) => participant.id === id)?.kind === 'bot'
  const memberIds = conversation.type === 'group'
    ? snapshot.groups.find(({ id }) => id === conversation.groupId)?.members.map(({ participantId }) => participantId) ?? []
    : conversation.participantIds ?? []
  const bots = memberIds.filter(isBot)
  if (botId !== undefined && !bots.includes(botId)) {
    throw new SandboxMcpError('participant_not_found', `会话 ${conversation.id} 里没有机器人 ${botId}`)
  }
  if (operatorId !== undefined && !memberIds.includes(operatorId)) {
    throw new SandboxMcpError('participant_not_found', `会话 ${conversation.id} 里没有参与者 ${operatorId}`)
  }
  if (conversation.type === 'group') {
    return (botId ? [botId] : bots).map((id) => ({
      conversationType: 'group',
      ...(conversation.groupId ? { conversationKey: conversation.groupId, guildId: conversation.groupId } : {}),
      botId: id,
      channelId: conversation.id,
      ...(operatorId ? { userId: operatorId } : {}),
    }))
  }
  const speaker = operatorId ?? memberIds.find((id) => !isBot(id))
  return (botId ? [botId] : bots).map((id) => ({
    conversationType: 'direct',
    ...(speaker ? { conversationKey: speaker, userId: speaker } : {}),
    botId: id,
    channelId: conversation.id,
  }))
}

// —— 执行体：AI 测试空间 ——

function getServerInfo(runtime: SandboxMcpToolRuntime) {
  // transport 自述用的是承载本次调用的表述而不是端点上启用的全部表述：客户端问的是「我现在
  // 走的是什么」，据此决定错误信封要按 JSON-RPC 还是按 HTTP 状态码解析。
  return {
    name: 'onebot-sandbox',
    testApiVersion: 1,
    transport: runtime.transport === 'mcp' ? 'streamable-http' : runtime.transport,
    stateless: true,
    cursor: runtime.currentCursor(),
  }
}

function getTestSpace(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  return runtime.requireTestSpaces().getSpace(requireString(args.spaceId, 'spaceId'))
}

function createTestSpace(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const space = runtime.requireTestSpaces().createSpace({ name: typeof args.name === 'string' ? args.name : undefined })
  return {
    spaceId: space.id,
    status: space.status,
    revision: space.snapshot.revision,
    cursor: runtime.appendEvent('test-space.created', { spaceId: space.id }, space.id),
  }
}

function completeTestSpace(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>, failed: boolean) {
  const spaceId = requireString(args.spaceId, 'spaceId')
  const space = failed
    ? runtime.requireTestSpaces().failSpace(spaceId)
    : runtime.requireTestSpaces().completeSpace(spaceId)
  // 事件类型按本次调用的意图给出，不从 `space.status` 拼：空间状态还有另外两个取值（运行中、
  // 用户接管），拼出来的名字落在事件词汇之外，而事件类型是封闭词汇。
  return {
    spaceId,
    status: space.status,
    revision: space.snapshot.revision,
    cursor: runtime.appendEvent(failed ? 'test-space.failed' : 'test-space.completed', { spaceId }, spaceId),
  }
}

function reactivateTestSpace(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const spaceId = requireString(args.spaceId, 'spaceId')
  const current = getTestSpace(runtime, args)
  const space = runtime.requireTestSpaces().reactivateSpace(current.id, 'running')
  return { spaceId, status: space.status, revision: space.snapshot.revision, cursor: runtime.appendEvent('test-space.reactivated', { spaceId }, spaceId) }
}

function deleteTestSpace(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const spaceId = requireString(args.spaceId, 'spaceId')
  runtime.requireTestSpaces().deleteSpace(spaceId)
  return { spaceId, deleted: true, cursor: runtime.appendEvent('test-space.deleted', { spaceId }, spaceId) }
}

// —— 执行体：场景与会话读取 ——

/**
 * 已从对外声明消失的分页参数。
 *
 * 显式传了要拒绝而不是无声忽略：被忽略的游标参数会让调用方以为自己在续页，实际每次都拿到第一页，
 * 与收敛前 `scope: 'all'` 静默置空 `beforeSequence` 的失败形态完全相同——翻页翻不动不报错，只会
 * 一直拿到同一页。照着旧契约写的调用是最可能发生的事，因此这里显式失败。
 */
const RETIRED_PAGE_PARAMETERS: readonly string[] = ['offset', 'beforeSequence', 'beforeCreatedAt', 'beforeId']

function assertPageCursorOnly(args: Record<string, unknown>): void {
  const retired = RETIRED_PAGE_PARAMETERS.filter((name) => name in args)
  if (!retired.length) return
  throw new SandboxMcpError(
    'invalid_arguments',
    `分页参数已收敛成 pageCursor，不再受理：${retired.join('、')}`,
    false,
    '请改传上一页结果里的 nextPageCursor。',
  )
}

/**
 * 整份可见的集合按分页游标切一页。
 *
 * 会话列表与测试调用记录共用它：两者都不下推到记录库（前者的可见性投影、后者的内存记录都已经在
 * 手上），因此切页的边界判定只该有一处——`nextPageCursor` 的有无就是「切完还有剩」这一个条件，
 * 两处各写一遍等于给同一个差一错误留两个落点。
 */
function toPagedItems<T>(
  kind: 'conversations' | 'test-call-records',
  items: readonly T[],
  args: Record<string, unknown>,
  defaultLimit: number,
  maxLimit: number,
) {
  const limit = requireNumber(args.limit, 'limit', { fallback: defaultLimit, min: 1, max: maxLimit })
  const offset = readPageCursor(args, kind)?.offset ?? 0
  const nextOffset = offset + limit
  return {
    items: items.slice(offset, nextOffset),
    ...(nextOffset < items.length ? { nextPageCursor: encodePageCursor(kind, { offset: nextOffset }) } : {}),
  }
}

/**
 * 把记录库的游标过期翻译成带可用游标的恢复建议。
 *
 * 恢复建议此前是「请使用 `earliestCursor=123` 恢复分页」，让消费者自己把数值拼回参数名。
 * 给出编码好的 `pageCursor` 之后它是一个能直接传回来的输入。
 */
function toCursorExpiredError(
  kind: 'onebot-debug-records',
  error: { message: string; earliestCursor?: number },
): SandboxMcpError {
  return new SandboxMcpError('cursor_expired', error.message, false, error.earliestCursor === undefined
    ? '请重新从最新页开始读取。'
    : `请使用 pageCursor=${encodePageCursor(kind, { sequence: error.earliestCursor })} 恢复分页。`)
}

function listConversations(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  assertPageCursorOnly(args)
  const operatorId = requireString(args.operatorId, 'operatorId')
  // control 层消息分页上限为 100（control-service.ts assertMessageLimit），超出会直接抛错。
  const snapshot = runtime.control.getVisibleSnapshot(operatorId, 100)
  const items = listConversationItems(snapshot, args).map((conversation) => toMcpConversation(snapshot, conversation))
  return toPagedItems('conversations', items, args, DEFAULT_CONVERSATION_PAGE_SIZE, MAX_CONVERSATION_PAGE_SIZE)
}

/**
 * 会话列表的条目集合：默认只有根会话，显式传 `rootConversationId` 时换成该根会话下的会话实例。
 *
 * 默认不混入实例是因为实例不是新的联系人：混进列表会让外部测试控制器把一个会话实例误判成一段
 * 新增的关系，而两者的形状完全相同、没有任何可察觉的迹象。实例只在被显式问到时出现。
 *
 * 参数指向某个实例时归一化到它的根会话，与领域模块「层级严格两层」的口径一致——不存在第三层可问。
 */
function listConversationItems(snapshot: SandboxSnapshot, args: Record<string, unknown>): ResolvedConversation[] {
  // 显式传了却不是合法字符串时必须失败：静默按「省略」处理会返回根会话列表，而调用方以为
  // 自己拿到的是实例列表。
  if (args.rootConversationId === undefined) return listRootConversations(snapshot)
  const rootConversationId = requireString(args.rootConversationId, 'rootConversationId')
  // 快照已按可见性投影过，解析不到即等于该会话对当前操作者不存在；实例的可见性完全继承根会话。
  if (!resolveConversation(snapshot, rootConversationId)) {
    throw new SandboxMcpError('conversation_not_found', `会话不存在或不可见：${rootConversationId}`)
  }
  return listRootConversationInstances(snapshot, rootConversationId)
}

function getConversation(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const operatorId = requireString(args.operatorId, 'operatorId')
  const conversationId = requireString(args.conversationId, 'conversationId')
  const snapshot = runtime.control.getVisibleSnapshot(operatorId, requireNumber(args.messageLimit, 'messageLimit', { fallback: 50, min: 1, max: 100 }))
  const resolved = resolveConversation(snapshot, conversationId)
  if (!resolved) throw new SandboxMcpError('conversation_not_found', `会话不存在或不可见：${conversationId}`)
  const conversation = toMcpConversation(snapshot, resolved)
  const messageIds = new Set(conversation.messageIds)
  return { conversation, messages: snapshot.messages.filter(({ id }) => messageIds.has(id)) }
}

function getForwardMessage(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const operatorId = requireString(args.operatorId, 'operatorId')
  const forwardId = typeof args.forwardId === 'string' ? args.forwardId : undefined
  const messageId = typeof args.messageId === 'string' ? args.messageId : undefined
  if (!forwardId?.trim() && !messageId?.trim()) {
    throw new SandboxMcpError('invalid_arguments', 'forwardId 与 messageId 至少需要提供一项')
  }
  return runtime.control.getForwardMessage({ operatorId, forwardId, messageId })
}

function exportScene(runtime: SandboxMcpToolRuntime): SandboxMcpExport {
  return { testApiVersion: 1, exportedAt: new Date().toISOString(), scene: runtime.control.getSnapshot() }
}

// —— 执行体：媒体与消息发送 ——

function uploadMedia(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const dataBase64 = requireString(args.dataBase64, 'dataBase64')
  const digest = createHash('sha256').update(Buffer.from(dataBase64, 'base64')).digest('hex')
  if (args.sha256 !== undefined && args.sha256 !== digest) throw new SandboxMcpError('digest_mismatch', '媒体摘要不匹配')
  const media = runtime.control.storeMedia({
    fileName: requireString(args.fileName, 'fileName'),
    mimeType: requireString(args.mimeType, 'mimeType'),
    dataBase64,
  })
  runtime.rememberUploadedMedia(media.id, media)
  return { mediaId: media.id, sha256: digest, media }
}

function requireUploadedMedia(runtime: SandboxMcpToolRuntime, mediaId: string): SandboxMedia {
  const media = runtime.findUploadedMedia(mediaId)
  if (!media) throw new SandboxMcpError('media_not_found', `媒体不存在：${mediaId}`)
  return media
}

async function sendMessage(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const control = runtime.control
  const cursorBefore = runtime.currentCursor()
  const operatorId = requireString(args.operatorId, 'operatorId')
  const conversationId = requireString(args.conversationId, 'conversationId')
  const mediaIds = Array.isArray(args.mediaIds) ? args.mediaIds.map(String) : []
  const media = mediaIds.map((id) => requireUploadedMedia(runtime, id))
  const externalMediaUrls = Array.isArray(args.externalMediaUrls) ? args.externalMediaUrls.map(String) : []
  if (externalMediaUrls.some((value) => { try { return new URL(value).protocol !== 'https:' } catch { return true } })) throw new SandboxMcpError('invalid_media_url', '外部媒体只允许 HTTPS URL')
  const baseContent = typeof args.content === 'string' ? args.content.trim() : ''
  const content = [baseContent, ...externalMediaUrls].filter(Boolean).join('\n')
  const previousMessageIds = new Set(control.getSnapshot().messages.map(({ id }) => id))
  const result = media.length
    ? await control.sendStoredMediaMessage({ operatorId, conversationId, content, replyToMessageId: typeof args.replyToMessageId === 'string' ? args.replyToMessageId : undefined, media })
    : await control.sendMessage({ operatorId, conversationId, content: requireString(content, 'content'), replyToMessageId: typeof args.replyToMessageId === 'string' ? args.replyToMessageId : undefined })
  // 消息创建事件已由场景变更监听统一产生；此处只补发投递完成事件（带 recipientBotId），
  // 供 wait_for_message 按接收机器人过滤。
  appendDeliveryEvents(runtime, previousMessageIds)
  return { ...result, cursorBefore, cursor: runtime.currentCursor() }
}

/** 补发带接收机器人的投递事件。三条发送路径共用，避免只给一条路加能力。 */
function appendDeliveryEvents(runtime: SandboxMcpToolRuntime, previousMessageIds: Set<string>): void {
  for (const message of runtime.control.getSnapshot().messages.filter(({ id }) => !previousMessageIds.has(id))) {
    for (const delivery of runtime.control.getBotDeliveries({ messageId: message.id })) {
      runtime.appendEvent('message.created', { ...message, recipientBotId: delivery.recipientBotId })
    }
  }
}

async function sendForwardMessage(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const control = runtime.control
  const cursorBefore = runtime.currentCursor()
  const operatorId = requireString(args.operatorId, 'operatorId')
  const conversationId = requireString(args.conversationId, 'conversationId')
  const operator = control.getSnapshot().participants.find(({ id }) => id === operatorId)
  if (operator?.kind === 'bot') {
    throw new SandboxMcpError('permission_denied', 'MCP 测试控制器不能代机器人发送合并转发；请由被测插件调用 OneBot action')
  }
  const messageIds = Array.isArray(args.messageIds) ? args.messageIds.map(String) : []
  const rawNodes = Array.isArray(args.nodes) ? args.nodes : []
  if (!!messageIds.length === !!rawNodes.length) {
    throw new SandboxMcpError('invalid_arguments', 'messageIds 与 nodes 必须且只能提供一项')
  }
  const nodes = rawNodes.length ? resolveForwardNodes(runtime, rawNodes) : undefined
  const previousMessageIds = new Set(control.getSnapshot().messages.map(({ id }) => id))
  const { result, delivery } = control.startForwardMessage({
    operatorId,
    conversationId,
    ...(messageIds.length ? { messageIds } : {}),
    ...(nodes ? { nodes } : {}),
  })
  await delivery
  // 场景监听已产生外层消息事件；这里只补齐按接收机器人过滤所需的投递事件。
  appendDeliveryEvents(runtime, previousMessageIds)
  return { ...result, cursorBefore, cursor: runtime.currentCursor() }
}

function resolveForwardNodes(runtime: SandboxMcpToolRuntime, rawNodes: unknown[]): SandboxForwardNodeInput[] {
  return rawNodes.map((rawNode, index) => {
    const node = asRecord(rawNode)
    if (node.type === 'reference') {
      return { type: 'reference', messageId: requireString(node.messageId, `nodes[${index}].messageId`) }
    }
    if (node.type !== 'custom') {
      throw new SandboxMcpError('invalid_arguments', `nodes[${index}].type 必须是 reference 或 custom`)
    }
    const mediaIds = Array.isArray(node.mediaIds) ? node.mediaIds.map(String) : []
    const media = mediaIds.map((id) => requireUploadedMedia(runtime, id))
    return {
      type: 'custom',
      userId: requireString(node.userId, `nodes[${index}].userId`),
      nickname: requireString(node.nickname, `nodes[${index}].nickname`),
      content: typeof node.content === 'string' ? node.content : '',
      ...(typeof node.createdAt === 'string' ? { createdAt: node.createdAt } : {}),
      ...(media.length ? { media } : {}),
      ...(typeof node.forwardId === 'string' ? { forwardId: node.forwardId } : {}),
    }
  })
}

// —— 执行体：好友、群与申请 ——

async function performFriendAction(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const { idempotencyKey: _key, testRunId: _run, spaceId: _spaceId, ...input } = args
  const cursorBefore = runtime.currentCursor()
  const result = await runtime.control.performFriendAction(input as never)
  return {
    ...result,
    cursorBefore,
    cursor: runtime.appendEvent('friend.action', input),
    affected: [String(input.operatorId), String(input.targetId ?? input.requestId)],
  }
}

async function performGroupAction(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const { idempotencyKey: _key, testRunId: _run, spaceId: _spaceId, ...input } = args
  const cursorBefore = runtime.currentCursor()
  const result = await runtime.control.performGroupAction(input as never)
  return {
    ...result,
    cursorBefore,
    cursor: runtime.appendEvent('group.action', input),
    affected: [String(input.groupId ?? input.requestId), String(input.targetId ?? input.operatorId)],
  }
}

async function handleRequest(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const control = runtime.control
  const requestId = requireString(args.requestId, 'requestId')
  const request = control.getSnapshot().requests.find(({ id }) => id === requestId)
  if (!request) throw new SandboxMcpError('request_not_found', `申请不存在：${requestId}`)
  const operatorId = requireString(args.operatorId, 'operatorId')
  const target = request.targetId ? control.getSnapshot().participants.find(({ id }) => id === request.targetId) : undefined
  if (target?.kind === 'bot') throw new SandboxMcpError('robot_request_forbidden', '发给机器人的申请必须由被测机器人处理')
  // 转调仍从同一个运行时取空间归属：事件的空间归属此前由重新拼出的参数对象携带，漏掉它会让
  // 事件写入 spaceId: undefined，而 wait_for_event 按 spaceId 严格相等过滤且该参数必填，结果是
  // 测试空间里经本工具批准的申请永远等不到 friend.action / group.action。
  const forwarded = { spaceId: args.spaceId, operatorId, action: 'handle-request', requestId, approve: args.approve, idempotencyKey: args.idempotencyKey }
  if (request.type === 'friend') return performFriendAction(runtime, forwarded)
  return performGroupAction(runtime, forwarded)
}

// —— 执行体：等待类 ——

function waitForEvent(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const type = optionalEnum(args.type, 'type', SANDBOX_MCP_EVENT_TYPES)
  return runtime.waitFor(args, (event) => !type || event.type === type)
}

// authorId 过滤是「等待机器人回复」的关键：沙盒 send_message 会等待 middleware 完成才返回，
// 同步命令的回复在返回前已入事件流，消费者只能用「发送前 cursor + authorId=机器人」的组合
// 等待回复，否则会匹配到自己刚发的消息或错过回复。
function waitForMessageEvent(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  return waitForSettledMessages(runtime, args, (event) => event.type === 'message.created'
    && (!args.conversationId || Reflect.get(event.data as object, 'conversationId') === args.conversationId)
    && (!args.authorId || Reflect.get(event.data as object, 'authorId') === args.authorId)
    && (!args.recipientBotId || Reflect.get(event.data as object, 'recipientBotId') === args.recipientBotId))
}

// 机器人常先回一条「稍等」再给最终结果。静默期内继续收集同条件消息，
// 返回最后一条与完整序列，避免消费者把中间回复当成最终回复。
async function waitForSettledMessages(
  runtime: SandboxMcpToolRuntime,
  args: Record<string, unknown>,
  predicate: (event: SandboxMcpEvent) => boolean,
) {
  // 静默期先取值再开始等待：放在等待之后，一个拼错的 settleSeconds 要先挂满一整个等待超时才报错。
  const settleSeconds = requireNumber(args.settleSeconds, 'settleSeconds', { fallback: 0, min: 0, max: 30 })
  const first = await runtime.waitFor(args, predicate)
  if (settleSeconds < 1 || first.outcome !== 'matched') return first
  const events = [first.event]
  let cursor = first.cursor
  for (;;) {
    const next = await runtime.waitFor({ ...args, cursor, timeoutSeconds: settleSeconds }, predicate)
    // 静默期内不再出现同条件消息即收束，因此这里等到的超时是正常终止而不是失败。
    if (next.outcome !== 'matched') break
    events.push(next.event)
    cursor = next.cursor
  }
  return { outcome: 'matched' as const, event: events[events.length - 1]!, events, cursor }
}

async function waitForOneBotAction(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  // 筛选值先取完再开始等待：拼错的取值此前静默变成「不筛选」，等到的是别的 action 调用。
  const status = optionalEnum(args.status, 'status', ONEBOT_DEBUG_STATUSES)
  const waited = await runtime.waitFor(args, (event) => {
    if (event.type !== 'onebot.action') return false
    const data = event.data as {
      botId?: string
      status?: string
      action?: string
      requestedAction?: string
      matchedAlias?: string
    }
    if (args.botId && data.botId !== args.botId) return false
    if (status && data.status !== status) return false
    if (args.requestedAction && data.requestedAction !== args.requestedAction) return false
    if (args.action) {
      const action = String(args.action)
      if (data.action !== action && data.requestedAction !== action && data.matchedAlias !== action) return false
    }
    return true
  })
  if (waited.outcome !== 'matched') return waited
  // 成功时直接返回匹配记录，避免消费者再从通用 event.data 中解包旧 type 字段。
  return { outcome: waited.outcome, record: waited.event.data, cursor: waited.cursor }
}

// 按 cursor.sequence 真正定位：匹配的是游标之后发生的状态变更事件，而不是「当前状态」。
// 直接读 getChatLunaStates() 会把上一轮已经结束的 thinking=false 状态当成本轮结果——那是
// 一个真实的假阳性，而不只是文档问题，因为该方法保留已结束的状态。
async function waitForChatLunaState(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  // 非布尔的 thinking 与任何状态都不相等，此前会一直等到超时；那与「机器人没有进入过这个状态」
  // 的观察结果完全一样。
  const thinking = optionalBoolean(args.thinking, 'thinking')
  const waited = await runtime.waitFor(args, (event) => {
    if (event.type !== 'chatluna.state') return false
    const state = event.data as { botParticipantId?: string; conversationId?: string; thinking?: boolean }
    if (args.botParticipantId && state.botParticipantId !== args.botParticipantId) return false
    if (args.conversationId && state.conversationId !== args.conversationId) return false
    if (thinking !== undefined && state.thinking !== thinking) return false
    return true
  })
  if (waited.outcome !== 'matched') return waited
  return { outcome: waited.outcome, state: waited.event.data, cursor: waited.cursor }
}

// —— 执行体：环境变更 ——

async function applyEnvironmentChanges(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  const control = runtime.control
  assertRevision(control, args.expectedRevision)
  const snapshot = structuredClone(control.getSnapshot())
  const changes = Array.isArray(args.changes) ? args.changes : []
  for (const raw of changes) {
    const change = asRecord(raw)
    const action = requireString(change.action, 'change.action')
    const data = asRecord(change.data)
    if (action === 'create-user') {
      const profile = parseAccountProfileFromUnknown(data.profile)
      const id = requireString(data.id, 'id')
      snapshot.participants.push({
        kind: 'user',
        id,
        name: requireString(data.name, 'name'),
        avatar: await control.importAvatar('user', id, typeof data.avatar === 'string' ? data.avatar : undefined),
        ...(profile ? { profile } : {}),
      })
    }
    else if (action === 'create-bot') {
      const profile = parseAccountProfileFromUnknown(data.profile)
      const id = requireString(data.id, 'id')
      snapshot.participants.push({
        kind: 'bot',
        id,
        name: requireString(data.name, 'name'),
        implementation: data.implementation === undefined ? 'napcat' : requireImplementation(data.implementation),
        enabled: data.enabled !== false,
        avatar: await control.importAvatar('bot', id, typeof data.avatar === 'string' ? data.avatar : undefined),
        disabledCapabilities: requireCapabilityList(data.disabledCapabilities),
        ...(profile ? { profile } : {}),
      })
    }
    else if (action === 'create-group') {
      const groupId = requireString(data.id, 'id')
      const members = Array.isArray(data.members)
        ? data.members.flatMap((member) => {
          const normalized = normalizeGroupMemberFromUnknown(member)
          return normalized ? [normalized] : []
        })
        : []
      snapshot.groups.push({
        id: groupId,
        name: requireString(data.name, 'name'),
        avatar: await control.importAvatar('group', groupId, typeof data.avatar === 'string' ? data.avatar : undefined),
        members,
        announcements: [],
      })
      // 与 set-friendship 自动创建私聊会话保持一致：建群即建群会话，
      // 否则 AI 需要先执行一次群操作才能拿到可发消息的会话。
      ensureGroupRootConversation(snapshot, groupId)
    }
    else if (action === 'update-user') {
      const participant = snapshot.participants.find(({ id, kind }) => id === data.id && kind === 'user')
      if (!participant) throw new SandboxMcpError('participant_not_found', `用户不存在：${String(data.id)}`)
      participant.name = requireString(data.name, 'name')
      participant.avatar = await control.importAvatar('user', participant.id, typeof data.avatar === 'string' ? data.avatar : undefined)
      if (data.profile !== undefined) {
        const profile = parseAccountProfileFromUnknown(data.profile)
        if (profile) participant.profile = profile
        else delete participant.profile
      }
    } else if (action === 'update-bot' || action === 'set-capabilities') {
      const participant = snapshot.participants.find(({ id, kind }) => id === data.id && kind === 'bot')
      if (!participant || participant.kind !== 'bot') throw new SandboxMcpError('participant_not_found', `机器人不存在：${String(data.id)}`)
      if (action === 'update-bot') {
        // 局部补丁语义：只改显式提供的字段。旧实现把省略的 implementation 回落成
        // napcat，导致「只改昵称」会静默把 LLBot 重置为 NapCat。
        if (data.name !== undefined) participant.name = requireString(data.name, 'name')
        if (data.avatar !== undefined) participant.avatar = await control.importAvatar('bot', participant.id, typeof data.avatar === 'string' ? data.avatar : undefined)
        if (data.implementation !== undefined) participant.implementation = requireImplementation(data.implementation)
        if (data.enabled !== undefined) participant.enabled = data.enabled !== false
        if (data.disabledCapabilities !== undefined) participant.disabledCapabilities = requireCapabilityList(data.disabledCapabilities)
        if (data.profile !== undefined) {
          const profile = parseAccountProfileFromUnknown(data.profile)
          if (profile) participant.profile = profile
          else delete participant.profile
        }
      } else {
        participant.disabledCapabilities = requireCapabilityList(data.disabledCapabilities)
      }
    } else if (action === 'update-group') {
      const group = snapshot.groups.find(({ id }) => id === data.id)
      if (!group) throw new SandboxMcpError('group_not_found', `群组不存在：${String(data.id)}`)
      group.name = requireString(data.name, 'name')
      if (data.avatar !== undefined) group.avatar = await control.importAvatar('group', group.id, typeof data.avatar === 'string' ? data.avatar : undefined)
      if (Array.isArray(data.members)) {
        group.members = data.members.flatMap((member) => {
          const normalized = normalizeGroupMemberFromUnknown(member)
          return normalized ? [normalized] : []
        })
      }
    } else if (action === 'set-friendship') {
      const participantIds = [requireString(data.firstId, 'firstId'), requireString(data.secondId, 'secondId')].sort() as [string, string]
      const friendshipId = `friend:${participantIds[0]}:${participantIds[1]}`
      snapshot.friendships = snapshot.friendships.filter(({ id }) => id !== friendshipId)
      if (data.enabled !== false) {
        snapshot.friendships.push({
          id: friendshipId,
          participantIds,
          remarks: normalizeFriendshipRemarks(data.remarks),
          createdAt: new Date().toISOString(),
        })
      }
      if (data.enabled !== false) ensureDirectRootConversation(snapshot, ...participantIds)
    }
    else throw new SandboxMcpError('unsupported_change', `不支持的环境变更：${action}`)
  }
  control.replaceScene(snapshot)
  return { revision: control.getSnapshot().revision, cursor: runtime.currentCursor(), affected: changes.map((change) => String(asRecord(change).action)) }
}

// —— 执行体：破坏性操作 ——

function prepareDestructiveAction(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  assertRevision(runtime.control, args.expectedRevision)
  const requestedTool = requireString(args.tool, 'tool')
  const toolArguments = asRecord(args.arguments)
  const token = randomBytes(32).toString('base64url')
  runtime.rememberConfirmation(token, {
    credentialId: runtime.credentialId,
    tool: requestedTool,
    argumentsHash: argumentsFingerprint(toolArguments),
    revision: runtime.control.getSnapshot().revision,
    expiresAt: Date.now() + 60_000,
  })
  return { confirmationToken: token, expiresInSeconds: 60, revision: runtime.control.getSnapshot().revision }
}

function deleteEnvironmentEntity(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>): void {
  const kind = requireString(args.kind, 'kind')
  const id = requireString(args.id, 'id')
  if (kind === 'user') runtime.control.deleteUser({ id })
  else if (kind === 'bot') runtime.control.deleteBot({ id })
  else if (kind === 'group') runtime.control.deleteGroup({ id })
  else throw new SandboxMcpError('invalid_arguments', `未知实体类型：${kind}`)
}

function clearScene(runtime: SandboxMcpToolRuntime): void {
  runtime.control.replaceScene({
    revision: runtime.control.getSnapshot().revision,
    participants: [],
    groups: [],
    conversations: [],
    conversationInstances: [],
    messages: [],
    forwards: [],
    friendships: [],
    requests: [],
  })
}

function importScene(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>): void {
  const document = asRecord(args.document)
  if (document.testApiVersion !== 1) throw new SandboxMcpError('unsupported_scene_version', '仅支持 testApiVersion 1')
  runtime.control.replaceScene(asRecord(document.scene) as unknown as SandboxSnapshot)
}

// —— 执行体：OneBot 调试记录 ——

/**
 * 调试记录页在测试控制端点这一侧的形状。
 *
 * 翻译写在这里而不是改记录页类型：`SandboxOneBotDebugRecordsPage` 同时被 Console 契约与 WebQQ 的
 * 记录页读取，那两处直接读 `records`／`nextCursor`，翻译由翻译它的模块自述。
 * `capacity` 与 `earliestCursor` 原样带出：前者是容量摘要，后者是游标过期恢复用的最早位置，
 * 不透明游标只替换「消费者自己拼参数」这一段，不减少信息量。
 */
function toOneBotDebugPage({ records, nextCursor, ...page }: SandboxOneBotDebugRecordsPage) {
  return {
    items: records,
    ...(nextCursor === undefined ? {} : { nextPageCursor: encodePageCursor('onebot-debug-records', { sequence: nextCursor }) }),
    ...page,
  }
}

async function listOneBotDebugRecords(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  if ('includeLargeValues' in args) {
    throw new SandboxMcpError('invalid_arguments', '列表接口不允许 includeLargeValues；请使用 get_onebot_debug_record 展开单条记录。')
  }
  assertPageCursorOnly(args)
  const pageCursor = readPageCursor(args, 'onebot-debug-records')
  try {
    await runtime.control.waitForPersistence()
    return toOneBotDebugPage(await runtime.control.getOneBotDebugStore().getRecords({
      botId: typeof args.botId === 'string' ? args.botId : undefined,
      direction: optionalEnum(args.direction, 'direction', ONEBOT_DEBUG_DIRECTIONS),
      action: typeof args.action === 'string' ? args.action : undefined,
      requestedAction: typeof args.requestedAction === 'string' ? args.requestedAction : undefined,
      status: optionalEnum(args.status, 'status', ONEBOT_DEBUG_STATUSES),
      order: optionalEnum(args.order, 'order', RECORD_ORDERS),
      limit: optionalNumber(args.limit, 'limit', { min: 1, max: MAX_DEBUG_PAGE_SIZE }),
      beforeSequence: pageCursor?.sequence,
    }))
  } catch (error) {
    // 恢复建议给出一个可直接使用的游标值，而不是让消费者把数值拼回参数名。
    if (error instanceof SandboxOneBotDebugCursorExpiredError) throw toCursorExpiredError('onebot-debug-records', error)
    throw error
  }
}

async function getOneBotDebugRecord(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  try {
    await runtime.control.waitForPersistence()
    return await runtime.control.getOneBotDebugStore().requireRecord(
      requireString(args.recordId, 'recordId'),
      args.includeLargeValues === true,
    )
  } catch (error) {
    throw new SandboxMcpError('record_not_found', error instanceof Error ? error.message : '调试记录不存在')
  }
}

async function clearOneBotDebugRecords(runtime: SandboxMcpToolRuntime) {
  return { cleared: await runtime.control.getOneBotDebugStore().clear() }
}

// —— 执行体：测试调用记录 ——

/**
 * 测试调用记录的分页在这里切，而不是下推到记录库。
 *
 * 记录页类型由 Console 契约与 WebQQ 的测试调用记录页共用，翻译归翻译它的模块；记录
 * 本身整份在内存里，因此按偏移切页不多读一次。补上 `limit` 之前它是唯一没有上限的 list：保留
 * 500 条时一次全返回。
 */
function listTestCallRecords(runtime: SandboxMcpToolRuntime, args: Record<string, unknown>) {
  assertPageCursorOnly(args)
  const { records } = runtime.listCallRecords({
    tool: typeof args.tool === 'string' ? args.tool : undefined,
    credentialName: typeof args.credentialName === 'string' ? args.credentialName : undefined,
    transport: optionalEnum(args.transport, 'transport', TEST_CALL_TRANSPORTS),
    spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
    testRunId: typeof args.testRunId === 'string' ? args.testRunId : undefined,
    status: optionalEnum(args.status, 'status', TEST_CALL_STATUSES),
    order: optionalEnum(args.order, 'order', RECORD_ORDERS),
  })
  return toPagedItems('test-call-records', records, args, DEFAULT_TEST_CALL_PAGE_SIZE, MAX_TEST_CALL_PAGE_SIZE)
}

/**
 * 作者书写的 41 条条目，按 `tools/list` 的返回顺序排列；下面那一步给它们统一补上调用标注参数。
 *
 * 顺序本身是对外契约的一部分（`tests/helpers/mcp-tool-catalogue.ts` 逐条钉住它），因此新增工具
 * 时要放到它所属能力范围那一段的末尾，而不是文件末尾。
 */
const TOOL_ENTRIES: SandboxMcpToolEntry[] = [
  {
    name: 'get_server_info',
    scope: 'read',
    description: '获取沙盒服务、测试 API 和 MCP 状态',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: SERVER_INFO_OUTPUT,
    quota: 'read', spaceResolution: 'none', idempotent: false, requiresConfirmation: false,
    run: (runtime) => getServerInfo(runtime),
  },
  {
    name: 'list_test_spaces',
    scope: 'read',
    description: '列出当前 Sandbox 实例的全部 AI 测试空间',
    inputSchema: { type: 'object', properties: {} },
    quota: 'read', spaceResolution: 'none', idempotent: false, requiresConfirmation: false,
    // 结果包一层：裸数组在 MCP 表述下拿不到 structuredContent（协议要求它是对象），而同一个工具在
    // HTTP 表述下返回的是真正的数组，消费者要为「换一种表述」多写一条解析路径。包一层之后往结果里
    // 加容量摘要或续页信息也不再是破坏性变更。
    run: (runtime) => ({ items: runtime.requireTestSpaces().listSpaces() }),
  },
  {
    name: 'get_test_space',
    scope: 'read',
    description: '读取单个 AI 测试空间状态',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED }, required: ['spaceId'] },
    quota: 'read', spaceResolution: 'none', idempotent: false, requiresConfirmation: false,
    run: getTestSpace,
  },
  {
    name: 'get_scene_snapshot',
    scope: 'read',
    description: '读取当前模拟 QQ 场景快照',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_OPTIONAL } },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: (runtime) => runtime.control.getSnapshot(),
  },
  {
    name: 'list_conversations',
    scope: 'read',
    description: '分页列出当前操作者可见的根会话；显式传 rootConversationId 时列出该根会话下的会话实例',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_OPTIONAL,
        operatorId: OPERATOR_ID,
        rootConversationId: {
          type: 'string',
          description: '列出该根会话下的会话实例；省略时只返回根会话。传入会话实例 ID 时归一化到它所属的根会话',
        },
        limit: pageLimit(DEFAULT_CONVERSATION_PAGE_SIZE, MAX_CONVERSATION_PAGE_SIZE),
        pageCursor: PAGE_CURSOR,
      },
      required: ['operatorId'],
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: listConversations,
  },
  {
    name: 'get_conversation',
    scope: 'read',
    description: '读取单个会话及其消息',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_OPTIONAL,
        operatorId: OPERATOR_ID,
        conversationId: { type: 'string', description: '会话 ID，如 private:10001:20001 或 group:30001' },
        messageLimit: { type: 'number', minimum: 1, maximum: 100, description: '消息条数，默认 50' },
      },
      required: ['operatorId', 'conversationId'],
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: getConversation,
  },
  {
    name: 'get_forward_message',
    scope: 'read',
    description: '按操作者可见性读取合并转发资源详情',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_OPTIONAL,
        operatorId: OPERATOR_ID,
        forwardId: { type: 'string', description: '合并转发资源 ID' },
        messageId: { type: 'string', description: '外层合并转发消息 ID' },
      },
      required: ['operatorId'],
      // 「至少提供一项」此前只写在描述里，由执行体判定；anyOf 让它成为声明本身的一部分。
      anyOf: [{ required: ['forwardId'] }, { required: ['messageId'] }],
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: getForwardMessage,
  },
  {
    name: 'list_pending_requests',
    scope: 'read',
    description: '列出当前待处理好友和群申请',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_OPTIONAL } },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: (runtime) => ({ items: runtime.control.getSnapshot().requests }),
  },
  {
    name: 'get_capability_matrix',
    scope: 'read',
    description: '读取 NapCat、LLBot 或 SnowLuma 能力覆盖',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_OPTIONAL,
        implementation: { ...IMPLEMENTATION, description: '默认 napcat' },
      },
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    // 包一层只加在工具这一侧：`onebot-sandbox://capabilities/*` 各条只读资源复用同一份矩阵，而
    // 资源正文本来就是文本序列化、不受 structuredContent 的约束，跟着包会让已经在读资源的消费者白改一次。
    run: (runtime, args) => ({ items: readCapabilityMatrix(runtime.control, args.implementation) }),
  },
  {
    name: 'export_scene',
    scope: 'read',
    description: '导出版本化 JSON 场景',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_OPTIONAL } },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: exportScene,
  },
  {
    name: 'get_wakeup_rules',
    scope: 'read',
    description: '读取被测机器人当前的唤醒规则：ChatLuna v2 按路由规则生效的引擎、激活判定器与唤醒条件，消息要怎么写才能唤醒它',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_OPTIONAL,
        conversationId: {
          type: 'string',
          description: '按这条会话投递时的路由身份解析（机器人、群号、会话 ID、发言者）；会话里每个机器人各给一份。省略时返回私聊与群聊两份通用规则，按会话写的路由规则标成待判定',
        },
        botId: { type: 'string', description: '只解析这个机器人；省略时会话里每个机器人各给一份。需要同时传 conversationId' },
        operatorId: { type: 'string', description: '发言者参与者 ID：按用户写的路由规则要靠它判定；私聊省略时取会话里的普通用户。需要同时传 conversationId' },
      },
      description: '发消息前先读一次：被测机器人只在唤醒条件成立时回复，条件由 ChatLuna v2 当前的路由规则（chat.activation 等）决定，与沙盒无关。',
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: getWakeupRules,
  },
  {
    name: 'upload_media',
    scope: 'interact',
    description: '上传供消息引用的媒体',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        fileName: { type: 'string' },
        mimeType: { type: 'string' },
        dataBase64: { type: 'string', description: '文件内容的 Base64 编码' },
        sha256: { type: 'string', description: '可选内容摘要；不匹配时拒绝上传' },
      },
      required: ['spaceId', 'fileName', 'mimeType', 'dataBase64'],
    },
    // 上传自成一档配额与并发：大文件上传不该挤掉状态修改额度。两个标记都不带。
    quota: 'upload', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: uploadMedia,
  },
  {
    name: 'send_message',
    scope: 'interact',
    description: '以明确操作者身份发送消息',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        operatorId: OPERATOR_ID,
        conversationId: { type: 'string' },
        content: { type: 'string', description: '消息文本；支持 <at id="参与者ID"/> 元素（群聊中触发命令通常需要 at 机器人）' },
        mediaIds: { type: 'array', items: { type: 'string' }, description: 'upload_media 返回的媒体 ID 列表' },
        externalMediaUrls: { type: 'array', items: { type: 'string' }, description: '外部媒体 URL，仅允许 HTTPS' },
        replyToMessageId: { type: 'string' },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ['spaceId', 'operatorId', 'conversationId', 'idempotencyKey'],
      description: '返回值里的 cursorBefore 是发送前的事件游标：等待机器人回复时把它传给 wait_for_message，例如 wait_for_message({ cursor: cursorBefore, authorId: 机器人ID })。',
    },
    outputSchema: SEND_MESSAGE_OUTPUT,
    quota: 'mutation', spaceResolution: 'mutation', idempotent: true, requiresConfirmation: false,
    run: sendMessage,
  },
  {
    name: 'send_forward_message',
    scope: 'interact',
    description: '以明确操作者身份发送合并转发消息',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        operatorId: OPERATOR_ID,
        conversationId: { type: 'string' },
        messageIds: { type: 'array', items: { type: 'string' }, maxItems: 100, description: '要引用的已有消息 ID；与 nodes 二选一，服务端按消息时间稳定排序' },
        nodes: {
          type: 'array',
          maxItems: 100,
          description: '显式节点；与 messageIds 二选一，可混合引用节点与自定义节点',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: { type: { type: 'string', const: 'reference' }, messageId: { type: 'string' } },
                required: ['type', 'messageId'],
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'custom' },
                  userId: PARTICIPANT_ID,
                  nickname: { type: 'string' },
                  content: { type: 'string' },
                  createdAt: { type: 'string', description: '可选 ISO 8601 时间' },
                  mediaIds: { type: 'array', items: { type: 'string' }, description: 'upload_media 返回的媒体 ID 列表' },
                  forwardId: { type: 'string', description: '嵌套已有合并转发资源 ID' },
                },
                required: ['type', 'userId', 'nickname'],
              },
            ],
          },
        },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ['spaceId', 'operatorId', 'conversationId', 'idempotencyKey'],
      // 「必须且只能提供一项」由 oneOf 表达，不再只靠描述与执行体判定。
      oneOf: [
        { title: '引用已有消息', required: ['messageIds'] },
        { title: '显式节点', required: ['nodes'] },
      ],
      description: '返回值里的 cursorBefore 是发送前的事件游标：等待机器人回复时把它传给 wait_for_message。',
    },
    outputSchema: SEND_FORWARD_MESSAGE_OUTPUT,
    quota: 'mutation', spaceResolution: 'mutation', idempotent: true, requiresConfirmation: false,
    run: sendForwardMessage,
  },
  {
    name: 'perform_friend_action',
    scope: 'interact',
    description: '执行好友申请、审批、删除、备注或戳一戳',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        operatorId: OPERATOR_ID,
        action: { type: 'string', enum: Object.keys(FRIEND_ACTION_VARIANTS) },
        targetId: { type: 'string', description: '目标参与者 ID' },
        requestId: { type: 'string', description: '好友申请 ID' },
        approve: { type: 'boolean', description: '是否批准该申请' },
        comment: { type: 'string', description: '申请附言' },
        remark: { type: 'string', description: '给对方设置的好友备注；空字符串表示清除' },
        conversationId: { type: 'string', description: '戳一戳发生在哪条会话；省略时不绑定会话' },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ['spaceId', 'operatorId', 'action', 'idempotencyKey'],
      oneOf: actionVariants(FRIEND_ACTION_VARIANTS),
    },
    quota: 'mutation', spaceResolution: 'mutation', idempotent: true, requiresConfirmation: false,
    run: performFriendAction,
  },
  {
    name: 'perform_group_action',
    scope: 'interact',
    description: '执行入群、邀请、退群、管理或戳一戳',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        operatorId: OPERATOR_ID,
        action: { type: 'string', enum: Object.keys(GROUP_ACTION_VARIANTS) },
        groupId: { type: 'string', description: '群号' },
        targetId: { type: 'string', description: '目标参与者 ID' },
        requestId: { type: 'string', description: '入群申请或群邀请的 ID' },
        approve: { type: 'boolean', description: '是否批准该申请' },
        comment: { type: 'string', description: '申请或邀请附言' },
        enabled: { type: 'boolean', description: '是否授予管理员' },
        card: { type: 'string', description: '群名片；传空字符串清除' },
        title: { type: 'string', description: '专属头衔，仅群主可设置；传空字符串清除' },
        name: { type: 'string', description: '群名' },
        conversationId: { type: 'string', description: '戳一戳发生在哪条会话；省略时不绑定会话' },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ['spaceId', 'operatorId', 'action', 'idempotencyKey'],
      oneOf: actionVariants(GROUP_ACTION_VARIANTS),
    },
    quota: 'mutation', spaceResolution: 'mutation', idempotent: true, requiresConfirmation: false,
    run: performGroupAction,
  },
  {
    name: 'handle_request',
    scope: 'interact',
    description: '处理普通用户有权审批的申请',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        operatorId: OPERATOR_ID,
        requestId: { type: 'string' },
        approve: { type: 'boolean' },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ['spaceId', 'operatorId', 'requestId', 'approve', 'idempotencyKey'],
    },
    quota: 'mutation', spaceResolution: 'mutation', idempotent: true, requiresConfirmation: false,
    run: handleRequest,
  },
  {
    name: 'wait_for_event',
    scope: 'interact',
    description: '从事件游标等待匹配事件',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        cursor: CURSOR,
        type: { type: 'string', enum: [...SANDBOX_MCP_EVENT_TYPES], description: '事件类型过滤；省略时匹配任意类型。取值集合之外的名字直接报错，不会静默等到超时' },
        timeoutSeconds: TIMEOUT_SECONDS,
      },
      required: ['spaceId', 'cursor'],
    },
    outputSchema: WAIT_EVENT_OUTPUT,
    // 等待自成一档：长等待不占用读取额度，也不与状态修改抢并发闸门。
    quota: 'wait', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: waitForEvent,
  },
  {
    name: 'wait_for_message',
    scope: 'interact',
    description: '从事件游标等待消息，可按静默期等待最终回复',
    inputSchema: {
      type: 'object',
      description: '等待消息事件；机器人常先回一条中间消息再给最终结果，需要最终回复时传 settleSeconds。',
      properties: {
        spaceId: SPACE_REQUIRED,
        cursor: CURSOR,
        conversationId: { type: 'string' },
        authorId: { type: 'string', description: '按消息作者过滤；等待机器人回复时传机器人 ID' },
        recipientBotId: { type: 'string', description: '按投递目标机器人过滤（send_message 与 send_forward_message 的投递事件携带）' },
        settleSeconds: {
          type: 'number',
          minimum: 1,
          maximum: 30,
          description: '静默期秒数；匹配到消息后继续收集同条件消息，直到静默期内不再出现新消息。返回 event 为最后一条，events 为完整序列。省略则匹配到第一条即返回，结果里没有 events',
        },
        timeoutSeconds: TIMEOUT_SECONDS,
      },
      required: ['spaceId', 'cursor'],
    },
    outputSchema: WAIT_MESSAGE_OUTPUT,
    quota: 'wait', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: waitForMessageEvent,
  },
  {
    name: 'wait_for_chatluna_state',
    scope: 'interact',
    description: '从事件游标等待 ChatLuna 状态变更',
    inputSchema: {
      type: 'object',
      description: '从事件游标等待 ChatLuna 状态变更；匹配的是游标之后发生的变更，而不是当前状态，因此上一轮已经结束的状态不会被当成本轮结果。',
      properties: {
        spaceId: SPACE_REQUIRED,
        cursor: CURSOR,
        botParticipantId: { type: 'string' },
        conversationId: { type: 'string' },
        thinking: { type: 'boolean' },
        timeoutSeconds: TIMEOUT_SECONDS,
      },
      required: ['spaceId', 'cursor'],
    },
    outputSchema: WAIT_CHATLUNA_STATE_OUTPUT,
    quota: 'wait', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: waitForChatLunaState,
  },
  {
    name: 'wait_for_onebot_action',
    scope: 'debug',
    description: '从事件游标等待插件发起的 OneBot action 调用',
    inputSchema: {
      type: 'object',
      description: '等待被测插件真实发起的 OneBot action 调用记录，用于断言某条消息是否触发了预期 action 及其成败。成功时直接返回匹配记录与事件游标。',
      properties: {
        spaceId: SPACE_REQUIRED,
        cursor: CURSOR,
        botId: { type: 'string', description: '按发起机器人过滤' },
        action: { type: 'string', description: '按规范 action 过滤，并覆盖能力矩阵声明的全部别名' },
        requestedAction: { type: 'string', description: '仅精确匹配插件实际请求名' },
        status: { type: 'string', enum: ['success', 'error'], description: '按调用结果过滤' },
        timeoutSeconds: TIMEOUT_SECONDS,
      },
      required: ['spaceId', 'cursor'],
    },
    outputSchema: WAIT_ONEBOT_ACTION_OUTPUT,
    // 能力范围是调试类，配额档却是等待类：等待档按「这次调用会挂多久」分，不按能力范围分。
    quota: 'wait', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: waitForOneBotAction,
  },
  {
    name: 'apply_environment_changes',
    scope: 'manage',
    description: '原子应用测试环境变更',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        expectedRevision: { type: 'number', description: '当前场景 revision（从 get_scene_snapshot 获取）；不一致时拒绝' },
        changes: {
          type: 'array',
          description: '按顺序原子应用的环境变更；任一项失败则整体不生效',
          items: { oneOf: ENVIRONMENT_CHANGE_SCHEMAS },
        },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ['spaceId', 'expectedRevision', 'changes', 'idempotencyKey'],
      description: 'expectedRevision 只能拒绝重复提交，无法告知上一次是否已经生效；响应丢失后请用同一 idempotencyKey 与同一参数重试，服务端会返回首次结果。',
    },
    // expectedRevision 只能拒绝重复提交：响应在网络上丢失后重试会拿到 revision_conflict，
    // 消费者无从判断上一次是否已经生效。幂等键补上「重试返回首次结果」这条路径。
    quota: 'mutation', spaceResolution: 'mutation', idempotent: true, requiresConfirmation: false,
    run: applyEnvironmentChanges,
  },
  {
    name: 'create_test_space',
    scope: 'manage',
    description: '创建空白且隔离的 AI 测试空间',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, idempotencyKey: IDEMPOTENCY_KEY },
      required: ['idempotencyKey'],
    },
    quota: 'mutation', spaceResolution: 'none', idempotent: true, requiresConfirmation: false,
    run: createTestSpace,
  },
  {
    name: 'complete_test_space',
    scope: 'manage',
    description: '将 AI 测试空间标记为已完成并停止机器人',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED, idempotencyKey: IDEMPOTENCY_KEY }, required: ['spaceId', 'idempotencyKey'] },
    quota: 'mutation', spaceResolution: 'none', idempotent: true, requiresConfirmation: false,
    run: (runtime, args) => completeTestSpace(runtime, args, false),
  },
  {
    name: 'fail_test_space',
    scope: 'manage',
    description: '将 AI 测试空间标记为失败并停止机器人',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED, idempotencyKey: IDEMPOTENCY_KEY }, required: ['spaceId', 'idempotencyKey'] },
    quota: 'mutation', spaceResolution: 'none', idempotent: true, requiresConfirmation: false,
    run: (runtime, args) => completeTestSpace(runtime, args, true),
  },
  {
    name: 'reactivate_test_space',
    scope: 'manage',
    description: '重新激活已完成或失败的 AI 测试空间',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED, idempotencyKey: IDEMPOTENCY_KEY }, required: ['spaceId', 'idempotencyKey'] },
    quota: 'mutation', spaceResolution: 'none', idempotent: true, requiresConfirmation: false,
    run: reactivateTestSpace,
  },
  {
    name: 'delete_test_space',
    scope: 'manage',
    description: '删除 AI 测试空间；除非用户明确要求，否则测试完成后应默认保留',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED, idempotencyKey: IDEMPOTENCY_KEY }, required: ['spaceId', 'idempotencyKey'] },
    quota: 'mutation', spaceResolution: 'none', idempotent: true, requiresConfirmation: false,
    run: deleteTestSpace,
  },
  {
    name: 'prepare_destructive_action',
    scope: 'manage',
    description: '准备一次性破坏性操作确认令牌',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        expectedRevision: { type: 'number' },
        tool: { type: 'string', enum: ['delete_environment_entity', 'reset_scene', 'clear_scene', 'import_scene'] },
        arguments: { type: 'object', description: '必须与随后实际调用去除 confirmationToken 后的参数逐字段一致（含 spaceId），否则确认失败' },
      },
      required: ['spaceId', 'expectedRevision', 'tool', 'arguments'],
    },
    // 签发令牌的这一步自己不需要令牌，也不幂等：两个标记都不带。
    quota: 'mutation', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: prepareDestructiveAction,
  },
  {
    name: 'delete_environment_entity',
    scope: 'manage',
    description: '删除现有环境实体',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        kind: { type: 'string', enum: ['user', 'bot', 'group'] },
        id: { type: 'string' },
        confirmationToken: { type: 'string', description: 'prepare_destructive_action 返回的一次性令牌，60 秒内有效' },
      },
      required: ['spaceId', 'kind', 'id', 'confirmationToken'],
    },
    outputSchema: DESTRUCTIVE_OUTPUT,
    quota: 'mutation', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: true,
    run: deleteEnvironmentEntity,
  },
  {
    name: 'reset_scene',
    scope: 'manage',
    description: '恢复初始场景（主场景为默认场景，测试空间为创建时的空白场景）',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED, confirmationToken: { type: 'string' } }, required: ['spaceId', 'confirmationToken'] },
    outputSchema: DESTRUCTIVE_OUTPUT,
    quota: 'mutation', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: true,
    run: (runtime) => runtime.control.resetScene(),
  },
  {
    name: 'clear_scene',
    scope: 'manage',
    description: '清空当前场景',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED, confirmationToken: { type: 'string' } }, required: ['spaceId', 'confirmationToken'] },
    outputSchema: DESTRUCTIVE_OUTPUT,
    quota: 'mutation', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: true,
    run: clearScene,
  },
  {
    name: 'import_scene',
    scope: 'manage',
    description: '导入版本化 JSON 场景',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_REQUIRED,
        document: {
          type: 'object',
          properties: { testApiVersion: { type: 'number', enum: [1] }, scene: { type: 'object' } },
          required: ['testApiVersion', 'scene'],
          description: 'export_scene 导出的文档；scene.revision 会被忽略，导入后场景 revision 由服务端在当前值上递增。版本绑定由 prepare_destructive_action 的 expectedRevision 负责',
        },
        confirmationToken: { type: 'string' },
      },
      required: ['spaceId', 'document', 'confirmationToken'],
    },
    outputSchema: DESTRUCTIVE_OUTPUT,
    quota: 'mutation', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: true,
    run: importScene,
  },
  {
    name: 'list_onebot_debug_records',
    scope: 'debug',
    description: '读取 OneBot 调试记录（默认折叠大型值）',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: SPACE_OPTIONAL,
        botId: { type: 'string' },
        direction: { type: 'string', enum: [...ONEBOT_DEBUG_DIRECTIONS] },
        action: { type: 'string', description: '匹配规范 action，并覆盖能力矩阵声明的全部别名' },
        requestedAction: { type: 'string', description: '仅精确匹配插件实际请求名' },
        status: { type: 'string', enum: [...ONEBOT_DEBUG_STATUSES], description: '按调用结果筛选；省略时两种结果都返回' },
        order: { type: 'string', enum: [...RECORD_ORDERS], description: '按创建时间正序或倒序，默认倒序' },
        limit: pageLimit(DEFAULT_DEBUG_PAGE_SIZE, MAX_DEBUG_PAGE_SIZE),
        pageCursor: PAGE_CURSOR,
      },
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: listOneBotDebugRecords,
  },
  {
    name: 'get_onebot_debug_record',
    scope: 'debug',
    description: '读取单条 OneBot 调试记录，可显式展开大型值',
    inputSchema: {
      type: 'object',
      description: '按记录 ID 读取单条 OneBot 调试记录；仅在此接口允许 includeLargeValues 展开完整大型值。',
      properties: {
        spaceId: SPACE_OPTIONAL,
        recordId: { type: 'string' },
        includeLargeValues: { type: 'boolean', description: '显式展开完整大型值；列表接口不支持此参数' },
      },
      required: ['recordId'],
    },
    quota: 'read', spaceResolution: 'read', idempotent: false, requiresConfirmation: false,
    run: getOneBotDebugRecord,
  },
  {
    name: 'clear_onebot_debug_records',
    scope: 'debug',
    description: '清理 OneBot 调试记录',
    inputSchema: { type: 'object', properties: { spaceId: SPACE_REQUIRED }, required: ['spaceId'] },
    // 能力范围是调试类（配额档因此是只读），空间解析却按写操作：一个凭证不得省略 spaceId 就抹掉
    // 主环境的证据。这正是「算不算写操作不能从配额档推导」的那个反例。
    quota: 'read', spaceResolution: 'mutation', idempotent: false, requiresConfirmation: false,
    run: clearOneBotDebugRecords,
  },
  {
    name: 'list_test_call_records',
    scope: 'debug',
    description: '读取测试调用记录摘要',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        credentialName: { type: 'string' },
        transport: { type: 'string', enum: [...TEST_CALL_TRANSPORTS], description: '按承载调用的协议表述筛选：mcp 是 MCP 客户端，http 是 HTTP 接口，chatluna 是 ChatLuna 机器人工具；省略时返回全部来路的记录' },
        spaceId: { type: 'string', description: '按测试调用记录中的空间筛选；省略时返回全部记录' },
        testRunId: { type: 'string' },
        status: { type: 'string', enum: [...TEST_CALL_STATUSES], description: '按调用结果筛选；省略时两种结果都返回' },
        order: { type: 'string', enum: [...RECORD_ORDERS], description: '按创建时间正序或倒序，默认倒序' },
        limit: pageLimit(DEFAULT_TEST_CALL_PAGE_SIZE, MAX_TEST_CALL_PAGE_SIZE),
        pageCursor: PAGE_CURSOR,
      },
    },
    quota: 'read', spaceResolution: 'none', idempotent: false, requiresConfirmation: false,
    run: listTestCallRecords,
  },
  {
    name: 'get_test_call_record',
    scope: 'debug',
    description: '读取单条测试调用记录详情',
    inputSchema: {
      type: 'object',
      description: '按记录 ID 读取单条脱敏测试调用记录，包含参数、结果和错误。',
      properties: { recordId: { type: 'string' } },
      required: ['recordId'],
    },
    quota: 'read', spaceResolution: 'none', idempotent: false, requiresConfirmation: false,
    run: (runtime, args) => runtime.getCallRecord(requireString(args.recordId, 'recordId')),
  },
  {
    name: 'clear_test_call_records',
    scope: 'debug',
    description: '清理测试调用记录',
    inputSchema: { type: 'object', properties: {} },
    quota: 'read', spaceResolution: 'none', idempotent: false, requiresConfirmation: false,
    run: (runtime) => runtime.clearCallRecords(),
  },
]

/**
 * 给工具 schema 补上通用的 `testRunId` 声明。
 *
 * 它在每个工具上都会被读取（写入测试调用记录），因此逐个工具书写既冗余又必然漏；在这里统一注入
 * 让「新增工具自动带上它」成为默认行为。已经自行声明 `testRunId` 的工具（`list_test_call_records`
 * 上它是筛选维度）保留自己的描述。
 */
function withTestRunId(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  if ('testRunId' in properties) return schema
  return { ...schema, properties: { ...properties, testRunId: TEST_RUN_ID } }
}

/**
 * 工具注册表：一个工具的全部事实住在这里的一条条目上。
 *
 * 它必须是模块级常量。幂等键的说明文案由实例配置决定（窗口时长与保留条数），由读取工具声明的
 * 那一处统一注入——所有对外读取声明的路径都经同一处，声明因此不可能与实际配置漂移。注册表变成
 * 实例构造的东西就要重写这条保证。
 */
const TOOL_REGISTRY: readonly SandboxMcpToolEntry[] = TOOL_ENTRIES
  .map((entry) => ({ ...entry, inputSchema: withTestRunId(entry.inputSchema) }))

/**
 * 工具清单的对外自述，是注册表条目的投影而不是第二份声明。
 *
 * `outputSchema` 只在条目声明了它时出现，不给未覆盖的工具补一个空对象：空声明按 MCP 规范同样要求
 * 返回符合它的 `structuredContent`，而「没有声明」才是那些工具当前的真实状态。
 */
export const SANDBOX_MCP_TOOL_DECLARATIONS: readonly SandboxMcpToolCapability[] = TOOL_REGISTRY
  .map(({ name, scope, description, inputSchema, outputSchema }) => ({
    name,
    scope,
    description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
  }))

const TOOLS_BY_NAME = new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]))

/** 按名字取条目。取不到即该工具不存在——注册表是唯一的答案，没有第二处分派可落。 */
export function findSandboxMcpTool(name: string): SandboxMcpToolEntry | undefined {
  return TOOLS_BY_NAME.get(name)
}

import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 工具 inputSchema 是 AI 消费者唯一的参数契约文档：`tools/list` 之外没有别的地方能学到可用参数。
 *
 * 这份清单由测试侧独立书写，不从 `TOOL_SCHEMAS` 导入——从实现导入只能证明「实现等于自己」，
 * 字段被误删、误加、改名都不会变红。做法与 `tests/helpers/mcp-tool-catalogue.ts` 已确立的模式一致：
 * 先改这里再改实现，测试变红即意味着对外参数契约发生了变化。
 *
 * 断言对象取自 `getCapabilityCatalog()` 这个公开接口，而不是源码文本。
 */

/**
 * 每个工具声明的顶层参数名集合。
 *
 * `testRunId` 是通用的调用标注参数：它在 `appendCallRecord` 里对**所有**工具生效，而不是某个工具的
 * 业务参数，因此每个工具都声明它。`list_test_call_records` 上它另有筛选含义，由该工具自己的声明覆盖。
 */
const TOOL_PARAMETERS: Record<string, string[]> = {
  get_server_info: ['testRunId'],
  list_test_spaces: ['testRunId'],
  get_test_space: ['spaceId', 'testRunId'],
  get_scene_snapshot: ['spaceId', 'testRunId'],
  list_conversations: ['spaceId', 'operatorId', 'rootConversationId', 'limit', 'pageCursor', 'testRunId'],
  get_conversation: ['spaceId', 'operatorId', 'conversationId', 'messageLimit', 'testRunId'],
  get_forward_message: ['spaceId', 'operatorId', 'forwardId', 'messageId', 'testRunId'],
  list_pending_requests: ['spaceId', 'testRunId'],
  get_capability_matrix: ['spaceId', 'implementation', 'testRunId'],
  export_scene: ['spaceId', 'testRunId'],
  get_wakeup_rules: ['spaceId', 'conversationId', 'testRunId'],
  upload_media: ['spaceId', 'fileName', 'mimeType', 'dataBase64', 'sha256', 'testRunId'],
  send_message: ['spaceId', 'operatorId', 'conversationId', 'content', 'mediaIds', 'externalMediaUrls', 'replyToMessageId', 'idempotencyKey', 'testRunId'],
  send_forward_message: ['spaceId', 'operatorId', 'conversationId', 'messageIds', 'nodes', 'idempotencyKey', 'testRunId'],
  perform_friend_action: ['spaceId', 'operatorId', 'action', 'targetId', 'requestId', 'approve', 'comment', 'remark', 'conversationId', 'idempotencyKey', 'testRunId'],
  perform_group_action: ['spaceId', 'operatorId', 'action', 'groupId', 'targetId', 'requestId', 'approve', 'comment', 'enabled', 'card', 'title', 'name', 'conversationId', 'idempotencyKey', 'testRunId'],
  handle_request: ['spaceId', 'operatorId', 'requestId', 'approve', 'idempotencyKey', 'testRunId'],
  wait_for_event: ['spaceId', 'cursor', 'type', 'timeoutSeconds', 'testRunId'],
  wait_for_message: ['spaceId', 'cursor', 'conversationId', 'authorId', 'recipientBotId', 'settleSeconds', 'timeoutSeconds', 'testRunId'],
  wait_for_chatluna_state: ['spaceId', 'cursor', 'botParticipantId', 'conversationId', 'thinking', 'timeoutSeconds', 'testRunId'],
  wait_for_onebot_action: ['spaceId', 'cursor', 'botId', 'action', 'requestedAction', 'status', 'timeoutSeconds', 'testRunId'],
  apply_environment_changes: ['spaceId', 'expectedRevision', 'changes', 'idempotencyKey', 'testRunId'],
  create_test_space: ['name', 'idempotencyKey', 'testRunId'],
  complete_test_space: ['spaceId', 'idempotencyKey', 'testRunId'],
  fail_test_space: ['spaceId', 'idempotencyKey', 'testRunId'],
  reactivate_test_space: ['spaceId', 'idempotencyKey', 'testRunId'],
  delete_test_space: ['spaceId', 'idempotencyKey', 'testRunId'],
  prepare_destructive_action: ['spaceId', 'expectedRevision', 'tool', 'arguments', 'testRunId'],
  delete_environment_entity: ['spaceId', 'kind', 'id', 'confirmationToken', 'testRunId'],
  reset_scene: ['spaceId', 'confirmationToken', 'testRunId'],
  clear_scene: ['spaceId', 'confirmationToken', 'testRunId'],
  import_scene: ['spaceId', 'document', 'confirmationToken', 'testRunId'],
  list_onebot_debug_records: ['spaceId', 'botId', 'direction', 'action', 'requestedAction', 'status', 'order', 'limit', 'pageCursor', 'testRunId'],
  get_onebot_debug_record: ['spaceId', 'recordId', 'includeLargeValues', 'testRunId'],
  clear_onebot_debug_records: ['spaceId', 'testRunId'],
  list_model_request_records: ['scope', 'spaceId', 'botId', 'conversationId', 'interactionId', 'model', 'status', 'order', 'limit', 'pageCursor', 'testRunId'],
  get_model_request_record: ['scope', 'spaceId', 'recordId', 'testRunId'],
  clear_model_request_records: ['spaceId', 'testRunId'],
  list_test_call_records: ['tool', 'credentialName', 'transport', 'spaceId', 'testRunId', 'status', 'order', 'limit', 'pageCursor'],
  get_test_call_record: ['recordId', 'testRunId'],
  clear_test_call_records: ['testRunId'],
}

/**
 * 分页参数的契约：四个 list 工具各自的分页参数集合。
 *
 * 顶层参数名清单抓不到「哪些名字必须消失」——`beforeSequence` 换成 `pageCursor` 之后，清单里少一个
 * 名字与多一个名字看着一样。这份清单单独书写分页维度，同时把退役的四个名字逐条列出来：它们中的
 * `beforeSequence` 此前在 `scope: 'all'` 下被静默置空，翻页翻不动却不报错。
 */
const PAGINATION_PARAMETERS = ['limit', 'pageCursor']
const RETIRED_PAGINATION_PARAMETERS = ['offset', 'beforeSequence', 'beforeCreatedAt', 'beforeId', 'nextOffset', 'nextCursor']
const PAGINATED_TOOLS = [
  'list_conversations',
  'list_onebot_debug_records',
  'list_model_request_records',
  'list_test_call_records',
]

/** 每种环境变更声明的 `data` 字段集合。`profile` 与 `remarks` 是实现一直在读却没有声明的两处。 */
const ENVIRONMENT_CHANGE_DATA_FIELDS: Record<string, string[]> = {
  'create-user': ['id', 'name', 'avatar', 'profile'],
  'update-user': ['id', 'name', 'avatar', 'profile'],
  'create-bot': ['id', 'name', 'implementation', 'enabled', 'avatar', 'disabledCapabilities', 'profile'],
  'update-bot': ['id', 'name', 'implementation', 'enabled', 'avatar', 'disabledCapabilities', 'profile'],
  'set-capabilities': ['id', 'disabledCapabilities'],
  'create-group': ['id', 'name', 'avatar', 'members'],
  'update-group': ['id', 'name', 'avatar', 'members'],
  'set-friendship': ['firstId', 'secondId', 'enabled', 'remarks'],
}

/**
 * 群成员条目声明的字段集合。
 * `normalizeGroupMemberFromUnknown` 读取的建模字段远多于原先声明的四项，这里按它的建模字段书写。
 */
const GROUP_MEMBER_FIELDS = [
  'participantId',
  'role',
  'card',
  'title',
  'mutedUntil',
  'area',
  'joinTime',
  'lastSentTime',
  'level',
  'unfriendly',
  'titleExpireTime',
  'cardChangeable',
]

/** 账号资料声明的字段集合，与 `parseAccountProfileFromUnknown` 的建模字段一致。 */
const ACCOUNT_PROFILE_FIELDS = [
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
]

/**
 * 参数取值组合的契约：每个工具的 `oneOf`／`anyOf` 分支各自要求哪些参数。
 *
 * 顶层参数名清单抓不到这一层——`set-card` 要带 `card` 此前只写在 `card` 的描述里，消费者得读完每条
 * 描述才拼得出一次合法调用。分支清单由测试侧独立书写，键是分支标题、值是该分支追加的必填参数。
 */
const TOOL_VARIANTS: Record<string, Record<string, string[]>> = {
  perform_friend_action: {
    request: ['targetId'],
    'handle-request': ['requestId', 'approve'],
    delete: ['targetId'],
    'set-remark': ['targetId', 'remark'],
    poke: ['targetId'],
  },
  perform_group_action: {
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
  },
  // 记录域：只有 space 分支需要空间标识，其余三种取值不带。
  list_model_request_records: { all: [], main: [], space: ['spaceId'], unattributed: [] },
  get_model_request_record: { all: [], main: [], space: ['spaceId'], unattributed: [] },
  send_forward_message: { 引用已有消息: ['messageIds'], 显式节点: ['nodes'] },
}

type SchemaNode = {
  properties?: Record<string, SchemaNode>
  items?: SchemaNode & { oneOf?: Array<SchemaNode & { title?: string }> }
  title?: string
  required?: string[]
  oneOf?: Array<SchemaNode & { title?: string }>
  anyOf?: Array<SchemaNode & { title?: string }>
  const?: string
  minimum?: number
  maximum?: number
}

function propertyNames(schema: SchemaNode | undefined): string[] {
  return Object.keys(schema?.properties ?? {}).sort()
}

function toolSchemas(): Record<string, SchemaNode> {
  const { service } = createMcpTestService(['read'])
  return Object.fromEntries(service.getCapabilityCatalog().tools.map(({ name, inputSchema }) => [name, inputSchema as SchemaNode]))
}

function environmentChangeSchemas(schemas: Record<string, SchemaNode>): Array<SchemaNode & { title?: string }> {
  const changes = schemas.apply_environment_changes?.properties?.changes
  return changes?.items?.oneOf ?? []
}

describe('MCP 工具参数契约', () => {
  afterEach(async () => {
    await stopMcpTestApps()
  })

  it('每个工具声明的顶层参数名与契约清单逐条一致', () => {
    const schemas = toolSchemas()

    expect(Object.keys(schemas).sort()).toEqual(Object.keys(TOOL_PARAMETERS).sort())
    for (const [tool, parameters] of Object.entries(TOOL_PARAMETERS)) {
      expect({ tool, parameters: propertyNames(schemas[tool]) }).toEqual({ tool, parameters: [...parameters].sort() })
    }
  })

  it('每种环境变更声明的 data 字段与契约清单逐条一致', () => {
    const changes = environmentChangeSchemas(toolSchemas())

    expect(changes.map(({ title }) => title)).toEqual(Object.keys(ENVIRONMENT_CHANGE_DATA_FIELDS))
    for (const change of changes) {
      expect({
        change: change.title,
        fields: propertyNames(change.properties?.data),
      }).toEqual({
        change: change.title,
        fields: [...ENVIRONMENT_CHANGE_DATA_FIELDS[change.title!]].sort(),
      })
    }
  })

  it('嵌套的群成员与账号资料条目声明全部建模字段', () => {
    const schemas = toolSchemas()
    const changes = environmentChangeSchemas(schemas)
    const byTitle = new Map(changes.map((change) => [change.title, change]))

    for (const change of ['create-group', 'update-group']) {
      expect({
        change,
        fields: propertyNames(byTitle.get(change)?.properties?.data?.properties?.members?.items),
      }).toEqual({ change, fields: [...GROUP_MEMBER_FIELDS].sort() })
    }
    for (const change of ['create-user', 'update-user', 'create-bot', 'update-bot']) {
      expect({
        change,
        fields: propertyNames(byTitle.get(change)?.properties?.data?.properties?.profile),
      }).toEqual({ change, fields: [...ACCOUNT_PROFILE_FIELDS].sort() })
    }
  })

  it('update-user 与 update-bot 的资料清除语义写进 schema 描述，且类型真的接受 null', () => {
    const byTitle = new Map(environmentChangeSchemas(toolSchemas()).map((change) => [change.title, change]))
    const profileOf = (change: string) => byTitle.get(change)?.properties?.data?.properties?.profile as
      { description?: string; type?: string | string[] } | undefined

    for (const change of ['update-user', 'update-bot']) {
      const profile = profileOf(change)
      // 「显式传 null 或非法值即清除资料」此前完全没有对外文档，AI 消费者只能读源码才能发现。
      expect(profile?.description).toMatch(/清除/)
      // 字段名清单抓不到类型漂移：只声明 object 会让文档推荐的 null 按 JSON Schema 非法，
      // 严格校验的客户端会在发出前就拒绝它。
      expect({ change, type: profile?.type }).toEqual({ change, type: ['object', 'null'] })
    }
    // 创建路径没有清除语义，仍然只接受对象。
    for (const change of ['create-user', 'create-bot']) {
      expect({ change, type: profileOf(change)?.type }).toEqual({ change, type: 'object' })
    }
  })

  it('每个判别联合分支声明的追加必填参数与契约清单逐条一致', () => {
    const schemas = toolSchemas()

    for (const [tool, variants] of Object.entries(TOOL_VARIANTS)) {
      const branches = schemas[tool]?.oneOf ?? []
      expect({ tool, variants: branches.map(({ title }) => title) }).toEqual({ tool, variants: Object.keys(variants) })
      for (const branch of branches) {
        expect({ tool, variant: branch.title, required: [...(branch.required ?? [])].sort() })
          .toEqual({ tool, variant: branch.title, required: [...variants[branch.title!]!].sort() })
      }
    }
  })

  it('判别式取值由分支自己钉住，因此一次调用恰好匹配一个分支', () => {
    const schemas = toolSchemas()

    // 分支不钉判别式时 oneOf 会退化成「随便满足一个」，一次缺参数的调用可能匹配到另一个分支。
    for (const tool of ['perform_friend_action', 'perform_group_action']) {
      for (const branch of schemas[tool]?.oneOf ?? []) {
        expect({ tool, variant: branch.title, discriminator: branch.properties?.action?.const })
          .toEqual({ tool, variant: branch.title, discriminator: branch.title })
      }
    }
    for (const tool of ['list_model_request_records', 'get_model_request_record']) {
      for (const branch of schemas[tool]?.oneOf ?? []) {
        expect({ tool, variant: branch.title, discriminator: branch.properties?.scope?.const })
          .toEqual({ tool, variant: branch.title, discriminator: branch.title })
      }
    }
    // 动作枚举与分支清单同源：声明里能选的动作必须都有一个分支说明它要带什么。
    for (const tool of ['perform_friend_action', 'perform_group_action']) {
      expect({ tool, actions: (schemas[tool]?.properties?.action as { enum?: string[] } | undefined)?.enum })
        .toEqual({ tool, actions: (schemas[tool]?.oneOf ?? []).map(({ title }) => title) })
    }
  })

  it('合并转发资源的「至少提供一项」写进声明而不是只写在描述里', () => {
    const forward = toolSchemas().get_forward_message

    expect(forward?.anyOf).toEqual([{ required: ['forwardId'] }, { required: ['messageId'] }])
  })

  it('四个 list 工具的分页参数只有 limit 与 pageCursor，退役的游标参数不再出现', () => {
    const schemas = toolSchemas()

    for (const tool of PAGINATED_TOOLS) {
      const parameters = propertyNames(schemas[tool])
      expect({ tool, pagination: parameters.filter((name) => PAGINATION_PARAMETERS.includes(name)) })
        .toEqual({ tool, pagination: [...PAGINATION_PARAMETERS].sort() })
      expect({ tool, retired: parameters.filter((name) => RETIRED_PAGINATION_PARAMETERS.includes(name)) })
        .toEqual({ tool, retired: [] })
      // 上下限写在声明里，越界才谈得上「按声明收敛」（ADR-0098）。
      expect({ tool, limit: schemas[tool]?.properties?.limit })
        .toEqual({ tool, limit: expect.objectContaining({ minimum: 1, maximum: 200 }) })
    }
  })
})

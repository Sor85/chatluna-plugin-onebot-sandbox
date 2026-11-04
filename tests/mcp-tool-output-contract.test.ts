import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxMcpService } from '../src/mcp/service'
import { createDirectSession, emitChatLunaEvent } from './helpers/chatluna-state-broadcast'
import { createMcpTestService, createStartedMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 工具返回值的对外声明。
 *
 * 消费者此前对返回值的了解全靠「调一次看看」：等待类最需要声明，四个 `wait_for_*` 的成功载荷键各不
 * 相同，而它们是编排里调用最频繁的一族。这份清单由测试侧独立书写，不从 `src/mcp/tool-registry.ts`
 * 导入——从实现导入只能证明「实现等于自己」，字段被误删、误加、改名都不会变红。做法与工具清单
 * （`tests/helpers/mcp-tool-catalogue.ts`）和参数契约（`tests/mcp-tool-schema-contract.test.ts`）一致。
 *
 * 只断言声明存在同样等于只证明实现等于自己，因此本文件另有一组用例真的调用这些工具，把返回值的顶层
 * 字段与声明逐条比对。两种协议表述各自把声明带出去的断言在
 * `tests/mcp-http.test.ts`（`tools/list`）与 `tests/http-api.test.ts`（`GET /v1/tools`）里。
 */

afterEach(async () => {
  await stopMcpTestApps()
})

interface OutputContract {
  /** 声明里出现的全部顶层字段，按声明顺序。 */
  fields: string[]
  /** 两种结果都必带的顶层字段。 */
  required: string[]
  /** 判别式分支各自追加的必填字段；没有判别式的工具不写。 */
  variants?: Record<string, string[]>
}

/**
 * 声明了 outputSchema 的工具及其顶层字段。
 *
 * 覆盖范围的判据是「返回形状能不能从工具名与参数推断出来」：`get_scene_snapshot` 能，
 * `wait_for_message` 不能。其余工具当前不声明，也不给空对象。
 */
const TOOL_OUTPUTS: Record<string, OutputContract> = {
  get_server_info: {
    fields: ['name', 'testApiVersion', 'transport', 'stateless', 'cursor'],
    required: ['name', 'testApiVersion', 'transport', 'stateless', 'cursor'],
  },
  send_message: {
    // cursorBefore 与 cursor 是两个最容易被搞混的游标（ADR-0102），因此两个都在声明里。
    fields: ['messageId', 'revision', 'cursorBefore', 'cursor'],
    required: ['messageId', 'revision', 'cursorBefore', 'cursor'],
  },
  send_forward_message: {
    fields: ['messageId', 'forwardId', 'revision', 'cursorBefore', 'cursor'],
    required: ['messageId', 'forwardId', 'revision', 'cursorBefore', 'cursor'],
  },
  wait_for_event: {
    fields: ['outcome', 'event', 'reason', 'cursor'],
    required: ['outcome', 'cursor'],
    variants: { matched: ['event'], timeout: ['reason'] },
  },
  wait_for_message: {
    // events 只在传了 settleSeconds 时出现，因此它在声明里但不在任何分支的必填项里。
    fields: ['outcome', 'event', 'events', 'reason', 'cursor'],
    required: ['outcome', 'cursor'],
    variants: { matched: ['event'], timeout: ['reason'] },
  },
  wait_for_chatluna_state: {
    fields: ['outcome', 'state', 'reason', 'cursor'],
    required: ['outcome', 'cursor'],
    variants: { matched: ['state'], timeout: ['reason'] },
  },
  wait_for_onebot_action: {
    fields: ['outcome', 'record', 'reason', 'cursor'],
    required: ['outcome', 'cursor'],
    variants: { matched: ['record'], timeout: ['reason'] },
  },
  // 四个破坏性工具共用一份声明：它们对外都只答新版本与新游标。
  delete_environment_entity: { fields: ['revision', 'cursor'], required: ['revision', 'cursor'] },
  reset_scene: { fields: ['revision', 'cursor'], required: ['revision', 'cursor'] },
  clear_scene: { fields: ['revision', 'cursor'], required: ['revision', 'cursor'] },
  import_scene: { fields: ['revision', 'cursor'], required: ['revision', 'cursor'] },
}

type OutputSchema = {
  properties: Record<string, unknown>
  required: string[]
  oneOf?: Array<{ title: string; properties: { outcome: { const: string } }; required: string[] }>
}

function readOutputSchemas(service: SandboxMcpService): Record<string, OutputSchema> {
  return Object.fromEntries(service.getCapabilityCatalog().tools
    .flatMap(({ name, outputSchema }) => (outputSchema ? [[name, outputSchema as OutputSchema]] : [])))
}

/** 一次真实返回值与它的声明逐条比对：顶层字段不多、必填字段不少。 */
function assertResultMatchesDeclaration(tool: string, branch: string, result: unknown, schema: OutputSchema) {
  const keys = Object.keys(result as Record<string, unknown>)
  expect({ tool, branch, extra: keys.filter((key) => !(key in schema.properties)) })
    .toEqual({ tool, branch, extra: [] })
  expect({ tool, branch, missing: schema.required.filter((key) => !keys.includes(key)) })
    .toEqual({ tool, branch, missing: [] })
  if (!schema.oneOf) return
  // 判别式分支：本分支的必填项必须齐全，另一分支的必填项必须缺席——否则「匹配到了但没有事件」
  // 或「等到了却带着超时原因」这两个不该存在的状态又能表达了。
  const outcome = String((result as { outcome?: unknown }).outcome)
  const matched = schema.oneOf.find(({ properties }) => properties.outcome.const === outcome)
  expect({ tool, branch, outcome, declared: Boolean(matched) }).toEqual({ tool, branch, outcome, declared: true })
  expect({ tool, branch, missing: matched!.required.filter((key) => !keys.includes(key)) })
    .toEqual({ tool, branch, missing: [] })
  for (const other of schema.oneOf.filter(({ title }) => title !== matched!.title)) {
    expect({ tool, branch, leaked: other.required.filter((key) => keys.includes(key)) })
      .toEqual({ tool, branch, leaked: [] })
  }
}

/** 取得一次性确认令牌；破坏性操作的 `arguments` 必须与随后实际调用去除令牌后的参数逐字段一致。 */
async function prepareDestructive(
  service: SandboxMcpService,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  revision: number,
): Promise<string> {
  const prepared = await service.callTool(token, 'prepare_destructive_action', {
    expectedRevision: revision,
    tool,
    arguments: args,
  }) as { confirmationToken: string }
  return prepared.confirmationToken
}

describe('工具返回声明', () => {
  it('声明了 outputSchema 的工具与顶层字段清单逐条一致', () => {
    const { service } = createMcpTestService(['read'])
    const schemas = readOutputSchemas(service)

    expect(Object.keys(schemas)).toEqual(Object.keys(TOOL_OUTPUTS))
    for (const [tool, contract] of Object.entries(TOOL_OUTPUTS)) {
      expect({ tool, fields: Object.keys(schemas[tool]!.properties) }).toEqual({ tool, fields: contract.fields })
      expect({ tool, required: schemas[tool]!.required }).toEqual({ tool, required: contract.required })
      expect({ tool, variants: schemas[tool]!.oneOf?.map(({ title, required }) => [title, required]) })
        .toEqual({ tool, variants: contract.variants && Object.entries(contract.variants) })
    }
  })

  it('未覆盖的工具没有 outputSchema 字段，而不是一个空对象', () => {
    const { service } = createMcpTestService(['read'])

    const uncovered = service.getCapabilityCatalog().tools.filter(({ name }) => !(name in TOOL_OUTPUTS))
    expect(uncovered.length).toBeGreaterThan(0)
    for (const tool of uncovered) {
      // 空声明按 MCP 规范同样要求返回符合它的 structuredContent；「没有声明」才是这些工具的真实状态。
      expect({ tool: tool.name, declared: 'outputSchema' in tool }).toEqual({ tool: tool.name, declared: false })
    }
  })

  it('等待类结果用 outcome 判别，matched 从返回值消失', () => {
    const { service } = createMcpTestService(['read'])
    const schemas = readOutputSchemas(service)

    for (const tool of ['wait_for_event', 'wait_for_message', 'wait_for_chatluna_state', 'wait_for_onebot_action']) {
      expect({ tool, outcome: (schemas[tool]!.properties.outcome as { enum: string[] }).enum })
        .toEqual({ tool, outcome: ['matched', 'timeout'] })
      expect({ tool, matched: 'matched' in schemas[tool]!.properties }).toEqual({ tool, matched: false })
      // 分支各自钉住判别式，因此一次返回恰好匹配一个分支。
      expect({ tool, pinned: schemas[tool]!.oneOf?.map(({ title, properties }) => properties.outcome.const === title) })
        .toEqual({ tool, pinned: [true, true] })
    }
    // 静默期序列只在声明里，不在任何分支的必填项里：不传 settleSeconds 时结果里没有它。
    const message = schemas.wait_for_message!
    expect(message.oneOf!.flatMap(({ required }) => required)).not.toContain('events')
    expect((message.properties.events as { description: string }).description).toContain('settleSeconds')
  })
})

describe('工具返回值与声明一致', () => {
  it('服务自述与两个发送工具的返回值字段齐全且没有多余字段', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'interact'])
    // 未启动 App 时机器人 middleware 不会收敛，send_message 会一直等待同步回复；停用后仍会写入消息。
    control.updateBot({ id: '20001', name: 'Koishi', implementation: 'napcat', enabled: false })
    const schemas = readOutputSchemas(service)
    const call = (tool: string, args: Record<string, unknown>) => service.callTool(credential.token, tool, args)

    assertResultMatchesDeclaration('get_server_info', '自述', await call('get_server_info', {}), schemas.get_server_info!)

    const sent = await call('send_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', content: '输出声明用例', idempotencyKey: 'output-send-1',
    }) as { messageId: string }
    assertResultMatchesDeclaration('send_message', '发送', sent, schemas.send_message!)

    const forwarded = await call('send_forward_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', messageIds: [sent.messageId], idempotencyKey: 'output-forward-1',
    })
    assertResultMatchesDeclaration('send_forward_message', '发送', forwarded, schemas.send_forward_message!)
  })

  it('等待类工具的 matched 分支与声明一致，静默期序列也在声明里', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'interact'])
    control.updateBot({ id: '20001', name: 'Koishi', implementation: 'napcat', enabled: false })
    const schemas = readOutputSchemas(service)
    const call = (tool: string, args: Record<string, unknown>) => service.callTool(credential.token, tool, args)

    const before = service.currentCursor()
    await call('send_message', {
      operatorId: '10001', conversationId: 'private:10001:20001', content: '等待声明用例', idempotencyKey: 'output-wait-1',
    })

    assertResultMatchesDeclaration('wait_for_event', 'matched', await call('wait_for_event', {
      cursor: before, type: 'message.created', timeoutSeconds: 1,
    }), schemas.wait_for_event!)
    assertResultMatchesDeclaration('wait_for_message', 'matched', await call('wait_for_message', {
      cursor: before, timeoutSeconds: 1,
    }), schemas.wait_for_message!)
    // 静默期分支多一个 events：它在声明里，因此不算多余字段。
    const settled = await call('wait_for_message', { cursor: before, settleSeconds: 1, timeoutSeconds: 2 }) as { events?: unknown[] }
    expect(settled.events).toEqual([expect.anything()])
    assertResultMatchesDeclaration('wait_for_message', 'matched+settleSeconds', settled, schemas.wait_for_message!)
  })

  it('四个等待类工具的 timeout 分支都只带 reason，不带任何载荷键', async () => {
    const { service, credential } = createMcpTestService(['read', 'interact', 'debug'])
    const schemas = readOutputSchemas(service)
    const tools = ['wait_for_event', 'wait_for_message', 'wait_for_chatluna_state', 'wait_for_onebot_action']

    // 四次等待并发跑：它们互相独立，逐个跑要挂满四个超时。
    const cursor = service.currentCursor()
    const results = await Promise.all(tools.map((tool) => service.callTool(credential.token, tool, { cursor, timeoutSeconds: 1 })))

    for (const [index, tool] of tools.entries()) {
      expect({ tool, result: results[index] }).toMatchObject({ tool, result: { outcome: 'timeout', reason: 'timeout' } })
      assertResultMatchesDeclaration(tool, 'timeout', results[index], schemas[tool]!)
    }
  })

  it('ChatLuna 状态与 OneBot 调用的 matched 分支带各自的载荷键', async () => {
    const { app, service, credential, control } = await createStartedMcpTestService(['interact', 'debug'])
    const schemas = readOutputSchemas(service)
    const call = (tool: string, args: Record<string, unknown>) => service.callTool(credential.token, tool, args)

    const cursor = service.currentCursor()
    const pending = call('wait_for_chatluna_state', { cursor, botParticipantId: '20001', thinking: true, timeoutSeconds: 5 })
    await emitChatLunaEvent(app, 'chatluna/before-chat', 'chatluna:direct', {}, {}, {}, createDirectSession(control, '20001'))
    assertResultMatchesDeclaration('wait_for_chatluna_state', 'matched', await pending, schemas.wait_for_chatluna_state!)

    const actionCursor = service.currentCursor()
    await control.bot.internal._request('get_login_info', {})
    assertResultMatchesDeclaration('wait_for_onebot_action', 'matched', await call('wait_for_onebot_action', {
      cursor: actionCursor, botId: '20001', timeoutSeconds: 5,
    }), schemas.wait_for_onebot_action!)
  })

  it('四个破坏性工具都只答新版本与新游标', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'manage'])
    const schemas = readOutputSchemas(service)
    const call = (tool: string, args: Record<string, unknown>) => service.callTool(credential.token, tool, args)
    const revision = () => control.getSnapshot().revision

    await call('apply_environment_changes', {
      expectedRevision: revision(),
      idempotencyKey: 'output-destructive-seed-1',
      changes: [{ action: 'create-user', data: { id: '19801', name: '待删除用户' } }],
    })
    const deleted = { kind: 'user', id: '19801' }
    assertResultMatchesDeclaration('delete_environment_entity', '删除实体', await call('delete_environment_entity', {
      ...deleted, confirmationToken: await prepareDestructive(service, credential.token, 'delete_environment_entity', deleted, revision()),
    }), schemas.delete_environment_entity!)

    assertResultMatchesDeclaration('reset_scene', '恢复初始场景', await call('reset_scene', {
      confirmationToken: await prepareDestructive(service, credential.token, 'reset_scene', {}, revision()),
    }), schemas.reset_scene!)

    const document = await call('export_scene', {})
    assertResultMatchesDeclaration('clear_scene', '清空场景', await call('clear_scene', {
      confirmationToken: await prepareDestructive(service, credential.token, 'clear_scene', {}, revision()),
    }), schemas.clear_scene!)

    assertResultMatchesDeclaration('import_scene', '导入场景', await call('import_scene', {
      document,
      confirmationToken: await prepareDestructive(service, credential.token, 'import_scene', { document }, revision()),
    }), schemas.import_scene!)
  })
})

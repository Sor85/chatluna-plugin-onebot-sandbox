import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { captureLogs } from './helpers/app'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'

/**
 * 错误码是对外契约：`onebot-sandbox://errors` 资源必须列出实现实际会发出的全部码。
 *
 * 这份守卫从 `src/mcp/` 源码枚举抛出点，再与资源返回的数组双向比较。它是源码文本断言，落在
 * ADR-0073 明确列出的第三类例外里——守卫自身读取源码，断言对象本来就是源码结构。「实现总共可能
 * 发出哪些错误码」没有别的观察面：任何调用序列都枚举不出全部抛出点。按该 ADR 的成本结构判据也
 * 站得住：改错误消息、挪抛出点、合并分支都不会让它变红，只有引入未登记的码或删掉在用的码才会红。
 *
 * 守卫按 ADR-0073 采用规则制而不是白名单制：谓词跑遍 `src/mcp` 的全部源码，没有豁免清单。
 * 两侧独立：一侧是散落各处的抛出点，一侧是集中的资源数组，因此不构成「实现等于自己」。
 */

const MCP_SOURCE_DIRECTORY = resolve(import.meta.dirname, '../src/mcp')

/**
 * 扫描 src/mcp 全部源码，返回实现可能发出的错误码集合。
 *
 * 守卫是规则制的，没有白名单：谓词跑遍 src/mcp 的每个文件，因此新增文件与新增抛出点默认受约束。
 * 这要求实现侧不把错误码算出来再交给共用的 throw——`resolveControl` 的三个空间态因此各自写成
 * 字面量抛出点，否则那三个码扫不到，只能靠测试侧列白名单补，而白名单外的新码会静默漏检。
 */
function scanThrownErrorCodes(): string[] {
  const codes = new Set<string>()
  for (const entry of readdirSync(MCP_SOURCE_DIRECTORY)) {
    if (!entry.endsWith('.ts')) continue
    const source = readFileSync(join(MCP_SOURCE_DIRECTORY, entry), 'utf8')
    for (const [, code] of source.matchAll(/new SandboxMcpError\('([a-z_]+)'/g)) codes.add(code)
  }
  return [...codes].sort()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await stopMcpTestApps()
})

describe('MCP 错误码契约', () => {
  it('错误码资源与实现的抛出点双向一致', () => {
    const { service, credential } = createMcpTestService(['read'])

    const declared = service.readResource(credential.token, 'onebot-sandbox://errors') as string[]
    expect(new Set(declared).size).toBe(declared.length)
    // 排序后整体比较即「两侧互为子集」：实现新增未登记的码、资源留下已删除的码，都会变红。
    expect([...declared].sort()).toEqual(scanThrownErrorCodes())
  })

  it('同类失败在所有工具上返回同一个错误码拼写', async () => {
    const { service, credential } = createMcpTestService(['read', 'debug'])

    // 曾经全仓库唯一的单数形式 invalid_argument 就藏在这条路径上。
    await expect(service.callTool(credential.token, 'list_onebot_debug_records', { includeLargeValues: true }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(service.callTool(credential.token, 'get_conversation', { operatorId: '10001', conversationId: '  ' }))
      .rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('未预期异常返回 internal_error、不泄漏原始 message，堆栈写入 Logger', async () => {
    const { app, service, credential, control } = createMcpTestService(['read'])
    const injected = new TypeError('内部实现细节：cannot read properties of undefined')
    vi.spyOn(control, 'getVisibleSnapshot').mockImplementation(() => { throw injected })

    // 换掉 Logger 的输出目标而不是打桩服务内部：既能断言堆栈真的走到了 Koishi Logger，也顺带
    // 让这条用例不往测试输出里打真实错误。
    const { printed, restore } = captureLogs(app)

    try {
      const failure = await service.callTool(credential.token, 'list_conversations', { operatorId: '10001' })
        .then(() => undefined, (error: { code: string; message: string }) => error)

      expect(failure).toMatchObject({ code: 'internal_error' })
      expect(failure!.message).not.toContain('内部实现细节')
      const record = printed.join('\n')
      expect(record).toContain('list_conversations')
      // 堆栈只留在 Koishi Logger，客户端只看到错误码，维护者仍能定位。
      expect(record).toContain('内部实现细节')
    } finally {
      restore()
    }
  })

  it('可预期的领域业务拒绝仍返回可分支处理的错误码与原始消息', async () => {
    const { service, credential, control } = createMcpTestService(['read', 'interact'])
    control.createUser({ id: '10005', name: '普通成员' })
    control.updateGroup({
      id: '30001',
      name: '默认群',
      members: [
        { participantId: '20001', role: 'owner' },
        { participantId: '10001', role: 'member' },
        { participantId: '10005', role: 'member' },
      ],
    })

    // 权限判定是领域主动作出的拒绝，消息对外部测试控制器有用，不能被降级成 internal_error。
    await expect(service.callTool(credential.token, 'perform_group_action', {
      operatorId: '10005',
      action: 'set-admin',
      groupId: '30001',
      targetId: '10001',
      enabled: true,
      idempotencyKey: 'domain-reject-1',
    })).rejects.toMatchObject({ code: 'domain_error', message: '只有群主可以设置管理员' })
  })
})

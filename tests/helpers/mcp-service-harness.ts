import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './app'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../../src/control-service'
import { SandboxMcpService, type SandboxMcpServiceOptions } from '../../src/mcp/service'
import { SandboxTestSpaceService } from '../../src/test-spaces'

export type SandboxMcpTestScope = 'read' | 'interact' | 'manage' | 'debug'

export interface McpTestHarness {
  app: App
  control: SandboxControlService
  service: SandboxMcpService
  credential: ReturnType<SandboxMcpService['createCredential']>
  directory: string
  testSpaces: SandboxTestSpaceService
  runtimeBots: SandboxRuntimeBotRegistry
}

const apps: App[] = []

/** 登记由测试自行构造的 App，交给 {@link stopMcpTestApps} 统一收尾。 */
export function registerMcpTestApp(app: App): App {
  apps.push(app)
  return app
}

export async function stopMcpTestApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
}

/**
 * 构造一套「控制服务 + 测试空间 + MCP 服务 + 凭证」。
 *
 * 全部工具调用测试都经 `service.callTool` 这一个入口，因此凭证校验、能力范围检查、限流分类、
 * 并发包装、幂等与调用记录一并被覆盖；下降到领域服务各自的方法会漏掉这些行为。
 */
export function createMcpTestService(
  scopes: SandboxMcpTestScope[] = ['read'],
  enableTestSpaces = false,
  options: Partial<SandboxMcpServiceOptions> = {},
): McpTestHarness {
  const app = registerMcpTestApp(new App())
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const service = new SandboxMcpService(app, control, {
    dataDirectory: directory,
    testSpaces: enableTestSpaces ? testSpaces : undefined,
    ...options,
  })
  const credential = service.createCredential('测试凭证', scopes)
  return { app, control, service, credential, directory, testSpaces, runtimeBots }
}

/**
 * 构造一套在已启动 App 内注册的控制服务，供需要真实 Koishi 事件流的测试使用
 * （ChatLuna 状态广播、机器人运行时 action）。
 */
export async function createStartedMcpTestService(scopes: SandboxMcpTestScope[]): Promise<McpTestHarness> {
  const app = registerMcpTestApp(new App())
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-live-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, { mediaDirectory: join(directory, 'media'), runtimeBots })
  })
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const service = new SandboxMcpService(app, control, { dataDirectory: directory })
  const credential = service.createCredential('实时测试凭证', scopes)
  return { app, control, service, credential, directory, testSpaces, runtimeBots }
}

import { describeHttpApiCapabilities, type SandboxHttpApiEndpoint } from '../../src/mcp/http-api'
import type { SandboxConsoleTestEndpoint } from '../../src/console'
import type { SandboxMcpService } from '../../src/mcp/service'

/**
 * `registerConsole` 的测试控制端点参数。
 *
 * 端点是一个整体的可空值，测试要的通常只是「它在场」；HTTP 表述的自述按默认端点配置派生一份，
 * 需要断言具体路径或基址的测试再用 overrides 覆盖对应字段。
 */
export function consoleTestEndpoint(
  mcp: SandboxMcpService,
  overrides: Partial<SandboxHttpApiEndpoint> = {},
): SandboxConsoleTestEndpoint {
  return {
    mcp,
    httpApi: describeHttpApiCapabilities({
      enabled: true,
      path: '/api',
      host: '127.0.0.1',
      port: 61901,
      tls: false,
      ...overrides,
    }),
  }
}

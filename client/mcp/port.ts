import type { SandboxMcpActivityPayload } from '../../src/console-contract'
import type { SandboxHttpApiCapabilityCatalog } from '../../src/mcp/http-api'
import type {
  SandboxMcpCapabilityCatalog,
  SandboxTestCreatedCredential,
  SandboxTestPublicCredential,
  SandboxMcpScope,
} from '../../src/mcp/types'

/** 活动广播的载荷只在 Console 契约里定义一次，这里只是本端口的别名。 */
export type McpActivityPayload = SandboxMcpActivityPayload

export type McpActivityListener = (payload: McpActivityPayload) => void

/**
 * 测试控制端点管理面的客户端 seam：测试凭证、两种协议表述各自的能力目录与服务器活动。
 * 这些都不经过模拟 QQ 环境的场景状态，因此不进工作区端口。
 *
 * 凭证方法名不带 MCP：同一个凭证在 MCP 与 HTTP 两种表述下通用（见 CONTEXT.md 的「测试凭证」），
 * 只有确实只属于某一种表述的读取才带表述名。
 */
export interface McpAdminPort {
  listTestCredentials(): Promise<SandboxTestPublicCredential[]>
  createTestCredential(input: { name: string; scopes: SandboxMcpScope[] }): Promise<SandboxTestCreatedCredential>
  updateTestCredential(input: { id: string; name?: string; scopes?: SandboxMcpScope[] }): Promise<SandboxTestPublicCredential>
  rotateTestCredentialToken(input: { id: string }): Promise<SandboxTestCreatedCredential>
  setTestCredentialEnabled(input: { id: string; enabled: boolean }): Promise<void>
  revokeTestCredential(input: { id: string }): Promise<void>
  getMcpCapabilities(): Promise<SandboxMcpCapabilityCatalog>
  getHttpApiCapabilities(): Promise<SandboxHttpApiCapabilityCatalog>
  getMcpActivity(): Promise<McpActivityPayload>
  /**
   * 订阅服务端活动广播，返回退订函数。适配器负责把一份底层广播扇出给全部订阅者，
   * 因此一个页面退订不会让仍存活的页面失聪。
   */
  subscribeMcpActivity(listener: McpActivityListener): () => void
}

export type McpAdminPortOperation = keyof McpAdminPort

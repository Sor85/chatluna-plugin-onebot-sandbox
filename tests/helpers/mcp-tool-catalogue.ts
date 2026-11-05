/**
 * 测试控制端点对外提供的完整工具清单，按 tools/list 的返回顺序逐条列出名字与能力范围。
 *
 * 这份清单是测试侧独立书写的期望值，不从 `src/mcp/service.ts` 导入：从实现导入只能证明
 * 「实现等于自己」，工具改名或能力范围写错都不会变红。数量断言同理——它只在工具增删时变红，
 * 因此三处 `toHaveLength(40)` 全部换成对本清单的整体断言，数量由清单长度隐含。
 *
 * 新增或调整对外工具时，先改这里再改实现；测试变红即意味着对外契约发生了变化。
 */
export interface McpToolCatalogueEntry {
  name: string
  scope: 'read' | 'interact' | 'manage' | 'debug'
}

export const MCP_TOOL_CATALOGUE: McpToolCatalogueEntry[] = [
  { name: 'get_server_info', scope: 'read' },
  { name: 'list_test_spaces', scope: 'read' },
  { name: 'get_test_space', scope: 'read' },
  { name: 'get_scene_snapshot', scope: 'read' },
  { name: 'list_conversations', scope: 'read' },
  { name: 'get_conversation', scope: 'read' },
  { name: 'get_forward_message', scope: 'read' },
  { name: 'list_pending_requests', scope: 'read' },
  { name: 'get_capability_matrix', scope: 'read' },
  { name: 'export_scene', scope: 'read' },
  { name: 'get_wakeup_rules', scope: 'read' },
  { name: 'upload_media', scope: 'interact' },
  { name: 'send_message', scope: 'interact' },
  { name: 'send_forward_message', scope: 'interact' },
  { name: 'perform_friend_action', scope: 'interact' },
  { name: 'perform_group_action', scope: 'interact' },
  { name: 'handle_request', scope: 'interact' },
  { name: 'wait_for_event', scope: 'interact' },
  { name: 'wait_for_message', scope: 'interact' },
  { name: 'wait_for_chatluna_state', scope: 'interact' },
  { name: 'wait_for_onebot_action', scope: 'debug' },
  { name: 'apply_environment_changes', scope: 'manage' },
  { name: 'create_test_space', scope: 'manage' },
  { name: 'complete_test_space', scope: 'manage' },
  { name: 'fail_test_space', scope: 'manage' },
  { name: 'reactivate_test_space', scope: 'manage' },
  { name: 'delete_test_space', scope: 'manage' },
  { name: 'prepare_destructive_action', scope: 'manage' },
  { name: 'delete_environment_entity', scope: 'manage' },
  { name: 'reset_scene', scope: 'manage' },
  { name: 'clear_scene', scope: 'manage' },
  { name: 'import_scene', scope: 'manage' },
  { name: 'list_onebot_debug_records', scope: 'debug' },
  { name: 'get_onebot_debug_record', scope: 'debug' },
  { name: 'clear_onebot_debug_records', scope: 'debug' },
  { name: 'list_test_call_records', scope: 'debug' },
  { name: 'get_test_call_record', scope: 'debug' },
  { name: 'clear_test_call_records', scope: 'debug' },
]

/** 按能力范围筛选清单，供 `listTools` 的按权限发现断言复用。 */
export function mcpToolCatalogueForScopes(scopes: readonly McpToolCatalogueEntry['scope'][]): McpToolCatalogueEntry[] {
  return MCP_TOOL_CATALOGUE.filter(({ scope }) => scopes.includes(scope))
}

/** 把携带能力范围的工具清单收敛成可与本文件清单直接比较的形状。 */
export function toMcpToolCatalogue(tools: readonly { name: string; scope: string }[]): McpToolCatalogueEntry[] {
  return tools.map(({ name, scope }) => ({ name, scope })) as McpToolCatalogueEntry[]
}

/** 完整工具名清单，供不携带能力范围的传输层 `tools/list` 断言使用。 */
export const MCP_TOOL_NAMES: string[] = MCP_TOOL_CATALOGUE.map(({ name }) => name)

/**
 * 只读资源的完整 URI 清单，按 `resources/list` 的返回顺序列出。
 *
 * 与工具清单同一个道理：三处此前只断言资源条数，而条数抓不到 URI 改名——资源 URI 是消费者唯一的
 * 寻址方式，改掉一个字就是断了一条对外契约。清单由测试侧独立书写，先改这里再改实现。
 */
export const MCP_RESOURCE_URIS: string[] = [
  'onebot-sandbox://guide',
  'onebot-sandbox://scene-schema',
  'onebot-sandbox://capabilities/napcat',
  'onebot-sandbox://capabilities/llbot',
  'onebot-sandbox://capabilities/snowluma',
  'onebot-sandbox://errors',
  'onebot-sandbox://events',
  'onebot-sandbox://examples',
]

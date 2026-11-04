# chatluna-plugin-onebot-sandbox

在 ChatLuna v2 的 WebUI 中提供模拟 QQ（OneBot v11）环境，用于验证 ChatLuna 及其插件在私聊、群聊中的真实行为。

## Config

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `persistenceMode` | `'memory' \| 'database'` | `'database'` | 模拟环境状态存储方式 |
| `sandboxTimBubbleTail` | `boolean` | `true` | 显示气泡小尖角 |
| `sandboxMarkRecalledMessages` | `boolean` | `true` | 保留撤回气泡并显示撤回线 |
| `modelRequestRecordLimit` | `number` | `500` | 每个空间保留的模型请求记录条数上限 |
| `modelRequestRecordMaxMegabytes` | `number` | `50` | 每个空间模型请求记录的体积上限（MB） |
| `sceneMessageLimit` | `number` | `2000` | 每个空间保留的场景消息条数上限 |
| `sceneMessageMaxBytes` | `number` | `8388608` | 每个空间场景 JSON 的字节上限 |
| `testEndpoint.mcp` | `{ enabled, path }` | `{ true, '/mcp' }` | MCP 测试端点 |
| `testEndpoint.http` | `{ enabled, path }` | `{ true, '/api' }` | HTTP 测试端点 |
| `testEndpoint.shared` | object | — | 监听地址、端口、来源与 Origin 白名单、TLS 与调用配额 |

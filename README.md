# chatluna-plugin-onebot-sandbox

在 ChatLuna v2 的 WebUI 中提供模拟 QQ（OneBot v11）环境，用于验证 ChatLuna 及其插件在私聊、群聊中的真实行为。

## Config

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `persistenceMode` | `'memory' \| 'database'` | `'database'` | 模拟环境状态存储方式 |
| `sandboxTimBubbleTail` | `boolean` | `true` | 显示气泡小尖角 |
| `sandboxMarkRecalledMessages` | `boolean` | `true` | 保留撤回气泡并显示撤回线 |
| `sceneMessageLimit` | `number` | `2000` | 每个空间保留的场景消息条数上限 |
| `sceneMessageMaxBytes` | `number` | `8388608` | 每个空间场景 JSON 的字节上限 |
| `testEndpoint.mcp` | `{ enabled, path }` | `{ false, '/mcp' }` | MCP 测试端点 |
| `testEndpoint.http` | `{ enabled, path }` | `{ false, '/api' }` | HTTP 测试端点 |
| `testEndpoint.shared` | object | — | 监听地址、端口、来源与 Origin 白名单、TLS 与调用配额 |

## 发布

推送 `v<版本号>` tag 后，GitHub Actions（`.github/workflows/publish.yml`）会通过 npm Trusted Publishing 发布到 npm，不使用 `NPM_TOKEN`。插件依赖的 `@chatluna/*` 只在 ChatLuna v2 仓库中，所以 CI 会先检出 v2，把插件放进 `external/onebot-sandbox`，再执行构建、测试，并用 `yarn pack` 打包后发布。

1. 修改 `package.json` 的 `version` 并提交。
2. 推送同名 tag：`git tag v1.0.1 && git push origin v1.0.1`。tag 与 `version` 不一致时，工作流会报错退出。

只想验证流程时，在 Actions 页面手动运行 Publish，工作流只会执行 `npm publish --dry-run`。

仓库需要提前配置：

- Secret `CHATLUNA_V2_TOKEN`：能读取 `ChatLunaLab/v2-mirror` 的 PAT，权限只需 Contents 只读。
- Variable `CHATLUNA_V2_REF`（可选）：检出 v2 的分支或提交，默认为 `cordis4`。
- npm 包页面的 Trusted Publisher：GitHub Actions，`Sor85` / `chatluna-plugin-onebot-sandbox` / `publish.yml`，Environment 留空。

## License

MIT

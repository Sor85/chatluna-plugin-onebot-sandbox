# AGENTS.md — chatluna-plugin-onebot-sandbox

ChatLuna v2 外部插件：在 WebUI 中提供模拟 QQ（OneBot v11）环境，用于验证 ChatLuna 及其插件的私聊、群聊行为。由 Koishi 插件 `koishi-plugin-chatluna-sandbox` 迁移而来，领域逻辑保持一致，接入层与界面按 ChatLuna v2 重写。

## 位置与依赖

- 本仓库（`chatluna/chatluna-v2-onebot-sandbox`）是插件的唯一源码，独立管理 git。`@chatluna/*` 目前未发布到 npm，只能在 ChatLuna v2 仓库（`chatluna-v2-mirror`）里以 workspace 成员 `external/onebot-sandbox` 的身份解析、构建和运行。
- 源码经 `scripts/sync-to-v2.mjs` 单向同步到 `external/onebot-sandbox`（`node scripts/sync-to-v2.mjs --once` 同步一次，`node scripts/sync-to-v2.mjs` 持续监听；本仓库没有安装依赖，用 node 直接运行，不经 yarn）。副本根目录下的 `node_modules`、`lib`、`dist`、`data` 只属于副本，同步既不覆盖也不删除；其余文件以本仓库为准，在副本里直接改会被下一次同步覆盖，所以只在本仓库里改。v2 仓库位置默认 `../../chatluna-v2-mirror`，可用 `CHATLUNA_V2_ROOT` 覆盖。
- 依赖范围：`@chatluna/*` 在 devDependencies 用 `workspace:*`，peerDependencies 用 `>=2.0.0-alpha.0`。
- 遵循 v2 外部插件规范，但不受 v2 仓库 lint（`verify-layout`/`verify-refs`/`verify-gates` 跳过 `external/`）约束；协议为 MIT。

## 目录

- `src/`：服务端。领域与场景（`control-service.ts`、`types.ts`）、虚拟 OneBot 机器人（`bot.ts`、`inbound-delivery.ts`）、持久化、AI 测试空间、MCP/HTTP 测试端点（`mcp/`）。
- `src/webui.ts`：把控制台契约（`console-contract.ts`）注册为 `chatluna_webui` 的 action；场景变更折叠成实时 state `onebot-sandbox.signal`，客户端收到信号后重读工作区。
- `src/settings.ts`：插件设置的读写（state `onebot-sandbox.settings`、action `onebot-sandbox.settings.save`），经 `chatluna_config.save` 写回 chatluna.yml 中本插件条目。
- `src/lifecycle.ts`：Cordis 4 没有 `ready`/`dispose` 事件，启动任务推迟到下一轮宏任务，收尾挂在 Fiber effect 上。
- `client/`：React 前端。`workspace/` 是状态（`store.ts`）与上下文，`chat/` 是 WebQQ 三栏，`environment/` 是实体编辑与环境管理页，`onebot-debug/`、`test-call/` 是两个记录工作台（共用 `records/record-layout.tsx`），`mcp/` 是测试凭证与能力目录，`settings/` 是插件设置页；`webqq/`、`model-request/` 等目录是从源插件原样移植的纯逻辑模块。
- `scripts/sync-to-v2.mjs`：把源码同步到 v2 开发仓库的副本。
- `tests/`：vitest。`helpers/app.ts` 是 Cordis 4 + Koishi 兼容层的测试宿主；`tests/phase2/` 是依赖 ChatLuna v1 内部实现、待按 v2 API 重写的用例，不在默认 include 中。

## 约定

- 服务端日志：Cordis 4 的 Logger 会把 Error 参数格式化成 `{}`，统一写成 `logger.error('%s\n%s', message, errorDetail(error))`（`src/error-detail.ts`）。
- 前端：组件取自 `@chatluna/ui-kit`，图标用 `lucide-react`，浏览器偏好经 `@chatluna/ui-storage` 读写；文案走 `client/locales/{zh,en}.yml`，键前缀 `sandbox.`。
- 路由（`client/index.ts`）不设 `fullscreen`：v2 的全屏路由脱离 shell 渲染，且不进入侧边栏导航（`packages/ui/client/client/plugins/nav.ts`）。沙盒作为普通页面嵌在 shell 里，根节点用 `h-full min-h-0` 撑满内容区。
- 插件设置在沙盒「设置」页编辑：`src/index.ts` 的 `Settings` 是完整 schema，交给 v2 插件页的 `Config` 是同一组字段全部标 hidden 的副本，插件页只显示一行指向沙盒设置页的标题；配置仍存在 chatluna.yml 的同一条目，loader 照常补默认值。新增配置项写进 `Settings`，`Config` 自动跟随。保存走 `chatluna_config.save`（带文件戳乐观锁），插件随即按新配置重启；实时信号带 `startedAt`，客户端据此识别重启并重读工作区。
- 预设与模型请求不在沙盒内实现：预设用 v2 自带的 `/presets` 页（沙盒导航不放入口）；模型请求用 v2 自带的 trace 页。
- 模型请求出处：`src/chatluna/state.ts` 订阅 `chat/receive` 建立「ChatLuna 会话 ID → 机器人 + 会话」映射，`chatluna/agent-step` 记下最近一步的 `turn`/`step`，机器人发消息时写进 `message.chatLuna.trace`，前端链接到 `/traces/<sessionId>?turn=&step=`。v2 回复经异步渲染队列发出，可能晚于 agent 转 idle，所以出处在发消息时标注而不是回合结束时回填；会话出现新的用户消息即清空，命令回复不沿用上一轮。
- 数据目录：`data/chatluna/onebot-sandbox`；数据库表名前缀 `onebot_sandbox_`；MCP 资源 URI 前缀 `onebot-sandbox://`。

## 命令

先在本仓库执行 `node scripts/sync-to-v2.mjs --once`（或保持监听模式运行），再在 v2 仓库执行：

- 构建（v2 根目录）：`yarn yakumo build onebot-sandbox`
- 测试（`external/onebot-sandbox` 目录）：`../../node_modules/.bin/vitest run`
- 类型检查（`external/onebot-sandbox` 目录）：`../../node_modules/.bin/tsc -p tsconfig.json --noEmit` 与 `-p tsconfig.client.json`
- 本仓库没有 `node_modules`，测试、类型检查与构建都不能直接在这里跑：tsc 和 vitest 按文件真实路径向上找依赖，只有放在 v2 仓库里才能找到。

## 迁移进度

- 已完成：场景/机器人/投递/持久化/测试空间/MCP 与 HTTP 端点的服务端；WebQQ 聊天界面（会话树、消息、发送框、搜索、多选转发、表情回应、群公告、资料卡、实体编辑）；OneBot 调试、测试调用、环境管理（目录、测试凭证、MCP/HTTP 能力目录）、插件设置页面；等待态、用量与模型请求出处接 v2 agent 事件与 trace 页。
- 待完成：唤醒规则改读 v2 activation decider；AI 测试空间工作区的 React 界面；`tests/phase2/` 按 v2 重写；测试宿主的定时器清理泄漏（vitest 报 370 个未处理错误，用例本身通过）。

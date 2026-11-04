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
- `client/`：React 前端。`workspace/` 是状态（`store.ts`）与上下文，`chat/` 是 WebQQ 三栏，`environment/` 是实体编辑与环境管理页，`onebot-debug/`、`test-call/` 是两个记录工作台（共用 `records/record-layout.tsx`），`mcp/` 是测试凭证与能力目录，`settings/` 是插件设置页，`test-space/` 是 AI 测试空间（总览、缩略图、被控覆盖层）；`webqq/`、`model-request/` 等目录是从源插件原样移植的纯逻辑模块。
- `scripts/sync-to-v2.mjs`：把源码同步到 v2 开发仓库的副本。
- `tests/`：vitest。`helpers/app.ts` 是 Cordis 4 + Koishi 兼容层的测试宿主；`tests/phase2/` 是依赖 ChatLuna v1 内部实现、待按 v2 API 重写的用例，不在默认 include 中。

## 约定

- 服务端日志：Cordis 4 的 Logger 会把 Error 参数格式化成 `{}`，统一写成 `logger.error('%s\n%s', message, errorDetail(error))`（`src/error-detail.ts`）。
- 前端：组件取自 `@chatluna/ui-kit`，图标用 `lucide-react`，浏览器偏好经 `@chatluna/ui-storage` 读写；文案走 `client/locales/{zh,en}.yml`，键前缀 `sandbox.`，两份文件按键名排序。`client/webqq/` 等纯逻辑模块不写界面文案：要么返回文案键（`relationship-directory.ts` 的 `statusKey`），要么由调用方传入 `t`（`profile-card.ts`、`conversation-tree.ts` 的 `emptyPreview`）；与服务端生成的消息内容逐字比较的模拟文本（`[图片] 名称`、「群聊的聊天记录」）属于消息内容，不翻译。宿主的 `t` 引用不随语言切换变化，`client/i18n.ts` 的 `useT` 按语言快照换引用，`useMemo`/`useCallback` 把 `t` 写进依赖即可跟随切换。store 与 `invoke` 不在 React 树里，错误兜底文案经 `bindStoreTranslator`（`app.tsx` 每次渲染登记）翻译。服务端把主环境来源名写成中文，界面一律经 `sourceName(t, source)` 显示。`type="search"` 的输入框加 `sandbox-search-input`（去掉 Chrome 独有的原生清除按钮），窄屏横向滑动的标签条加 `sandbox-scroll-strip`，规则在 `shared/controls.css`。
- 覆盖 ui-kit 组件自带的工具类：v2 把插件不带变体的工具类编进 `@layer utilities.plugin` 子层（`packages/ui/client/src/index.ts` 的 `utilities()`），优先级低于宿主直接在 `utilities` 层的同名类，ui-kit 组件经 `cn`（tailwind-merge）合并 className，同组且都不带变体的冲突（`h-[30px]` 与 `h-8`）在运行时已去重，不受影响；去不掉、会输掉层级的是两类：简写与长写混用（组件 `px-2.5`、插件 `pl-8`），以及组件基础类带变体（`Input` 的 `md:text-[13px]` 盖过插件的 `text-xs`）。这两类用 important 写法（`pl-8!`、`text-xs!`）。另外，v2 开发服务器只在模块首次加载时扫描类名，新增类名后要重启 `yarn dev` 才会生成。
- 发送框（`client/chat/composer.tsx` + `composer.css`）逐条对齐源插件：悬浮胶囊、头像堆叠的折叠与展开用 CSS 变量驱动的过渡，切换发送者的重排用 `animejs`（与源插件同为 4.5.0）的 `createLayout` FLIP，在 `useLayoutEffect` 里于新顺序提交后补间。几何常量在 `client/webqq/user-stack.ts`，与 CSS 里的 36/21/27px 一一对应；原版主题变量映射到 v2 token。折叠的头像只能用透明度隐藏，`display`/`visibility` 会让 FLIP 把它当作进出元素。
- 消息列表（`client/chat/message-list.tsx` + `messages.css`）同样逐条移植源插件的 `messages.css`：类名前缀 `sandbox-message-`，连续气泡的 3px 圆角按 `webqq/message-cluster.ts` 的 `is-cluster-*` 类收角，小尖角是列表根 `.has-tail`（设置 `sandboxTimBubbleTail`）下气泡的 `::before`，复用气泡背景。对方气泡默认是源插件的半透明白底加投影，设置 `sandboxIncomingBubbleStyle = outline` 时列表根加 `.has-outline`，亮色主题下改为白底细描边；border 包不到尖角，描边样式的尖角改画内联 SVG，SVG 里的颜色是字面值，与 border 色同步修改。气泡几何不要改回 Tailwind 工具类，尖角与收角都依赖这些类名的选择器。
- 毛玻璃：数值取自源插件雾化态，统一写在 `client/shared/glass.css`（未分层，压过 ui-kit 的 `bg-popover`）。沙盒内的 ui-kit 非模态浮层（`PopoverContent`、`ContextMenuContent`、`ContextMenuSubContent`、`SelectContent`，以及资料卡、@ 提及列表）一律加 `sandbox-glass` 类；模态窗口（`DialogContent`、`AlertDialogContent`）不加，保持 ui-kit 的实心底，窗口里的下拉选单仍是玻璃浮层；它们经 Portal 挂到 body，不在全局 `data-slot` 上写规则，免得波及 v2 宿主的其他页面。消息页的页头（`.sandbox-page-header`）和聊天标题栏两层毛玻璃对应源插件的顶栏与聊天表头：聊天列按 `app.tsx` 测得的页头高度（`.sandbox-stage` 上的 `--sandbox-page-header-height`）上移，消息区再上移标题栏的 56px，滚动视口补回两者之和，消息从两层表头后面滚过；改标题栏高度要同步。`.sandbox-stage` 因此不带 `overflow-hidden`，缩放动画（`test-space/zoom.ts`）只在动画期间内联裁剪。工作区与一级区域不能带 filter、backdrop-filter、opacity<1、mask、clip-path、will-change，否则里面的模糊全部失效。玻璃浮层里 ui-kit 自带的实心底（控件底色 `--control`、Tabs、Select 滚动箭头）都在 `glass.css` 改成半透明。对话框一律三段式（`DialogContent` 加 `flex flex-col overflow-hidden`，正文容器 `-mx-5 min-h-0 overflow-y-auto px-5`），视口再矮也只有正文滚动，页头页脚不被内容滚过。消息区视口从两层表头后面开始，原生滚动条隐藏，改由 `shared/overlay-scrollbar.tsx` 画在表头下方。
- 弹窗（遵循全局 MODAL.md 中插件能做到的部分；层叠缩放与页面虚化属于 ui-kit 宿主）：二级窗口（头像选择、嵌套合并转发）是叠在上层之上的独立 `Dialog`，以 React 子树嵌套在上层的 `DialogContent` 里，Esc 与点遮罩只关最上层，右上角只放关闭按钮、不在左上角放返回；有未保存修改的表单经 `shared/discard-confirm.tsx` 先确认放弃，确认框同样渲染在 `DialogContent` 里；按需打开的弹窗关闭时数据立即清空，用 `shared/use-retained.ts` 保留最后一份内容播完退场动画。
- WebQQ 三栏按沙盒自身宽度分档（`chat/webqq-view.tsx`，ResizeObserver），不看视口：左侧还有 v2 外壳侧栏，按视口判断会让聊天区窄到放不下发送框。发送框的右缘 `max(48px, calc(50% - 230px))` 与 `max-width: calc(100% - 96px)` 成对，改一个要同步另一个。
- 强调色：WebQQ 不跟随 v2 主题的 `--primary`，取插件设置 `sandboxAccentColor`（默认与源插件同为 `#2563eb`），由 `webqq-view.tsx` 写成根节点 `.sandbox-webqq` 上的 `--sandbox-accent`，消息与发送框的样式都从它继承。
- 路由（`client/index.ts`）不设 `fullscreen`：v2 的全屏路由脱离 shell 渲染，且不进入侧边栏导航（`packages/ui/client/client/plugins/nav.ts`）。沙盒作为普通页面嵌在 shell 里，根节点用 `h-full min-h-0` 撑满内容区。
- 页头（`client/app.tsx`）沿用 v2 页面版式（参照 `packages/provider/webui/client/providers.tsx`）：标题「OneBot 沙盒」与 ui-kit 的 `Tabs` 分段标签压在同一行（`py-3`），把高度留给工作区；标签值与路由 `/onebot-sandbox/:view` 同步。标签已给出页名，各工作区不再放自己的 h1，只留说明与操作，左右边距与页头同为 `px-6`。
- AI 测试空间：`?space=<id>` 让消息工作区定域到该空间，`app.tsx` 按空间缓存 `WorkspaceStore`，进入前先读好目标 store，工作区首帧就能接住 `test-space/zoom.ts` 的缩放动画。入口与源插件一样是钉在页头右端的图标按钮，不进分段标签，图标随 `signal.mcpRunning`（MCP 服务器活动）转动；空间内部的分段标签只剩「消息」，从其他标签进入一律落在主环境。空间状态不经实时信号推送，`use-space-list.ts` 每 1.5 秒轮询，只在空间、状态或快照修订号变化时替换列表。总览缩略图优先用离开空间时克隆的真实画面（`thumbnail-capture.ts`），没进入过的空间用 `WorkspaceStore.seed` 按快照填充只读 store 渲染 `WebqqView`；`seed` 不回写本地选择。覆盖层类名 `.sandbox-agent-observe` 是克隆时剔除的依据，改名要同步。
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

- 已完成：场景/机器人/投递/持久化/测试空间/MCP 与 HTTP 端点的服务端；WebQQ 聊天界面（会话树、消息、发送框、搜索、多选转发、表情回应、群公告、资料卡、实体编辑）；OneBot 调试、测试调用、环境管理（目录、测试凭证、MCP/HTTP 能力目录）、插件设置页面；AI 测试空间（总览、缩略图、进出缩放、被控覆盖层与任务栏）；等待态、用量与模型请求出处接 v2 agent 事件与 trace 页。
- 待完成：唤醒规则改读 v2 activation decider；`tests/phase2/` 按 v2 重写；测试宿主的定时器清理泄漏（vitest 报 370 个未处理错误，用例本身通过）。

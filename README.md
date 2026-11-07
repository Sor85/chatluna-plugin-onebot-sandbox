# chatluna-plugin-onebot-sandbox

[![npm](https://img.shields.io/npm/v/chatluna-plugin-onebot-sandbox)](https://www.npmjs.com/package/chatluna-plugin-onebot-sandbox)

ChatLuna v2 插件：在 WebUI 中模拟 QQ（OneBot v11）环境，不接入真实 QQ 账号即可测试 ChatLuna 及其插件在私聊、群聊中的行为。

## 功能

- **WebQQ 聊天界面**：会话列表、消息气泡、发送框、合并转发、表情回应、群公告与资料卡，可切换任意测试用户的身份发言。
- **模拟环境管理**：增删改普通用户、机器人与群组，机器人可选 NapCat、LLBot、SnowLuma 三种 OneBot 实现的能力基线。
- **OneBot 调试**：记录机器人发出的每个 action 及其参数与返回值。
- **AI 测试空间**：相互隔离的独立场景，可供 AI 通过 MCP 自行操作与观察。
- **测试端点**：提供 MCP 与 HTTP 两种接口，带凭证与调用配额，供自动化脚本驱动沙盒；默认关闭。
- **回复出处**：机器人的回复可跳转到 ChatLuna 的 trace 页，查看对应的模型请求。
- **模型调用与测试预设**：测试端点可读取机器人每一步模型调用的请求与响应，新建与修改测试用预设，并把沙盒机器人切换到指定预设；已有预设只有在设置中列为可编辑的才能修改。

## 安装

在 ChatLuna v2 的插件市场搜索 `onebot-sandbox` 安装，或在项目目录执行：

```sh
yarn add chatluna-plugin-onebot-sandbox
```

启用插件后，WebUI 侧边栏出现「OneBot 沙盒」页面。插件设置在沙盒的「设置」页中修改。

## License

MIT

import { errorDetail } from './error-detail'
import { onDispose, onStart } from './lifecycle'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@chatluna/ui-server'
import type {} from '@cordisjs/plugin-database'
import { resolveBaseDir } from './base-dir'
import { createWebuiRegistrar } from './webui'
import { registerConsole } from './console'
import { registerSettings } from './settings'
import {
  DEFAULT_SCENE_MESSAGE_LIMIT,
  DEFAULT_SCENE_MESSAGE_MAX_BYTES,
  SandboxControlService,
  SandboxRuntimeBotRegistry,
} from './control-service'
import {
  KoishiDatabaseOneBotDebugPersistence,
  KoishiDatabaseScenePersistence,
  KoishiDatabaseTestSpacePersistence,
  MemoryOneBotDebugPersistence,
  registerSandboxOneBotDebugModel,
  registerSandboxSceneModel,
  registerSandboxTestSpaceModel,
} from './persistence'
import type { SandboxOneBotDebugPersistence } from './onebot-debug'
import { SandboxTestEndpointServer, type SandboxTestEndpointProtocolConfig, type SandboxTestEndpointServerConfig } from './mcp/server'
import { describeHttpApiCapabilities, toHttpApiBaseUrl, type SandboxHttpApiCapabilityCatalog } from './mcp/http-api'
import { SandboxMcpService, type SandboxMcpQuotaConfig } from './mcp/service'
import type { SandboxMcpEndpointDescription } from './mcp/types'
import { SandboxTestSpaceService } from './test-spaces'
import { registerSandboxBotTools, type SandboxBotToolsConfig } from './chatluna/tools'
import { createScopeDirectory } from './scope-directory'
import { resolve } from 'node:path'
import type { SandboxAppearance, SandboxPersistenceMode } from './types'

export * from './control-service'
export * from './persistence'
export * from './record-store'
export * from './onebot-debug'
export * from './types'
export * from './mcp/server'
export * from './mcp/http-api'
export * from './mcp/service'
export * from './mcp/types'
export * from './test-spaces'

export const name = 'chatluna-onebot-sandbox'

/** database 是可选服务：内存模式不需要它，数据库模式在它就绪时注册表并延迟读取。 */
export const inject = ['satori', 'chatluna_webui']

/**
 * 端点通用设置：监听、门禁与配额。
 *
 * 单独成组是为了不让人误读：同一个监听器按路径分流，监听地址、端口、访问限制与配额对 MCP 与 HTTP
 * 两个端点同时生效，配额共用同一份额度更是安全属性（换个端点绕不开限流）。留在 `testEndpoint` 顶层
 * 会在设置页上落进某个端点的小节里，读起来像只对那个端点生效。
 */
export interface SandboxTestEndpointSharedConfig extends SandboxMcpQuotaConfig {
  host: string
  port: number
  allowedSources: string[]
  allowedOrigins: string[]
  tlsCertPath?: string
  tlsKeyPath?: string
}

/** 用户可见的测试控制端点配置：两个端点各自的开关与路径 + 共用的监听、门禁与配额。 */
export interface SandboxTestEndpointConfig {
  mcp: SandboxTestEndpointProtocolConfig
  http: SandboxTestEndpointProtocolConfig
  shared: SandboxTestEndpointSharedConfig
}

export interface Config extends SandboxAppearance {
  persistenceMode: SandboxPersistenceMode
  sceneMessageLimit: number
  sceneMessageMaxBytes: number
  testEndpoint: SandboxTestEndpointConfig
  botTools: SandboxBotToolsConfig
}

/**
 * 两个端点的配置形状相同，只有默认路径与文案不同；分组标题由调用方补上。
 */
const protocolSchema = (path: string, pathLabel: string, pathDescription: string): Schema<SandboxTestEndpointProtocolConfig> => Schema.object({
  enabled: Schema.boolean().default(true).extra('label', '启用'),
  path: Schema.string().default(path).extra('label', pathLabel).description(pathDescription),
})

/**
 * 设置页按分区渲染：`Settings` 是若干顶层分区的 intersect，每个分区的 `label` 是导航与面板标题，
 * `description` 是面板说明（`client/settings/page.tsx`）。分区内部的 `.description()` 照常渲染成小节标题。
 *
 * 分区只是页面结构，配置键仍是平铺的顶层字段。intersect 对同名键只做浅合并，所以同一个顶层键
 * 只能放在一个分区里：测试端点整体是一个分区，内部再按端点、监听、配额与工具调用分小节。
 */
const appearanceFields = {
  sandboxAccentColor: Schema.string().default('#2563eb').role('color').extra('label', '强调色')
    .description('己方气泡、发送框与选中态使用的颜色，不跟随 ChatLuna 主题色'),
  sandboxTimBubbleTail: Schema.boolean().default(true).extra('label', '气泡尖角')
    .description('在消息气泡靠近头像的一侧显示小尖角'),
  sandboxIncomingBubbleStyle: Schema.union([
    Schema.const('shadow').description('投影'),
    Schema.const('outline').description('描边'),
  ]).default('shadow').role('radio').extra('label', '对方气泡样式')
    .description('投影为半透明白底加阴影，描边为白底加细边框；仅在亮色主题下生效'),
  sandboxMarkRecalledMessages: Schema.boolean().default(true).extra('label', '保留撤回的消息')
    .description('开启时保留被撤回的气泡并加撤回线，关闭时只显示撤回提示；不影响存储的数据'),
}

const storageModeFields = {
  persistenceMode: Schema.union([
    Schema.const('database').description('数据库'),
    Schema.const('memory').description('服务端内存'),
  ]).default('database').role('radio').extra('label', '存储方式')
    .description('数据库模式在重启后保留；内存模式在进程退出后清空'),
}

const sceneMessageFields = {
  sceneMessageLimit: Schema.number().min(1).default(DEFAULT_SCENE_MESSAGE_LIMIT).extra('label', '条数上限')
    .description('超出后从最旧的消息开始丢弃，丢弃后不可恢复'),
  sceneMessageMaxBytes: Schema.number().min(64 * 1024).default(DEFAULT_SCENE_MESSAGE_MAX_BYTES).extra('label', '体积上限（字节）')
    .description('单个空间场景 JSON 的大小上限，超出后同样从最旧的消息开始丢弃'),
}

const endpointListenFields = {
  host: Schema.string().default('127.0.0.1').extra('label', '监听地址')
    .description('`127.0.0.1`仅本机可访问，`0.0.0.0`允许局域网访问；监听非本机地址时建议配置 TLS，否则测试凭证以明文传输'),
  port: Schema.number().min(1).max(65535).default(61901).extra('label', '端口')
    .description('端口被占用时端点启动失败，沙盒工作台不受影响'),
  allowedSources: Schema.array(String).default([]).extra('label', '来源 IP 白名单')
    .description('在监听地址之外再按来源 IP 筛选，支持精确 IP 与 CIDR（如`192.168.1.0/24`）；留空不筛选'),
  allowedOrigins: Schema.array(String).default([]).extra('label', '浏览器 Origin 白名单')
    .description('写全协议与端口，如`http://localhost:5173`；留空时拒绝所有浏览器请求。curl 与 AI 客户端不带 Origin，不受此项限制'),
  tlsCertPath: Schema.string().extra('label', 'TLS 证书路径').description('证书与私钥都填写后以 HTTPS 提供服务'),
  tlsKeyPath: Schema.string().extra('label', 'TLS 私钥路径'),
}

// 依 ADR-0025，配额只能由插件全局配置调整；两个端点共用一份额度，换个端点绕不开限流。
const endpointQuotaFields = {
  readPerMinute: Schema.number().min(1).default(120).extra('label', '每分钟读取调用'),
  mutationPerMinute: Schema.number().min(1).default(60).extra('label', '每分钟变更调用'),
  waitPerMinute: Schema.number().min(1).default(120).extra('label', '每分钟等待调用'),
  uploadPerMinute: Schema.number().min(1).default(30).extra('label', '每分钟媒体上传'),
  maxConcurrentMutations: Schema.number().min(1).default(4).extra('label', '同时进行的变更调用'),
  maxConcurrentWaits: Schema.number().min(1).default(8).extra('label', '同时进行的等待调用'),
  maxConcurrentUploads: Schema.number().min(1).default(2).extra('label', '同时进行的媒体上传'),
}

const endpointFields = {
  testEndpoint: Schema.object({
    mcp: protocolSchema('/mcp', '路径', '按完整路径精确匹配。AI 客户端填写`http://<监听地址>:<端口><路径>`').description('MCP 端点'),
    http: protocolSchema('/api', '路径前缀', '前缀为`/api`时，`/api/v1/tools`列出工具，`/api/v1/tools/<工具名>`调用工具，`/api/v1/resources`读取只读资源').description('HTTP 端点'),
    shared: Schema.intersect([
      Schema.object(endpointListenFields).extra('i18n', 'group.endpointListen').description('监听与访问'),
      Schema.object(endpointQuotaFields).extra('i18n', 'group.endpointQuota').description('调用配额').collapse(),
    ]) as Schema<SandboxTestEndpointSharedConfig>,
  }),
}

// 工具调用是同一组工具的第三种表述，因此放进测试端点分区，排在调用配额之后；配置键仍在顶层，
// 它不经监听器，放进 `testEndpoint` 会读成受端点开关与监听地址约束。
const botToolFields = {
  botTools: Schema.object({
    enabled: Schema.boolean().default(false).extra('label', '启用')
      .description('把测试端点的工具以`sandbox_`前缀注册到 ChatLuna'),
    scopes: Schema.array(Schema.union([
      Schema.const('read').description('读取'),
      Schema.const('interact').description('交互'),
      Schema.const('manage').description('环境管理'),
      Schema.const('debug').description('调试'),
    ])).default(['read', 'interact']).role('checkbox').extra('label', '权限范围')
      .description('只注册所选范围内的工具，含义与测试凭证的权限范围相同；修改操作同样只能作用于 AI 测试空间'),
  }).description('工具调用'),
}

/**
 * 插件设置的完整 schema，由沙盒工作台的「设置」页渲染（`src/settings.ts`）。
 *
 * 这里的中文是兜底原文，设置页按当前语言换成 `client/locales` 里 `sandbox.settings.schema.` 下的文案
 * （`client/settings/localize.ts`）：字段按配置路径取键，分区与小节没有自己的配置键，用 `extra('i18n')` 起名。
 * 改动文案或字段时两份语言文件要一起改（`tests/settings-locale.test.ts`）。
 */
export const Settings = Schema.intersect([
  Schema.object(appearanceFields).extra('i18n', 'group.appearance').extra('label', '外观')
    .description('WebQQ 界面的颜色与气泡样式，只影响沙盒内的展示'),
  Schema.intersect([
    Schema.object(storageModeFields),
    Schema.object(sceneMessageFields).extra('i18n', 'group.sceneMessages').description('场景消息'),
  ]).extra('i18n', 'group.storage').extra('label', '数据存储')
    .description('模拟环境的保存位置，以及消息的保留上限。上限按主环境与每个 AI 测试空间分别计算'),
  Schema.object({ ...endpointFields, ...botToolFields }).extra('i18n', 'group.endpoint').extra('label', '测试端点')
    .description('供 AI 客户端操控沙盒的 MCP 与 HTTP 接口，同一组工具也可以交给 ChatLuna 机器人调用。两个端点共用监听器、访问限制与调用配额，配额按测试凭证分别计数，超出返回 429'),
]) as unknown as Schema<Config>

/**
 * 交给 v2 插件页的 schema：字段与`Settings`相同但全部标 hidden，插件页只剩一行指向沙盒设置页的标题。
 * 配置仍存在 chatluna.yml 的同一条插件条目里，loader 照常按它补默认值、传给`apply`。
 */
export const Config = Schema.object(
  Object.fromEntries(
    Object.entries({ ...appearanceFields, ...storageModeFields, ...sceneMessageFields, ...endpointFields, ...botToolFields })
      .map(([key, field]) => [key, (field as Schema).hidden()]),
  ),
).description('设置在 OneBot 沙盒工作台的「设置」页编辑') as unknown as Schema<Config>

declare global {
  namespace Schemastery {
    interface Meta {
      /** 设置页的文案 ID（`client/settings/localize.ts`），只给没有配置键的分区与小节起名。 */
      i18n?: string
    }
  }
}

declare module 'cordis' {
  interface Context {
    onebot_sandbox: SandboxControlService
  }
}

export function apply(ctx: Context, config: Config) {
  const baseDir = resolveBaseDir(ctx)
  const getDatabase = () => ctx.get('database')
  let persistence: KoishiDatabaseScenePersistence | undefined
  let createDebugPersistence: (scopeId: string) => SandboxOneBotDebugPersistence
  if (config.persistenceMode === 'database') {
    // database 可能晚于本插件就绪；表在服务出现时注册，读写一律经 getter 现取。
    ctx.inject(['database'], (inner) => {
      registerSandboxSceneModel(inner)
      registerSandboxTestSpaceModel(inner)
      registerSandboxOneBotDebugModel(inner)
    })
    persistence = new KoishiDatabaseScenePersistence(getDatabase)
    createDebugPersistence = (scopeId) => new KoishiDatabaseOneBotDebugPersistence(scopeId, getDatabase)
  } else {
    // 内存 Adapter 与数据库 Adapter 共用同一 Interface；进程内跨控制服务实例可恢复，进程退出后不保留。
    const memoryDebug = new Map<string, MemoryOneBotDebugPersistence>()
    createDebugPersistence = (scopeId) => {
      const existing = memoryDebug.get(scopeId)
      if (existing) return existing
      const created = new MemoryOneBotDebugPersistence(scopeId)
      memoryDebug.set(scopeId, created)
      return created
    }
  }
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(ctx, {
    persistence,
    runtimeBots,
    debugPersistence: createDebugPersistence('main'),
    sceneMessageLimit: config.sceneMessageLimit,
    sceneMessageMaxBytes: config.sceneMessageMaxBytes,
  })
  const testSpaces = new SandboxTestSpaceService(
    ctx,
    runtimeBots,
    config.persistenceMode === 'database' ? new KoishiDatabaseTestSpacePersistence(getDatabase) : undefined,
    createDebugPersistence,
    {
      sceneMessageLimit: config.sceneMessageLimit,
      sceneMessageMaxBytes: config.sceneMessageMaxBytes,
    },
  )
  ctx.provide('onebot_sandbox', control)
  /**
   * 端点可用性是一个可空值，而不是两条各自装配一遍的代码路径：MCP 服务、监听器与 HTTP 表述自述
   * 要么一起有要么一起没有。构造失败的唯一实际来源是建数据目录或读凭证文件，失败时沙盒工作台照常可用。
   */
  let endpoint: {
    mcp: SandboxMcpService
    server: SandboxTestEndpointServer
    httpApi: SandboxHttpApiCapabilityCatalog
    mcpEndpoint: SandboxMcpEndpointDescription
  } | undefined
  try {
    const mcp = new SandboxMcpService(ctx, control, {
      dataDirectory: resolve(baseDir, 'data/chatluna/onebot-sandbox'),
      readPerMinute: config.testEndpoint.shared.readPerMinute,
      mutationPerMinute: config.testEndpoint.shared.mutationPerMinute,
      waitPerMinute: config.testEndpoint.shared.waitPerMinute,
      uploadPerMinute: config.testEndpoint.shared.uploadPerMinute,
      maxConcurrentMutations: config.testEndpoint.shared.maxConcurrentMutations,
      maxConcurrentWaits: config.testEndpoint.shared.maxConcurrentWaits,
      maxConcurrentUploads: config.testEndpoint.shared.maxConcurrentUploads,
      testSpaces,
    })
    const server = new SandboxTestEndpointServer(ctx, mcp, {
      host: config.testEndpoint.shared.host,
      port: config.testEndpoint.shared.port,
      allowedSources: config.testEndpoint.shared.allowedSources,
      allowedOrigins: config.testEndpoint.shared.allowedOrigins,
      tlsCertPath: config.testEndpoint.shared.tlsCertPath,
      tlsKeyPath: config.testEndpoint.shared.tlsKeyPath,
      mcp: config.testEndpoint.mcp,
      http: config.testEndpoint.http,
    })
    endpoint = {
      mcp,
      server,
      // 自述与监听器读同一份配置，HTTP 能力页不会与实际生效的路径、基址和开关漂移。
      httpApi: describeHttpApiCapabilities({
        enabled: config.testEndpoint.http.enabled,
        path: config.testEndpoint.http.path,
        host: config.testEndpoint.shared.host,
        port: config.testEndpoint.shared.port,
        tls: Boolean(config.testEndpoint.shared.tlsCertPath && config.testEndpoint.shared.tlsKeyPath),
      }),
      mcpEndpoint: {
        enabled: config.testEndpoint.mcp.enabled,
        url: `${toHttpApiBaseUrl({
          host: config.testEndpoint.shared.host,
          port: config.testEndpoint.shared.port,
          tls: Boolean(config.testEndpoint.shared.tlsCertPath && config.testEndpoint.shared.tlsKeyPath),
        })}${config.testEndpoint.mcp.path}`,
      },
    }
  } catch (error) {
    ctx.logger.error('%s\n%s', 'test endpoint init failed; the workspace stays available', errorDetail(error))
  }
  if (endpoint) registerSandboxBotTools(ctx, endpoint.mcp, config.botTools)
  const appearance: SandboxAppearance = {
    sandboxTimBubbleTail: config.sandboxTimBubbleTail,
    sandboxIncomingBubbleStyle: config.sandboxIncomingBubbleStyle,
    sandboxAccentColor: config.sandboxAccentColor,
    sandboxMarkRecalledMessages: config.sandboxMarkRecalledMessages,
  }
  registerConsole(createWebuiRegistrar(ctx), control, appearance, endpoint, testSpaces)
  registerSettings(ctx, Settings, 'chatluna-plugin-onebot-sandbox')
  onStart(ctx, async () => {
    await control.waitForSceneReady()
    await endpoint?.server.start().catch((error) => ctx.logger.error('%s\n%s', 'test endpoint listener failed to start', errorDetail(error)))
  })
  onDispose(ctx, () => {
    endpoint?.server.stop()
  })
}

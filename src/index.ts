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
  KoishiDatabaseModelRequestPersistence,
  KoishiDatabaseOneBotDebugPersistence,
  KoishiDatabaseScenePersistence,
  KoishiDatabaseTestSpacePersistence,
  MemoryModelRequestPersistence,
  MemoryOneBotDebugPersistence,
  registerSandboxModelRequestModel,
  registerSandboxOneBotDebugModel,
  registerSandboxSceneModel,
  registerSandboxTestSpaceModel,
} from './persistence'
import type { SandboxOneBotDebugPersistence } from './onebot-debug'
import { DEFAULT_MODEL_REQUEST_RECORD_MAX_BYTES, MAIN_MODEL_REQUEST_SCOPE_ID, SandboxModelRequestStore, UNATTRIBUTED_MODEL_REQUEST_SCOPE_ID, type SandboxModelRequestPersistence } from './model-request'
import { SandboxTestEndpointServer, type SandboxTestEndpointProtocolConfig, type SandboxTestEndpointServerConfig } from './mcp/server'
import { describeHttpApiCapabilities, type SandboxHttpApiCapabilityCatalog } from './mcp/http-api'
import { SandboxMcpService, type SandboxMcpQuotaConfig } from './mcp/service'
import { SandboxTestSpaceService } from './test-spaces'
import { createScopeDirectory } from './scope-directory'
import { resolve } from 'node:path'
import type { SandboxAppearance, SandboxPersistenceMode } from './types'

export * from './control-service'
export * from './persistence'
export * from './record-store'
export * from './onebot-debug'
export * from './model-request'
export * from './model-request-collector'
export * from './model-request-error-preview'
export * from './chatluna/character-turn-completion'
export * from './chatluna/error'
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
 * 单独成组不是为了代码结构，而是为了配置页：Koishi 按声明顺序把嵌套分组渲染成 h2，紧跟其后的散字段
 * 会挂在上一个 h2 下面。这些字段如果留在 `testEndpoint` 顶层，就会视觉上落进「HTTP 测试端点」标题
 * 里，读起来像是只对 HTTP 生效——而它们对两个端点同时生效。监听地址与端口同样是两个端点共用的一份
 * （同一个监听器按路径分流），配额共用同一份额度更是安全属性（换个端点绕不开限流），都不能让人误读。
 * 依 ADR-0025，配额只能由插件全局配置调整。
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
  modelRequestRecordLimit: number
  modelRequestRecordMaxMegabytes: number
  testEndpoint: SandboxTestEndpointConfig
}

/** 字节上限以 MB 暴露给配置页；内部仍按字节比较，换算只发生在这一处。 */
const MEGABYTE = 1024 * 1024
const DEFAULT_MODEL_REQUEST_RECORD_MAX_MEGABYTES = DEFAULT_MODEL_REQUEST_RECORD_MAX_BYTES / MEGABYTE

/**
 * 两个端点的配置形状相同，只有默认路径与文案不同；分组标题由调用方补上。
 *
 * 配置页把分组的 `.description()` 渲染成标题、把字段的 `.description()` 渲染成字段说明，因此标题
 * 只写端点名，「这个端点是干什么的、开关控制什么」全部落在字段说明里。
 */
const protocolSchema = (path: string, enabledDescription: string, pathDescription: string): Schema<SandboxTestEndpointProtocolConfig> => Schema.object({
  enabled: Schema.boolean().default(true).description(enabledDescription),
  path: Schema.string().default(path).description(pathDescription),
})

/**
 * 插件设置的完整 schema，由沙盒工作台的「设置」页渲染（`src/settings.ts`）。
 *
 * 不写根 description：设置页自带标题，根 description 会在表单顶部多渲染一个同名分组标题。
 */
export const Settings: Schema<Config> = Schema.object({
  persistenceMode: Schema.union([
    Schema.const('memory').description('服务端内存'),
    Schema.const('database').description('数据库'),
  ]).default('database').role('radio').description('模拟 QQ 环境状态存储方式'),
  sandboxTimBubbleTail: Schema.boolean().default(true).description('显示气泡小尖角'),
  sandboxMarkRecalledMessages: Schema.boolean().default(true).description('仅影响 Sandbox 展示：开启时保留撤回气泡并显示撤回线，关闭时只显示撤回事件'),
  modelRequestRecordLimit: Schema.number().min(1).step(1).default(500)
    .description('每个空间保留的模型请求记录条数上限。超出后从最旧记录开始丢弃，与体积上限同时生效'),
  modelRequestRecordMaxMegabytes: Schema.number().min(1).step(1).default(DEFAULT_MODEL_REQUEST_RECORD_MAX_MEGABYTES)
    .description('每个空间模型请求记录的体积上限（MB）。超出后从最旧记录开始丢弃，与条数上限同时生效。单条记录含完整请求体与响应原文，长上下文请求可达数百 KB'),
  sceneMessageLimit: Schema.number().min(1).default(DEFAULT_SCENE_MESSAGE_LIMIT)
    .description('每个空间保留的场景消息条数上限；主环境与每个 AI 测试空间各自独立，超出后从最旧消息开始丢弃，被丢弃的历史消息不可恢复'),
  sceneMessageMaxBytes: Schema.number().min(64 * 1024).default(DEFAULT_SCENE_MESSAGE_MAX_BYTES)
    .description('每个空间场景 JSON 的字节上限；达到后继续从最旧消息开始丢弃，被丢弃的历史消息不可恢复'),
  testEndpoint: Schema.object({
    mcp: protocolSchema(
      '/mcp',
      '是否开启 MCP',
      '该端点的请求路径，按完整路径精确匹配。AI 客户端里要填的地址是`http://<监听地址>:<端口><该路径>`',
    ).description('MCP 测试端点'),
    http: protocolSchema(
      '/api',
      '是否开启 HTTP',
      '该端点的路径前缀。填`/api`时可用的地址是`/api/v1/tools`看工具清单、`/api/v1/tools/<工具名>`调用工具、`/api/v1/resources`读只读资源',
    ).description('HTTP 测试端点'),
    // 声明顺序即渲染顺序：这一组必须排在 mcp / http 之后，否则它的字段会挂到别的标题下面。
    shared: Schema.object({
      host: Schema.string().default('127.0.0.1').description('监听地址。`127.0.0.1`只允许本机访问，改成`0.0.0.0`可被局域网访问，此时建议填写 TLS 证书，否则测试凭证以明文传输'),
      port: Schema.number().min(1).max(65535).default(61901).description('监听端口。端口被占用时端点启动失败，沙盒工作台不受影响'),
      allowedSources: Schema.array(String).default([]).description('来源 IP 白名单，在监听地址之上再筛一层，只有命中白名单的 IP 才放行。留空表示不筛，可达范围仍由上面的监听地址决定。支持精确 IP 与 CIDR 写法，例如`192.168.1.0/24`或`::1/128`'),
      allowedOrigins: Schema.array(String).default([]).description('只有以下浏览器 Origin 能访问，要写全协议与端口，例如`http://localhost:5173`。浏览器请求必带 Origin 头，留空表示一律拒绝；curl 与 AI 客户端不带 Origin，不受此项限制'),
      tlsCertPath: Schema.string().description('TLS 证书路径。监听地址不是本机时建议填写，留空则以明文 HTTP 传输测试凭证'),
      tlsKeyPath: Schema.string().description('TLS 私钥路径。监听地址不是本机时建议填写，留空则以明文 HTTP 传输测试凭证'),
      readPerMinute: Schema.number().min(1).default(120).description('每个测试凭证每分钟的读取调用次数上限，超出返回 429'),
      mutationPerMinute: Schema.number().min(1).default(60).description('每个测试凭证每分钟的变更调用次数上限，超出返回 429'),
      waitPerMinute: Schema.number().min(1).default(120).description('每个测试凭证每分钟的等待调用次数上限，超出返回 429'),
      uploadPerMinute: Schema.number().min(1).default(30).description('每个测试凭证每分钟的媒体上传次数上限，超出返回 429'),
      maxConcurrentMutations: Schema.number().min(1).default(4).description('每个测试凭证同时进行的变更调用数上限，超出返回 429'),
      maxConcurrentWaits: Schema.number().min(1).default(8).description('每个测试凭证同时进行的等待调用数上限，超出返回 429'),
      maxConcurrentUploads: Schema.number().min(1).default(2).description('每个测试凭证同时进行的媒体上传数上限，超出返回 429'),
    }).description('端点通用设置'),
    // 外层刻意不写 description：配置页只在 object 有 description 时渲染 h2，而这一层已经没有自己的
    // 字段了，给它标题只会得到一个下面什么都没有、紧接着又是一个标题的空标题。配置键仍是
    // `testEndpoint.*`，分组只在页面上消失。
  }),
})

/**
 * 交给 v2 插件页的 schema：字段与 `Settings` 相同但全部标 hidden，插件页只剩一行指向沙盒设置页的标题。
 * 配置仍存在 chatluna.yml 的同一条插件条目里，loader 照常按它补默认值、传给 `apply`。
 */
export const Config = Schema.object(
  Object.fromEntries(Object.entries(Settings.dict ?? {}).map(([key, field]) => [key, field.hidden()])),
).description('设置在 OneBot 沙盒工作台的「设置」页编辑') as unknown as Schema<Config>

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
  let createModelRequestPersistence: (scopeId: string) => SandboxModelRequestPersistence
  if (config.persistenceMode === 'database') {
    // database 可能晚于本插件就绪；表在服务出现时注册，读写一律经 getter 现取。
    ctx.inject(['database'], (inner) => {
      registerSandboxSceneModel(inner)
      registerSandboxTestSpaceModel(inner)
      registerSandboxOneBotDebugModel(inner)
      registerSandboxModelRequestModel(inner)
    })
    persistence = new KoishiDatabaseScenePersistence(getDatabase)
    createDebugPersistence = (scopeId) => new KoishiDatabaseOneBotDebugPersistence(scopeId, getDatabase)
    createModelRequestPersistence = (scopeId) => new KoishiDatabaseModelRequestPersistence(scopeId, getDatabase)
  } else {
    // 内存 Adapter 与数据库 Adapter 共用同一 Interface；进程内跨控制服务实例可恢复，进程退出后不保留。
    const memoryDebug = new Map<string, MemoryOneBotDebugPersistence>()
    const memoryModelRequests = new Map<string, MemoryModelRequestPersistence>()
    createDebugPersistence = (scopeId) => {
      const existing = memoryDebug.get(scopeId)
      if (existing) return existing
      const created = new MemoryOneBotDebugPersistence(scopeId)
      memoryDebug.set(scopeId, created)
      return created
    }
    createModelRequestPersistence = (scopeId) => {
      const existing = memoryModelRequests.get(scopeId)
      if (existing) return existing
      const created = new MemoryModelRequestPersistence(scopeId)
      memoryModelRequests.set(scopeId, created)
      return created
    }
  }
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const modelRequestRecordMaxBytes = config.modelRequestRecordMaxMegabytes * MEGABYTE
  const unattributedModelRequests = new SandboxModelRequestStore({
    persistence: createModelRequestPersistence(UNATTRIBUTED_MODEL_REQUEST_SCOPE_ID),
    maxRecords: config.modelRequestRecordLimit,
    maxBytes: modelRequestRecordMaxBytes,
  })
  const control = new SandboxControlService(ctx, {
    persistence,
    runtimeBots,
    debugPersistence: createDebugPersistence('main'),
    modelRequestPersistence: createModelRequestPersistence(MAIN_MODEL_REQUEST_SCOPE_ID),
    modelRequestRecordLimit: config.modelRequestRecordLimit,
    modelRequestRecordMaxBytes,
    sceneMessageLimit: config.sceneMessageLimit,
    sceneMessageMaxBytes: config.sceneMessageMaxBytes,
  })
  const testSpaces = new SandboxTestSpaceService(
    ctx,
    runtimeBots,
    config.persistenceMode === 'database' ? new KoishiDatabaseTestSpacePersistence(getDatabase) : undefined,
    createDebugPersistence,
    createModelRequestPersistence,
    config.modelRequestRecordLimit,
    modelRequestRecordMaxBytes,
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
      unattributedModelRequests,
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
    }
  } catch (error) {
    ctx.logger.error('%s\n%s', 'test endpoint init failed; the workspace stays available', errorDetail(error))
  }
  const appearance: SandboxAppearance = {
    sandboxTimBubbleTail: config.sandboxTimBubbleTail,
    sandboxMarkRecalledMessages: config.sandboxMarkRecalledMessages,
  }
  registerConsole(createWebuiRegistrar(ctx), control, appearance, endpoint, testSpaces, unattributedModelRequests)
  registerSettings(ctx, Settings, 'chatluna-plugin-onebot-sandbox')
  onStart(ctx, async () => {
    await control.waitForSceneReady()
    await endpoint?.server.start().catch((error) => ctx.logger.error('%s\n%s', 'test endpoint listener failed to start', errorDetail(error)))
  })
  onDispose(ctx, () => {
    // Cordis 不等待 dispose 回调；这里只保证收尾写入的失败进日志，而不是被静默丢弃。
    void unattributedModelRequests.waitForPersistence().catch((error) => {
      ctx.logger.error('%s\n%s', 'unattributed model request persistence failed on shutdown', errorDetail(error))
    })
    endpoint?.server.stop()
  })
}

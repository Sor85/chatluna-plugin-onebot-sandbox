import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Config, inject } from '../src'
import { DEFAULT_SCENE_MESSAGE_LIMIT, DEFAULT_SCENE_MESSAGE_MAX_BYTES } from '../src/control-service'

describe('插件持久化配置', () => {
  it('默认使用数据库模式，Database 不进入必需依赖', () => {
    // 默认值是 database，但 Database 不进 inject：数据库缺失时插件照常挂载，只是场景不落盘。
    expect(inject).toEqual(['satori', 'chatluna_webui'])
    if (!Config.dict) throw new Error('配置 Schema 缺少字段定义')
    expect(Config.dict.persistenceMode.meta.default).toBe('database')
    expect(Config.dict.persistenceMode.meta.description).toBe('模拟 QQ 环境状态存储方式')
    expect(Config.dict.sandboxTimBubbleTail.meta.description).toBe('显示气泡小尖角')
    // 强调色沿用源插件的默认蓝色，WebQQ 不跟随 v2 主题的 primary。
    expect(Config.dict.sandboxAccentColor.meta.default).toBe('#2563eb')
    expect(Config.dict.sandboxAccentColor.meta.role).toBe('color')
    expect(Config.dict.sandboxMarkRecalledMessages.meta.default).toBe(true)
    expect(Config.dict.sandboxMarkRecalledMessages.meta.description).toBe('仅影响 Sandbox 展示：开启时保留撤回气泡并显示撤回线，关闭时只显示撤回事件')
    expect(Config.dict.modelRequestRecordLimit.meta.default).toBe(500)
    expect(Config.dict.modelRequestRecordLimit.meta.description).toBe('每个空间保留的模型请求记录条数上限。超出后从最旧记录开始丢弃，与体积上限同时生效')
    // 条数与体积是两道各自独立的上限，任一超出即从最旧记录开始丢弃。体积上限原先 50MB 硬编码
    // 且不可见，长上下文记录会在远未到条数上限时被回收；两项文案都必须说清「同时生效」。
    expect(Config.dict.modelRequestRecordMaxMegabytes.meta.default).toBe(50)
    expect(Config.dict.modelRequestRecordMaxMegabytes.meta.description).toBe('每个空间模型请求记录的体积上限（MB）。超出后从最旧记录开始丢弃，与条数上限同时生效。单条记录含完整请求体与响应原文，长上下文请求可达数百 KB')
    expect(Config.dict.webQQChatStyle).toBeUndefined()
  })

  /**
   * chatluna-usage 的用量服务是 Console `DataService`，真实服务名是 `console.services.chatluna_usage`，
   * 根上下文里不存在 `chatluna_usage`。一旦有人把它写回服务声明，插件配置页就会长期显示
   * 「可选服务: chatluna_usage (未加载)」，而功能其实一直正常——纯展示性错误，别的测试不会变红。
   */
  it('包元数据的服务声明与入口 inject 一致，Database 与设置页用的 chatluna_config 只作为可选服务出现', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    expect(manifest.cordis.service.required).toEqual(inject)
    expect(manifest.cordis.service.optional).toEqual(['chatluna_config', 'database'])
  })

  it('场景消息保留上限可配置，且描述说明会丢弃历史消息', () => {
    if (!Config.dict) throw new Error('配置 Schema 缺少字段定义')
    expect(Config.dict.sceneMessageLimit.meta.default).toBe(DEFAULT_SCENE_MESSAGE_LIMIT)
    expect(Config.dict.sceneMessageLimit.meta.description).toContain('丢弃')
    expect(Config.dict.sceneMessageMaxBytes.meta.default).toBe(DEFAULT_SCENE_MESSAGE_MAX_BYTES)
    expect(Config.dict.sceneMessageMaxBytes.meta.description).toContain('丢弃')
  })
})

/**
 * 三个端点分组在插件配置页上的形状与文案分工。
 *
 * 这份守卫钉住的是用户在控制台里看到什么，而不是实现细节：把 `enabled` 或 `path` 从端点分组挪走、
 * 给某个端点改默认值、把「这个端点是干什么的」写回分组标题、或者把端点通用设置的监听、门禁与配额挪回
 * `testEndpoint` 顶层（那样它们会视觉上挂到最后一个端点标题下面），都会让配置页与文档不符，
 * 而这些都不会让别的测试变红。
 */
describe('测试控制端点配置', () => {
  it('两个端点各有独立的总开关与路径，且默认都开启', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')

    for (const [protocol, path, label] of [['mcp', '/mcp', 'MCP'], ['http', '/api', 'HTTP']] as const) {
      const group = endpoint[protocol].dict
      if (!group) throw new Error(`${protocol} 端点配置分组缺失`)
      expect(group.enabled.meta.default, protocol).toBe(true)
      expect(group.enabled.meta.description, protocol).toBe(`是否开启 ${label}`)
      expect(group.path.meta.default, protocol).toBe(path)
    }
  })

  /**
   * 配置页把分组的 description 渲染成标题（h2），把字段的 description 渲染成字段说明。
   * 标题里塞解释会得到一个折行的长句标题，因此标题只写名字，解释一律落在字段说明里。
   */
  it('分组标题只写名字，解释落在字段说明里', () => {
    const endpoint = Config.dict?.testEndpoint
    if (!endpoint?.dict) throw new Error('测试控制端点配置分组缺失')

    // 外层不带 description：配置页只在 object 有 description 时渲染 h2，而这一层已经没有自己的字段，
    // 有标题就等于页面上多出一个下面什么都没有、紧接着又是一个标题的空标题。
    expect(endpoint.meta.description).toBeUndefined()
    const titles = [endpoint.dict.mcp, endpoint.dict.http, endpoint.dict.shared].map(({ meta }) => meta.description)
    expect(titles).toEqual(['MCP 测试端点', 'HTTP 测试端点', '端点通用设置'])
    // 标题里出现标点就意味着它又变成了一句解释；解释归字段说明。
    for (const title of titles) {
      expect(typeof title === 'string' && /[：:；;，,。]/.test(title), String(title)).toBe(false)
    }
  })

  /**
   * 门禁、配额与监听对两个端点同时生效，因此必须自成一组、并排在两个端点分组之后。
   *
   * 顺序是硬要求而不是审美：Koishi 按声明顺序渲染，散字段会挂在上一个 h2 下面。这一组若拆散回
   * `testEndpoint` 顶层，就会落进最后一个端点的标题里，读起来像只对那一个端点生效。
   */
  it('共用的监听、门禁与配额自成一组，且排在两个端点之后', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')
    const shared = endpoint.shared.dict
    if (!shared) throw new Error('共用配置分组缺失')

    // `testEndpoint` 顶层只剩三个分组：任何散字段都会被渲染到上一个端点标题下面。
    const keys = Object.keys(endpoint)
    expect(keys).toEqual(['mcp', 'http', 'shared'])
    expect(keys.indexOf('shared')).toBeGreaterThan(keys.indexOf('http'))
    expect(Object.keys(shared)).toEqual([
      'host', 'port', 'allowedSources', 'allowedOrigins', 'tlsCertPath', 'tlsKeyPath',
      'readPerMinute', 'mutationPerMinute', 'waitPerMinute', 'uploadPerMinute',
      'maxConcurrentMutations', 'maxConcurrentWaits', 'maxConcurrentUploads',
    ])
    // 两份白名单都不预置：默认监听地址已经是`127.0.0.1`，再塞一份回环来源白名单只会让人以为
    // 清空它就等于对外开放，实际可达范围始终由监听地址决定。
    expect(shared.allowedSources.meta.default).toEqual([])
    expect(shared.allowedOrigins.meta.default).toEqual([])
    // 端点分组里只留自己的开关与路径，不得各自再配一份监听、门禁或配额。
    for (const protocol of ['mcp', 'http'] as const) {
      expect(Object.keys(endpoint[protocol].dict ?? {}), protocol).toEqual(['enabled', 'path'])
    }
  })

  it('监听地址与端口在端点通用设置里', () => {
    const shared = Config.dict?.testEndpoint.dict?.shared.dict
    if (!shared) throw new Error('共用配置分组缺失')

    expect(shared.host.meta.default).toBe('127.0.0.1')
    expect(shared.port.meta.default).toBe(61901)
    // 同一个监听器按路径分流，只有一份地址与端口；「共用」由分组标题承载，字段说明不再重复。
    for (const [field, prefix] of [['host', '监听地址'], ['port', '监听端口']] as const) {
      expect(shared[field].meta.description, field).toMatch(new RegExp(`^${prefix}`))
    }
  })

  /** 按 KOISHI.md 的配置文案规范：字段说明不以句号结尾，反引号前后不额外加空格。 */
  it('端点字段说明符合配置文案规范', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')

    const descriptions = [endpoint, endpoint.mcp.dict, endpoint.http.dict, endpoint.shared.dict]
      .flatMap((group) => Object.values(group ?? {}).map((field) => field.meta.description))
      .filter((text): text is string => typeof text === 'string')

    expect(descriptions.length).toBeGreaterThan(15)
    for (const text of descriptions) {
      expect(text, text).not.toMatch(/[。.]$/)
      expect(text, text).not.toMatch(/ `|` /)
    }
  })
})

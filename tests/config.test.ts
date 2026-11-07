import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Schema from 'schemastery'
import { Config, inject } from '../src'
import { DEFAULT_SCENE_MESSAGE_LIMIT, DEFAULT_SCENE_MESSAGE_MAX_BYTES } from '../src/control-service'

/** 端点通用设置是监听与配额两个小节的 intersect，按小节展开成平铺字段。 */
const fieldsOf = (schema: Schema | undefined): Record<string, Schema> =>
  schema?.type === 'intersect'
    ? Object.assign({}, ...(schema.list ?? []).map(fieldsOf))
    : { ...schema?.dict }

/** 字段标题是 `label`，说明是 `description`（v2 SchemaForm 没有 label 时会把配置键当标题显示）。 */
const labelOf = (schema: Schema | undefined) => (schema?.meta as { label?: string } | undefined)?.label

describe('插件持久化配置', () => {
  it('默认使用数据库模式，Database 不进入必需依赖', () => {
    // 默认值是 database，但 Database 不进 inject：数据库缺失时插件照常挂载，只是场景不落盘。
    expect(inject).toEqual(['satori', 'chatluna_webui'])
    if (!Config.dict) throw new Error('配置 Schema 缺少字段定义')
    expect(Config.dict.persistenceMode.meta.default).toBe('database')
    expect(Config.dict.sandboxIncomingBubbleStyle.meta.default).toBe('shadow')
    // 强调色沿用源插件的默认蓝色，WebQQ 不跟随 v2 主题的 primary。
    expect(Config.dict.sandboxAccentColor.meta.default).toBe('#2563eb')
    expect(Config.dict.sandboxAccentColor.meta.role).toBe('color')
    expect(Config.dict.sandboxMarkRecalledMessages.meta.default).toBe(true)
    expect(Config.dict.webQQChatStyle).toBeUndefined()
  })

  it('每个顶层字段都有标题', () => {
    for (const [key, field] of Object.entries(Config.dict ?? {})) {
      // 两个分组各是所在分区的唯一字段，分区标题就是它的标题；分组里的字段另外核对。
      if (key === 'testEndpoint' || key === 'botTools' || key === 'presetEditing') continue
      expect(labelOf(field), key).toMatch(/\S/)
    }
    for (const [key, field] of Object.entries(Config.dict?.botTools.dict ?? {})) expect(labelOf(field), key).toMatch(/\S/)
    for (const [key, field] of Object.entries(Config.dict?.presetEditing.dict ?? {})) expect(labelOf(field), key).toMatch(/\S/)
  })

  /**
   * chatluna-usage 的用量服务是 Console `DataService`，真实服务名是 `console.services.chatluna_usage`，
   * 根上下文里不存在 `chatluna_usage`。一旦有人把它写回服务声明，插件配置页就会长期显示
   * 「可选服务: chatluna_usage (未加载)」，而功能其实一直正常——纯展示性错误，别的测试不会变红。
   */
  it('包元数据的服务声明与入口 inject 一致，Database、设置页用的 chatluna_config 与机器人工具用的 tools 只作为可选服务出现', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    expect(manifest.cordis.service.required).toEqual(inject)
    expect(manifest.cordis.service.optional).toEqual(['chatluna_config', 'database', 'tools'])
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
 * 测试端点在设置页上的形状与文案分工。
 *
 * 这份守卫钉住的是用户在设置页上看到什么，而不是实现细节：把 `enabled` 或 `path` 从端点小节挪走、
 * 给某个端点改默认值、把解释写回小节标题、或者把端点通用设置的监听、门禁与配额挪回 `testEndpoint`
 * 顶层（那样它们会落进某个端点的小节里，读起来像只对那个端点生效），都会让设置页与文档不符，
 * 而这些都不会让别的测试变红。
 */
describe('测试控制端点配置', () => {
  it('两个端点各有独立的总开关与路径，且默认都关闭', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')

    for (const [protocol, path] of [['mcp', '/mcp'], ['http', '/api']] as const) {
      const group = endpoint[protocol].dict
      if (!group) throw new Error(`${protocol} 端点配置分组缺失`)
      expect(group.enabled.meta.default, protocol).toBe(false)
      expect(labelOf(group.enabled), protocol).toBe('启用')
      expect(group.path.meta.default, protocol).toBe(path)
    }
  })

  /**
   * SchemaForm 把小节的 description 渲染成小节标题，把字段的 description 渲染成字段说明。
   * 标题里塞解释会得到一个折行的长句标题，因此标题只写名字，解释一律落在字段说明或分区说明里。
   */
  it('小节标题只写名字，解释落在字段说明里', () => {
    const endpoint = Config.dict?.testEndpoint
    if (!endpoint?.dict) throw new Error('测试控制端点配置分组缺失')

    // 外层不带 description：它已经是「测试端点」分区的唯一字段，有标题就等于分区标题下面紧接着又是一个同义标题。
    expect(endpoint.meta.description).toBeUndefined()
    // 通用设置本身也不带标题，由监听与配额两个小节各自出标题。
    expect(endpoint.dict.shared.meta.description).toBeUndefined()
    const titles = [endpoint.dict.mcp, endpoint.dict.http, ...(endpoint.dict.shared.list ?? [])].map(({ meta }) => meta.description)
    expect(titles).toEqual(['MCP 端点', 'HTTP 端点', '监听与访问', '调用配额'])
    // 标题里出现标点就意味着它又变成了一句解释；解释归字段说明。
    for (const title of titles) {
      expect(typeof title === 'string' && /[：:；;，,。]/.test(title), String(title)).toBe(false)
    }
  })

  /**
   * 门禁、配额与监听对两个端点同时生效，因此必须自成一组、并排在两个端点小节之后。
   * 这一组若拆散回 `testEndpoint` 顶层，就会落进最后一个端点的小节里，读起来像只对那一个端点生效。
   */
  it('共用的监听、门禁与配额自成一组，且排在两个端点之后', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')
    const shared = fieldsOf(endpoint.shared)

    // `testEndpoint` 顶层只剩三个分组：任何散字段都会被渲染到上一个端点小节下面。
    expect(Object.keys(endpoint)).toEqual(['mcp', 'http', 'shared'])
    expect(Object.keys(shared)).toEqual([
      'host', 'port', 'allowedSources', 'allowedOrigins', 'tlsCertPath', 'tlsKeyPath',
      'readPerMinute', 'mutationPerMinute', 'waitPerMinute', 'uploadPerMinute',
      'maxConcurrentMutations', 'maxConcurrentWaits', 'maxConcurrentUploads',
    ])
    // 两份白名单都不预置：默认监听地址已经是`127.0.0.1`，再塞一份回环来源白名单只会让人以为
    // 清空它就等于对外开放，实际可达范围始终由监听地址决定。
    expect(shared.allowedSources.meta.default).toEqual([])
    expect(shared.allowedOrigins.meta.default).toEqual([])
    // 端点小节里只留自己的开关与路径，不得各自再配一份监听、门禁或配额。
    for (const protocol of ['mcp', 'http'] as const) {
      expect(Object.keys(endpoint[protocol].dict ?? {}), protocol).toEqual(['enabled', 'path'])
    }
    // 配额默认折叠：七个数字字段平时不需要改，展开会把监听设置挤出首屏。
    expect(endpoint.shared.list?.[1]?.meta.collapse).toBe(true)
    // intersect 合并后仍能补齐两个小节的默认值。
    expect(Config({}).testEndpoint.shared).toMatchObject({ host: '127.0.0.1', port: 61901, readPerMinute: 120 })
  })

  it('每个端点字段都有标题', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')
    const fields = { ...endpoint.mcp.dict, ...fieldsOf(endpoint.shared) }
    for (const [key, field] of Object.entries(fields)) expect(labelOf(field), key).toMatch(/\S/)
    expect(labelOf(fieldsOf(endpoint.shared).host)).toBe('监听地址')
    expect(fieldsOf(endpoint.shared).host.meta.default).toBe('127.0.0.1')
    expect(fieldsOf(endpoint.shared).port.meta.default).toBe(61901)
  })

  /** 按 KOISHI.md 的配置文案规范：字段说明不以句号结尾，反引号前后不额外加空格。 */
  it('字段说明符合配置文案规范', () => {
    const endpoint = Config.dict?.testEndpoint.dict
    if (!endpoint) throw new Error('测试控制端点配置分组缺失')

    const descriptions = [Config.dict, endpoint.mcp.dict, endpoint.http.dict, fieldsOf(endpoint.shared), Config.dict?.botTools.dict]
      .flatMap((group) => Object.values(group ?? {}).map((field) => field.meta.description))
      .filter((text): text is string => typeof text === 'string')

    expect(descriptions.length).toBeGreaterThan(15)
    for (const text of descriptions) {
      expect(text, text).not.toMatch(/[。.]$/)
      expect(text, text).not.toMatch(/ `|` /)
    }
  })
})

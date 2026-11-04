import type { Context } from 'cordis'
import Schema from 'schemastery'
import { ApiError } from '@chatluna/server'
import { schemaDocument, type SchemaDocument } from '@chatluna/schema'
import type {} from '@chatluna/runtime-config'
import type {} from '@chatluna/ui-server'

export const SETTINGS_STATE = 'onebot-sandbox.settings'
export const SETTINGS_SAVE_ACTION = 'onebot-sandbox.settings.save'

/** 沙盒「设置」页读到的插件配置：chatluna.yml 里这条插件条目原样存的值（未写的键走 schema 默认值）。 */
export interface SandboxSettingsView {
  value: Record<string, unknown>
  schema: SchemaDocument
  /** chatluna.yml 的文件戳，保存时作为乐观锁回传；期间文件被改过则拒绝写入。 */
  revision: string
}

export interface SandboxSettingsSaveInput {
  config: Record<string, unknown>
  revision?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 插件设置在沙盒工作台里编辑，写回的仍是 chatluna.yml 中这条插件条目，与 v2 插件页（`plugins.save`）
 * 走同一个 `chatluna_config.save`。配置变更会让 loader 按新配置重启本插件，新值从下一次启动起生效。
 *
 * 条目 ID 取插件自己的 loader 条目，而不是按包名查找，多开实例时各改各的；`ctx.inject` 的子上下文
 * 没有 loader 条目，所以在外层先取好。
 */
export function registerSettings(ctx: Context, schema: Schema, packageName: string) {
  const ownId = ctx.fiber.entry?.options.id
  ctx.inject(['chatluna_config'], (inner) => {
    const entryId = () => ownId ?? inner.chatluna_config.idOf(packageName, 'onebot-sandbox')
    inner.chatluna_webui.state(SETTINGS_STATE, {
      get: (): SandboxSettingsView => {
        const config = inner.chatluna_config.entry(entryId())?.config
        return {
          value: isRecord(config) ? config : {},
          schema: schemaDocument(schema),
          revision: inner.chatluna_config.fileStamp(),
        }
      },
      refreshOn: ['chatluna/config-change'],
    })
    inner.chatluna_webui.action(
      SETTINGS_SAVE_ACTION,
      { input: Schema.object({ config: Schema.dict(Schema.any()).required(), revision: Schema.string() }) },
      async ({ config, revision }, { user }) => {
        try {
          schema(config)
        } catch (error) {
          throw new ApiError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
        }
        await inner.chatluna_config.save({
          id: entryId(),
          options: { config },
          by: `webui:${user}`,
          ...(revision === undefined ? {} : { revision }),
        })
      },
    )
  })
}

declare module '@chatluna/ui-client/client' {
  interface States {
    'onebot-sandbox.settings': SandboxSettingsView
  }
  interface Actions {
    'onebot-sandbox.settings.save'(input: SandboxSettingsSaveInput): Promise<void>
  }
}

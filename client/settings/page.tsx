import * as React from 'react'
import { DatabaseIcon, InfoIcon, PaletteIcon, SaveIcon, ServerCogIcon, SlidersHorizontalIcon, Undo2Icon, type LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, Button, cn, Spinner } from '@chatluna/ui-kit'
import { apiErrorMessage, callAction, toast, useLive } from '@chatluna/ui-client/client'
import { SchemaForm, useFormValidation } from '@chatluna/ui-schema-form/client'
import type { SchemaDocument } from '@chatluna/schema'
import { useT } from '../i18n'
import { OverlayScrollbar } from '../shared/overlay-scrollbar'
import { AboutPanel } from './about'
import { settingsDraft, useSettingsDraft } from './draft'
import { localizeSchema } from './localize'
import './settings.css'

type Values = Record<string, unknown>

interface SettingsSection {
  title: string
  description?: string
  /** 只含本分区的 schema 文档：根节点换成分区节点，并去掉分区自身的标题，免得表单里再渲染一遍。 */
  schema: SchemaDocument
  /** 本分区覆盖的顶层配置键，用来标出有未保存修改的分区。 */
  keys: string[]
}

/** 分区图标按分区的第一个配置键选取；新分区没有登记时用通用图标。 */
const SECTION_ICONS: Record<string, LucideIcon> = {
  sandboxAccentColor: PaletteIcon,
  persistenceMode: DatabaseIcon,
  testEndpoint: ServerCogIcon,
}

const sameValues = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

const textOf = (value: unknown) => typeof value === 'string' && value ? value : undefined

function keysOf(refs: SchemaDocument['refs'], id: number): string[] {
  const node = refs[id]
  if (node?.type === 'intersect') return (node.list ?? []).flatMap((child) => keysOf(refs, child))
  return Object.keys(node?.dict ?? {})
}

/**
 * 把 `Settings`（`src/index.ts`）的顶层 intersect 拆成分区。根节点不是 intersect 时整份 schema 作为一个分区，
 * 页面仍能渲染。
 */
function sectionsOf(document: SchemaDocument, fallbackTitle: string): SettingsSection[] {
  const root = document.refs[document.uid]
  const ids = root?.type === 'intersect' ? root.list ?? [] : [document.uid]
  return ids.map((id) => {
    const node = document.refs[id]!
    const { label, description, ...meta } = node.meta ?? {}
    const stripped: SchemaDocument['refs'][string] = { ...node, meta }
    return {
      title: textOf(label) ?? textOf(description) ?? fallbackTitle,
      description: textOf(label) ? textOf(description) : undefined,
      schema: { uid: id, refs: { ...document.refs, [id]: stripped } },
      keys: keysOf(document.refs, id),
    }
  })
}

/**
 * 插件设置页。读写的是 chatluna.yml 里本插件条目的配置（`src/settings.ts`），v2 插件页不再显示这些字段。
 * 版式与环境管理页一致：左侧分区导航，右侧面板只显示当前分区；保存与撤销作用于全部分区。
 * 导航末尾固定有「关于」（`about.tsx`），它不来自 schema，选中时面板换成插件信息。
 *
 * 各分区的表单都挂载着（未选中的隐藏），共用同一个校验，保存时不会漏掉看不见的分区。
 *
 * 草稿存在 `draft.ts`，离开设置页再回来不会丢；页头的「设置」标签据此标出未保存修改。
 *
 * 保存后插件按新配置重启，实时 state 要等重启完成才推来新值；这段时间里表单先显示刚保存的值，
 * 文件戳一变再换成服务端读回的值，避免先闪回旧值。
 */
export function SettingsPage() {
  const t = useT()
  const live = useLive('onebot-sandbox.settings')
  const validation = useFormValidation()
  const draft = useSettingsDraft().value
  const setDraft = settingsDraft.setValue
  const [pending, setPending] = React.useState<{ revision: string, value: Values }>()
  const [saving, setSaving] = React.useState(false)
  const [active, setActive] = React.useState<number | 'about'>(0)
  const scroller = React.useRef<HTMLDivElement>(null)
  const data = live.data
  const saved = pending && pending.revision === data?.revision ? pending.value : data?.value
  const value = draft ?? saved ?? {}
  const dirty = draft !== undefined && !sameValues(draft, saved)
  // 只在已读到保存值时同步：加载期间 saved 为空，不能把留下的草稿误判成已改动或未改动。
  React.useEffect(() => {
    if (data) settingsDraft.setDirty(dirty)
  }, [data, dirty])
  const fallbackTitle = t('sandbox.nav.settings')
  const sections = React.useMemo(() => data ? sectionsOf(localizeSchema(data.schema, t), fallbackTitle) : [], [data, t, fallbackTitle])
  const about = active === 'about'
  const current = about ? undefined : sections[Math.min(active, sections.length - 1)]
  const panelTitle = about ? t('sandbox.settings.about.title') : current?.title
  const panelDescription = about ? t('sandbox.settings.about.description') : current?.description

  const discard = () => {
    setDraft(undefined)
    validation.reset()
  }

  const save = async () => {
    if (!data || !draft) return
    if (!validation.attempt()) {
      toast.error(t('sandbox.settings.invalid'))
      return
    }
    setSaving(true)
    try {
      await callAction('onebot-sandbox.settings.save', { config: draft, revision: data.revision })
      setPending({ revision: data.revision, value: draft })
      setDraft(undefined)
      validation.reset()
      toast.success(t('sandbox.settings.saved'))
    } catch (error) {
      toast.error(t('sandbox.settings.saveFailed'), { description: apiErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  const select = (index: number | 'about') => {
    setActive(index)
    scroller.current?.scrollTo({ top: 0 })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-3 pb-6 text-sm leading-5">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">{t('sandbox.settings.description')}</p>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-muted-foreground">{t('sandbox.settings.unsaved')}</span>}
          <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={discard}>
            <Undo2Icon />{t('sandbox.settings.discard')}
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : <SaveIcon />}{t(saving ? 'sandbox.common.saving' : 'sandbox.common.save')}
          </Button>
        </div>
      </div>
      {data && sections.length ? (
        <div className="grid min-h-0 w-full max-w-5xl flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1">
          <nav aria-label={t('sandbox.settings.sections')} className="sandbox-scroll-strip flex gap-0.5 self-start overflow-x-auto rounded-xl p-1.5 ring-1 ring-border md:flex-col md:overflow-x-visible">
            {sections.map((section, index) => {
              const Icon = SECTION_ICONS[section.keys[0] ?? ''] ?? SlidersHorizontalIcon
              const changed = draft !== undefined && section.keys.some((key) => !sameValues(draft[key], saved?.[key]))
              return (
                <Button
                  key={index}
                  variant="ghost"
                  className={cn('shrink-0 justify-start md:w-full', section === current && 'bg-accent text-accent-foreground')}
                  aria-current={section === current ? 'page' : undefined}
                  onClick={() => select(index)}
                >
                  <Icon />
                  <span>{section.title}</span>
                  {changed && <span role="img" aria-label={t('sandbox.settings.unsaved')} className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />}
                </Button>
              )
            })}
            <div role="separator" className="mx-1 shrink-0 bg-border max-md:w-px md:my-1 md:h-px" />
            <Button
              variant="ghost"
              className={cn('shrink-0 justify-start md:w-full', about && 'bg-accent text-accent-foreground')}
              aria-current={about ? 'page' : undefined}
              onClick={() => select('about')}
            >
              <InfoIcon />
              <span>{t('sandbox.settings.about.title')}</span>
            </Button>
          </nav>
          <section aria-label={panelTitle} className="flex min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border">
            <header className="flex shrink-0 flex-col gap-0.5 border-b border-border px-4 py-3">
              <h2 className="text-[13px] font-medium">{panelTitle}</h2>
              {panelDescription && <p className="text-[11px] text-muted-foreground">{panelDescription}</p>}
            </header>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div ref={scroller} className="sandbox-settings-scroller min-h-0 flex-1 overflow-y-auto">
                <fieldset disabled={saving} className="sandbox-settings-form min-w-0 px-5 py-4">
                  {sections.map((section, index) => (
                    <div key={index} hidden={section !== current}>
                      <SchemaForm
                        schema={section.schema}
                        value={value}
                        initial={saved}
                        onChange={setDraft}
                        validation={validation}
                        formId="onebot-sandbox.settings"
                      />
                    </div>
                  ))}
                  {about && <AboutPanel />}
                </fieldset>
              </div>
              <OverlayScrollbar target={scroller} className="sandbox-settings-scrollbar" />
            </div>
          </section>
        </div>
      ) : live.error ? (
        <Alert variant="destructive" className="max-w-5xl">
          <AlertDescription>{t('sandbox.settings.unavailableDetail', { error: live.error })}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex justify-center py-12 text-muted-foreground"><Spinner /></div>
      )}
    </div>
  )
}

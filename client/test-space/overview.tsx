import * as React from 'react'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { Badge, Button, cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@chatluna/ui-kit'
import type { SandboxTestSpaceStatus, SandboxTestSpaceSummary } from '../../src/test-spaces'
import type { SandboxWorkspaceState } from '../../src/types'
import { WebqqView } from '../chat/webqq-view'
import { useT } from '../i18n'
import { SandboxProvider, useSandbox, type SandboxDialogs } from '../workspace/context'
import { WorkspaceStore } from '../workspace/store'
import { AgentCursor } from './agent-visuals'
import { instantiateWorkspaceThumbnail, restoreWorkspaceThumbnailScroll, type WorkspaceThumbnailCapture } from './thumbnail-capture'
import { calculateContainedWorkspaceThumbnailTransform } from './thumbnail-scale'
import { staggerCardsIn, zoomCardFromRect } from './zoom'
import './spaces.css'

export type SpaceCardAction = 'return' | 'reactivate' | 'delete'
type Filter = 'all' | SandboxTestSpaceStatus

const FILTERS: Filter[] = ['all', 'running', 'taken-over', 'completed', 'failed']
const PREVIEW_WIDTH = 1440
const PREVIEW_HEIGHT = 760

/** 缩略图里的工作区只负责绘制，任何打开二级面的意图都不响应。 */
const NOOP_DIALOGS: SandboxDialogs = {
  openEntity() {},
  openRemark() {},
  openGroupAction() {},
  openConversationRename() {},
  openProfile() {},
  openGroupProfile() {},
}

const timeFormat = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * AI 测试空间总览：主环境卡片、各测试空间卡片（按创建时间从旧到新）与创建卡片。卡片缩略图优先用
 * 离开该空间时克隆的真实画面，从未进入过的空间按服务端快照渲染一份只读工作区。
 *
 * `exitZoom` 是从空间退回总览时留下的起点：挂载后让对应卡片从工作区位置缩回网格位，其余卡片错落浮现。
 */
export function SpaceOverview({ spaces, mainStore, captures, exitZoom, onEnter, onCreate, onAction }: {
  spaces: SandboxTestSpaceSummary[]
  mainStore: WorkspaceStore
  captures: Readonly<Record<string, WorkspaceThumbnailCapture>>
  exitZoom: React.RefObject<{ key: string, rect: DOMRect } | undefined>
  onEnter(spaceId?: string): void
  onCreate(): void
  onAction(action: SpaceCardAction, spaceId: string): void
}) {
  const t = useT()
  const [filter, setFilter] = React.useState<Filter>('all')
  const overview = React.useRef<HTMLElement>(null)
  const mainView = React.useSyncExternalStore(mainStore.subscribe, mainStore.getView, mainStore.getView)
  const base = mainView.workspace
  const previews = usePreviewStores(spaces, base)
  const visible = filter === 'all' ? spaces : spaces.filter((space) => space.status === filter)
  const filterItems = FILTERS.map((value) => ({ value, label: t(`sandbox.spaces.filter.${value}`) }))

  React.useLayoutEffect(() => {
    const pending = exitZoom.current
    exitZoom.current = undefined
    const root = overview.current
    if (!root) return
    const active = pending && root.querySelector<HTMLElement>(`[data-space-id="${CSS.escape(pending.key)}"]`)
    if (pending && active) zoomCardFromRect(active, root, pending.rect)
    staggerCardsIn([...root.querySelectorAll<HTMLElement>('.sandbox-space-card')].filter((card) => card !== active))
  }, [exitZoom])

  const openCard = (spaceId?: string) => (event: React.KeyboardEvent | React.MouseEvent) => {
    if ('key' in event && event.key !== 'Enter') return
    onEnter(spaceId)
  }

  return (
    <section
      ref={overview}
      aria-label={t('sandbox.spaces.overviewLabel')}
      className="sandbox-space-overview"
      style={{ '--sandbox-accent': base?.appearance.sandboxAccentColor ?? '#2563eb' } as React.CSSProperties}
    >
      <header className="sandbox-space-toolbar">
        <p>{t('sandbox.spaces.summary', { count: spaces.length })}</p>
        <Select value={filter} onValueChange={(value) => value && setFilter(value as Filter)} items={filterItems}>
          <SelectTrigger className="w-36" aria-label={t('sandbox.spaces.filterLabel')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {filterItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </header>

      <div className="sandbox-space-grid">
        <article className="sandbox-space-card is-main" data-space-id="main" tabIndex={0} onClick={openCard()} onKeyDown={openCard()}>
          <SpaceThumbnail capture={captures['main']} store={base ? mainStore : undefined} />
          <footer>
            <div className="min-w-0">
              <strong className="truncate">{t('sandbox.spaces.main.name')}</strong>
              <small>{t('sandbox.spaces.main.note')}</small>
            </div>
            <Badge variant="secondary">{t('sandbox.spaces.main.badge')}</Badge>
          </footer>
        </article>

        {visible.map((space) => {
          const running = space.status === 'running'
          return (
            <article
              key={space.id}
              className={cn('sandbox-space-card', running && 'is-running')}
              data-space-id={space.id}
              tabIndex={0}
              onClick={openCard(space.id)}
              onKeyDown={openCard(space.id)}
            >
              <SpaceThumbnail capture={captures[space.id]} store={base ? previews.get(space.id) : undefined} running={running} />
              <footer>
                <div className="min-w-0">
                  <strong className="truncate">{space.name}</strong>
                  <small>
                    {running && <span className="sandbox-agent-pulse-dot" aria-hidden="true" />}
                    {t(`sandbox.spaces.status.${space.status}`)} · {timeFormat.format(new Date(space.createdAt))}
                  </small>
                </div>
                {/* 「接管」在空间内部的任务栏里，运行中卡片不再提供接管入口。 */}
                <div className="sandbox-space-card-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  {space.status === 'taken-over' && (
                    <button type="button" className="sandbox-space-card-pill" onClick={() => onAction('return', space.id)}>{t('sandbox.spaces.return')}</button>
                  )}
                  {(space.status === 'completed' || space.status === 'failed') && (
                    <button type="button" className="sandbox-space-card-pill" onClick={() => onAction('reactivate', space.id)}>{t('sandbox.spaces.reactivate')}</button>
                  )}
                  <Button size="icon-xs" variant="ghost" aria-label={t('sandbox.spaces.delete')} onClick={() => onAction('delete', space.id)}><Trash2Icon /></Button>
                </div>
              </footer>
            </article>
          )
        })}

        <button type="button" className="sandbox-space-card sandbox-space-create" onClick={onCreate}>
          <PlusIcon className="size-10" strokeWidth={1.4} aria-hidden="true" />
          <strong className="font-medium">{t('sandbox.spaces.create')}</strong>
        </button>
      </div>
    </section>
  )
}

/**
 * 每个测试空间一份只读 store，按服务端快照填充；快照修订号不变就不重填，轮询返回同一份数据时
 * 不会重新渲染缩略图。外观与持久化状态借用主环境，这两项不随空间变化。
 */
function usePreviewStores(spaces: SandboxTestSpaceSummary[], base: SandboxWorkspaceState | undefined) {
  const entries = React.useRef(new Map<string, { store: WorkspaceStore, revision?: number }>())
  for (const space of spaces) {
    if (!entries.current.has(space.id)) entries.current.set(space.id, { store: new WorkspaceStore(space.id) })
  }
  React.useEffect(() => {
    const ids = new Set(spaces.map(({ id }) => id))
    for (const id of entries.current.keys()) if (!ids.has(id)) entries.current.delete(id)
    if (!base) return
    for (const space of spaces) {
      const entry = entries.current.get(space.id)
      if (!entry || entry.revision === space.snapshot.revision) continue
      entry.store.seed({ ...base, snapshot: space.snapshot, chatLunaStates: [] })
      entry.revision = space.snapshot.revision
    }
  }, [spaces, base])
  return new Map([...entries.current].map(([id, { store }]) => [id, store]))
}

/**
 * 卡片缩略图。真实画面的克隆与快照渲染的工作区都按 contain 缩放居中：卡片与页面宽高比不一致时
 * 保留留白，不裁掉页面区域。
 */
function SpaceThumbnail({ capture, store, running }: {
  capture?: WorkspaceThumbnailCapture
  store?: WorkspaceStore
  running?: boolean
}) {
  const frame = React.useRef<HTMLDivElement>(null)
  const host = React.useRef<HTMLDivElement>(null)
  const preview = React.useRef<HTMLDivElement>(null)

  const scale = React.useCallback(() => {
    const container = frame.current
    const element = capture ? host.current?.firstElementChild : preview.current
    if (!container || !(element instanceof HTMLElement)) return
    // 进入总览时卡片正在做 transform 动画，getBoundingClientRect 会读到过渡帧尺寸；用不受祖先变换影响的布局尺寸。
    const transform = calculateContainedWorkspaceThumbnailTransform({
      containerWidth: container.clientWidth,
      containerHeight: container.clientHeight,
      canvasWidth: capture?.width ?? PREVIEW_WIDTH,
      canvasHeight: capture?.height ?? PREVIEW_HEIGHT,
    })
    if (!transform) return
    if (capture) {
      element.style.width = `${capture.width}px`
      element.style.height = `${capture.height}px`
    }
    element.style.transform = `translate(${transform.left}px, ${transform.top}px) scale(${transform.scale})`
  }, [capture])

  React.useLayoutEffect(() => {
    const target = host.current
    if (!target) return
    target.replaceChildren()
    if (!capture) return
    const element = instantiateWorkspaceThumbnail(capture)
    target.append(element)
    scale()
    // scrollTop/scrollLeft 只有在克隆节点接入文档、完成布局后才会生效。
    const frameId = requestAnimationFrame(() => restoreWorkspaceThumbnailScroll(capture, element))
    return () => cancelAnimationFrame(frameId)
  }, [capture, scale])

  React.useLayoutEffect(() => {
    scale()
    const container = frame.current
    if (!container) return
    const observer = new ResizeObserver(scale)
    observer.observe(container)
    return () => observer.disconnect()
  }, [scale])

  return (
    <div ref={frame} className="sandbox-space-thumbnail" aria-hidden="true">
      <div ref={host} className="sandbox-space-thumbnail-host" />
      {!capture && store && (
        <div ref={preview} inert className="sandbox-space-thumbnail-preview">
          <SandboxProvider store={store} dialogs={NOOP_DIALOGS}>
            <PreviewWorkspace />
          </SandboxProvider>
        </div>
      )}
      {/* AI 控制中的游走光标放在缩放层之外，保持真实尺寸覆盖在缩略图上。 */}
      {running && <AgentCursor size={16} />}
    </div>
  )
}

function PreviewWorkspace() {
  const { derived } = useSandbox()
  return derived ? <WebqqView /> : null
}

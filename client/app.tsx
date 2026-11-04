import * as React from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Badge, Button, cn, Spinner, Tabs, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@chatluna/ui-kit'
import { toast, useLive } from '@chatluna/ui-client/client'
import { useT } from './i18n'
import { WebqqView } from './chat/webqq-view'
import { EnvironmentPage } from './environment/page'
import { OneBotDebugPage } from './onebot-debug/page'
import { SettingsPage } from './settings/page'
import { TestCallPage } from './test-call/page'
import { AgentControlIcon } from './test-space/agent-visuals'
import { AgentObserveOverlay } from './test-space/observe-overlay'
import { SpaceOverview, type SpaceCardAction } from './test-space/overview'
import { captureWorkspaceThumbnail, type WorkspaceThumbnailCapture } from './test-space/thumbnail-capture'
import { useSpaceList } from './test-space/use-space-list'
import { captureZoomRect, zoomWorkspaceFromRect } from './test-space/zoom'
import { SandboxProvider } from './workspace/context'
import { OverlayHost, useOverlayState } from './workspace/overlay-host'
import { errorText, invoke, WorkspaceStore } from './workspace/store'
import './shared/glass.css'

type View = 'messages' | 'debug' | 'test-calls' | 'environment' | 'spaces' | 'settings'

const VIEWS: View[] = ['messages', 'debug', 'test-calls', 'environment', 'spaces', 'settings']
/** 分段标签里的工作区；AI 测试空间与源插件一样单独钉在页头右端。 */
const TAB_VIEWS: View[] = ['messages', 'debug', 'test-calls', 'environment', 'settings']
/** 空间内部只有消息工作区；调试、环境与设置都属于整个沙盒，从总览以外的入口进入时落在主环境。 */
const SPACE_TAB_VIEWS: View[] = ['messages']

/**
 * 沙盒工作台。路由 `/onebot-sandbox/:view?` 选择工作区，`?space=<id>` 让消息工作区定域到某个 AI 测试空间；
 * 预设与模型请求分别交给 ChatLuna 自带的预设页与 trace 页，沙盒不再各做一份。服务端只推送
 * 「哪个空间变了」的失效信号，工作区收到后串行重读。
 */
export function SandboxApp() {
  const t = useT()
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const view = VIEWS.find((id) => id === params['view']) ?? 'messages'
  const spaceId = view === 'messages' ? searchParams.get('space') ?? undefined : undefined

  // 每个空间一份 store，进出空间时复用：进入前先把目标 store 读好，工作区首帧就能画出来接住缩放动画。
  const stores = React.useRef(new Map<string, WorkspaceStore>())
  const storeFor = React.useCallback((id: string | undefined) => {
    const key = id ?? 'main'
    let store = stores.current.get(key)
    if (!store) stores.current.set(key, store = new WorkspaceStore(id))
    return store
  }, [])
  const store = storeFor(spaceId)
  const mainStore = storeFor(undefined)

  const { state, setState, dialogs } = useOverlayState(store)
  const viewState = React.useSyncExternalStore(store.subscribe, store.getView, store.getView)
  const signal = useLive('onebot-sandbox.signal')
  const tick = signal.data?.scenes[spaceId ?? '']
  const startedAt = signal.data?.startedAt
  const { spaces, loaded: spacesLoaded, reload: reloadSpaces } = useSpaceList()
  const [captures, setCaptures] = React.useState<Record<string, WorkspaceThumbnailCapture>>({})
  const [spaceBusy, setSpaceBusy] = React.useState(false)
  const stage = React.useRef<HTMLDivElement>(null)
  // 页头高度：消息页让聊天列延伸到页头背后（glass.css 的 .sandbox-chat-pane），需要准确的像素值。
  const header = React.useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = header.current
    if (!element) return
    const measure = () => setHeaderHeight(element.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const enterZoom = React.useRef<DOMRect | undefined>(undefined)
  const exitZoom = React.useRef<{ key: string, rect: DOMRect } | undefined>(undefined)
  const space = spaceId ? spaces.find(({ id }) => id === spaceId) : undefined
  // 与源插件一致，入口图标跟随 MCP 服务器活动：有测试调用正在进行时转动并带光环。
  const mcpRunning = signal.data?.mcpRunning ?? false
  const spacesLabel = t(mcpRunning ? 'sandbox.nav.spacesRunning' : 'sandbox.nav.spaces')

  React.useEffect(() => {
    store.activate()
    void store.load()
    setState({})
    return () => store.dispose()
  }, [store, setState])

  // 地址里的空间已被删除时退回主环境，不停在一个读不到的空间上。
  React.useEffect(() => {
    if (spaceId && spacesLoaded && !spaces.some(({ id }) => id === spaceId)) navigate('/onebot-sandbox/messages', { replace: true })
  }, [spaceId, spaces, spacesLoaded, navigate])

  // 首个信号只是订阅时的快照，不代表变化；之后每次序号变化都触发一次重读。换空间后重新认一次快照。
  const seen = React.useRef<{ store: WorkspaceStore, tick: number } | undefined>(undefined)
  React.useEffect(() => {
    if (tick === undefined) return
    if (seen.current?.store === store && seen.current.tick !== tick) store.notifySceneChanged()
    seen.current = { store, tick }
  }, [tick, store])

  // 保存设置会让插件按新配置重启：启动时刻一变就整体重读，外观等随工作区下发的设置随之生效。
  const started = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (startedAt === undefined) return
    if (started.current !== undefined && started.current !== startedAt) {
      if (store.getView().workspace) store.notifySceneChanged()
      else void store.load()
    }
    started.current = startedAt
  }, [startedAt, store])

  // 进入空间：工作区在新路由的首帧从被点击的卡片处连续放大就位。
  React.useLayoutEffect(() => {
    const rect = enterZoom.current
    if (!rect || view !== 'messages' || !stage.current) return
    enterZoom.current = undefined
    zoomWorkspaceFromRect(stage.current, rect)
  })

  const runSpaceTask = async (task: () => Promise<unknown>) => {
    setSpaceBusy(true)
    try {
      await task()
    } catch (error) {
      toast.error(t('sandbox.spaces.actionFailed'), { description: errorText(error) })
    } finally {
      setSpaceBusy(false)
    }
  }

  const enterSpace = async (id?: string) => {
    // 新建的空间还没有卡片，从创建卡片处起步。
    const rect = captureZoomRect(document.querySelector(`[data-space-id="${CSS.escape(id ?? 'main')}"]`) ?? document.querySelector('.sandbox-space-create'))
    const target = storeFor(id)
    target.activate()
    await target.load()
    enterZoom.current = rect
    navigate(id ? `/onebot-sandbox/messages?space=${encodeURIComponent(id)}` : '/onebot-sandbox/messages')
  }

  const openOverview = async () => {
    // 离开前克隆消息工作区当前画面作为该空间的缩略图，并记下位置，让总览里对应卡片从这里缩回网格位。
    const root = view === 'messages' ? stage.current : null
    if (root) {
      const key = spaceId ?? 'main'
      const capture = captureWorkspaceThumbnail(root)
      setCaptures((value) => ({ ...value, [key]: capture }))
      const rect = captureZoomRect(root)
      exitZoom.current = rect && { key, rect }
    }
    // 先取数据再切视图，卡片的初始变换才能赶在首帧写入。
    await reloadSpaces().catch(() => {})
    navigate('/onebot-sandbox/spaces')
  }

  const actOnSpace = (action: SpaceCardAction | 'take-over' | 'terminate', id: string) => runSpaceTask(async () => {
    if (action === 'return') await invoke('onebot-sandbox.return-test-space', { spaceId: id })
    else if (action === 'reactivate') await invoke('onebot-sandbox.reactivate-test-space', { spaceId: id })
    else if (action === 'take-over') await invoke('onebot-sandbox.take-over-test-space', { spaceId: id })
    else if (action === 'terminate') await invoke('onebot-sandbox.terminate-test-space', { spaceId: id })
    else {
      await invoke('onebot-sandbox.delete-test-space', { spaceId: id })
      stores.current.delete(id)
      setCaptures(({ [id]: _, ...rest }) => rest)
    }
    await reloadSpaces()
  })

  const createSpace = () => runSpaceTask(async () => {
    const created = await invoke('onebot-sandbox.create-test-space', {})
    await reloadSpaces()
    await enterSpace(created.id)
  })

  const selectView = (next: View) => {
    if (next === 'spaces') void openOverview()
    else navigate(`/onebot-sandbox/${next}`)
  }

  const loading = (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
      {viewState.loadError ? (
        <>
          <p role="alert" className="text-destructive">{viewState.loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void store.load()}>{t('sandbox.common.retry')}</Button>
        </>
      ) : <Spinner />}
    </div>
  )

  return (
    <TooltipProvider>
      <SandboxProvider store={store} dialogs={dialogs}>
        <div className="flex h-full min-h-0 flex-col bg-background text-sm leading-6 text-foreground">
          {/* 页头用 v2 页面的标题与分段标签，压成一行，把高度留给工作区。 */}
          <Tabs
            ref={header}
            value={view}
            className={cn('shrink-0 gap-4 px-6 py-3 data-horizontal:flex-row data-horizontal:items-center', view === 'messages' && 'sandbox-page-header')}
            onValueChange={(value) => selectView(value as View)}
          >
            <h1 className="shrink-0 text-lg font-semibold">{t('onebot-sandbox.title')}</h1>
            <TabsList className="min-w-0 max-w-full justify-start overflow-x-auto" aria-label={t('sandbox.nav.label')}>
              {(spaceId ? SPACE_TAB_VIEWS : TAB_VIEWS).map((id) => <TabsTrigger key={id} value={id}>{t(`sandbox.nav.${id}`)}</TabsTrigger>)}
            </TabsList>
            {space && <Badge variant="secondary" className="min-w-0 max-w-60 truncate">{t('sandbox.spaces.current', { name: space.name })}</Badge>}
            <Tooltip>
              <TooltipTrigger render={(
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('ml-auto shrink-0 overflow-visible', view === 'spaces' && 'bg-accent text-accent-foreground')}
                  style={mcpRunning ? { color: viewState.workspace?.appearance.sandboxAccentColor ?? '#2563eb' } : undefined}
                  aria-label={spacesLabel}
                  aria-current={view === 'spaces' ? 'page' : undefined}
                  onClick={() => selectView('spaces')}
                />
              )}>
                <AgentControlIcon running={mcpRunning} />
              </TooltipTrigger>
              <TooltipContent>{spacesLabel}</TooltipContent>
            </Tooltip>
          </Tabs>
          {view === 'settings' ? <SettingsPage /> : view === 'spaces' ? (
            <SpaceOverview
              spaces={spaces}
              mainStore={mainStore}
              captures={captures}
              exitZoom={exitZoom}
              onEnter={(id) => void runSpaceTask(() => enterSpace(id))}
              onCreate={() => void createSpace()}
              onAction={(action, id) => void actOnSpace(action, id)}
            />
          ) : viewState.workspace ? (
            <>
              {view === 'messages' && (
                <div
                  ref={stage}
                  className="sandbox-stage relative flex min-h-0 flex-1"
                  style={{
                    '--sandbox-accent': viewState.workspace.appearance.sandboxAccentColor,
                    '--sandbox-page-header-height': `${headerHeight}px`,
                  } as React.CSSProperties}
                >
                  <WebqqView />
                  {space?.status === 'running' && (
                    <AgentObserveOverlay
                      spaceName={space.name}
                      busy={spaceBusy}
                      onTakeOver={() => void actOnSpace('take-over', space.id)}
                      onTerminate={() => void actOnSpace('terminate', space.id)}
                    />
                  )}
                </div>
              )}
              {view === 'debug' && <OneBotDebugPage />}
              {view === 'test-calls' && <TestCallPage />}
              {view === 'environment' && <EnvironmentPage />}
              <OverlayHost state={state} setState={setState} />
            </>
          ) : loading}
        </div>
      </SandboxProvider>
    </TooltipProvider>
  )
}

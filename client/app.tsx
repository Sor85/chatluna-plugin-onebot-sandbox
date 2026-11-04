import * as React from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button, Spinner, Tabs, TabsList, TabsTrigger, TooltipProvider } from '@chatluna/ui-kit'
import { useLive } from '@chatluna/ui-client/client'
import { useT } from './i18n'
import { WebqqView } from './chat/webqq-view'
import { EnvironmentPage } from './environment/page'
import { OneBotDebugPage } from './onebot-debug/page'
import { SettingsPage } from './settings/page'
import { TestCallPage } from './test-call/page'
import { SandboxProvider } from './workspace/context'
import { OverlayHost, useOverlayState } from './workspace/overlay-host'
import { WorkspaceStore } from './workspace/store'

type View = 'messages' | 'debug' | 'test-calls' | 'environment' | 'settings'

const VIEWS: View[] = ['messages', 'debug', 'test-calls', 'environment', 'settings']

/**
 * 沙盒工作台。路由 `/onebot-sandbox/:view?` 选择工作区；预设与模型请求分别交给 ChatLuna 自带的
 * 预设页与 trace 页，沙盒不再各做一份。服务端只推送「哪个空间变了」的失效信号，工作区收到后串行重读。
 */
export function SandboxApp() {
  const t = useT()
  const navigate = useNavigate()
  const params = useParams()
  const view = VIEWS.find((id) => id === params['view']) ?? 'messages'
  const store = React.useMemo(() => new WorkspaceStore(undefined), [])
  const { state, setState, dialogs } = useOverlayState(store)
  const viewState = React.useSyncExternalStore(store.subscribe, store.getView, store.getView)
  const signal = useLive('onebot-sandbox.signal')
  const tick = signal.data?.scenes['']
  const startedAt = signal.data?.startedAt

  React.useEffect(() => {
    store.activate()
    void store.load()
    return () => store.dispose()
  }, [store])

  // 首个信号只是订阅时的快照，不代表变化；之后每次序号变化都触发一次重读。
  const seen = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (tick === undefined) return
    if (seen.current !== undefined && seen.current !== tick) store.notifySceneChanged()
    seen.current = tick
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

  return (
    <TooltipProvider>
      <SandboxProvider store={store} dialogs={dialogs}>
        <div className="flex h-full min-h-0 flex-col bg-background text-sm leading-6 text-foreground">
          {/* 页头用 v2 页面的标题与分段标签，压成一行，把高度留给工作区。 */}
          <Tabs
            value={view}
            className="shrink-0 gap-4 px-6 py-3 data-horizontal:flex-row data-horizontal:items-center"
            onValueChange={(value) => navigate(`/onebot-sandbox/${String(value)}`)}
          >
            <h1 className="shrink-0 text-lg font-semibold">{t('onebot-sandbox.title')}</h1>
            <TabsList className="min-w-0 max-w-full justify-start overflow-x-auto" aria-label={t('sandbox.nav.label')}>
              {VIEWS.map((id) => <TabsTrigger key={id} value={id}>{t(`sandbox.nav.${id}`)}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          {view === 'settings' ? <SettingsPage /> : viewState.workspace ? (
            <>
              {view === 'messages' && <WebqqView />}
              {view === 'debug' && <OneBotDebugPage />}
              {view === 'test-calls' && <TestCallPage />}
              {view === 'environment' && <EnvironmentPage />}
              <OverlayHost state={state} setState={setState} />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
              {viewState.loadError ? (
                <>
                  <p role="alert" className="text-destructive">{viewState.loadError}</p>
                  <Button size="sm" variant="outline" onClick={() => void store.load()}>{t('sandbox.common.retry')}</Button>
                </>
              ) : <Spinner />}
            </div>
          )}
        </div>
      </SandboxProvider>
    </TooltipProvider>
  )
}

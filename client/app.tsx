import * as React from 'react'
import { useNavigate, useParams } from 'react-router'
import { BugIcon, FlaskConicalIcon, MessageCircleIcon, ServerCogIcon, SettingsIcon, TerminalSquareIcon } from 'lucide-react'
import { Button, cn, Spinner, TooltipProvider } from '@chatluna/ui-kit'
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

const VIEWS: Array<{ id: View, icon: typeof MessageCircleIcon }> = [
  { id: 'messages', icon: MessageCircleIcon },
  { id: 'debug', icon: BugIcon },
  { id: 'test-calls', icon: TerminalSquareIcon },
  { id: 'environment', icon: ServerCogIcon },
  { id: 'settings', icon: SettingsIcon },
]

/**
 * 沙盒工作台。路由 `/onebot-sandbox/:view?` 选择工作区；预设与模型请求分别交给 ChatLuna 自带的
 * 预设页与 trace 页，沙盒不再各做一份。服务端只推送「哪个空间变了」的失效信号，工作区收到后串行重读。
 */
export function SandboxApp() {
  const t = useT()
  const navigate = useNavigate()
  const params = useParams()
  const view = VIEWS.find(({ id }) => id === params['view'])?.id ?? 'messages'
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
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary"><FlaskConicalIcon className="size-4" /></span>
              <strong className="text-sm font-medium">{t('onebot-sandbox.title')}</strong>
            </div>
            <nav className="flex items-center gap-0.5" aria-label={t('sandbox.nav.label')}>
              {VIEWS.map(({ id, icon: Icon }) => (
                <Button
                  key={id}
                  variant="ghost"
                  size="sm"
                  className={cn(view === id && 'bg-accent text-accent-foreground')}
                  aria-current={view === id ? 'page' : undefined}
                  onClick={() => navigate(`/onebot-sandbox/${id}`)}
                >
                  <Icon /><span className="max-sm:sr-only">{t(`sandbox.nav.${id}`)}</span>
                </Button>
              ))}
            </nav>
          </header>
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

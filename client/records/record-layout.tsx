import * as React from 'react'
import {
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
  CalendarClockIcon,
  ClockIcon,
  FilterIcon,
  RefreshCwIcon,
  Trash2Icon,
  type LucideIcon,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Switch,
} from '@chatluna/ui-kit'
import { useT } from '../i18n'
import { formatDuration } from '../shared/format-duration'
import { MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS } from '../model-request/live-refresh'

export type SortOrder = 'asc' | 'desc'

/**
 * 记录工作台的页框：OneBot 调试与测试调用共用「说明 + 自动刷新/刷新/清理 + 列表|详情」的版式，
 * 两页只各自提供筛选项、列表行与详情内容。
 */
export function RecordPage({ title, description, loading, error, live, onLiveChange, onRefresh, clear, children }: {
  title: string
  description: string
  loading: boolean
  error: string
  live: boolean
  onLiveChange(live: boolean): void
  onRefresh(): void
  clear: { label: string, title: string, description: string, disabled: boolean, onConfirm(): Promise<void> | void }
  children: React.ReactNode
}) {
  const t = useT()
  const [confirming, setConfirming] = React.useState(false)
  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-3 pb-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">{description}</p>
        <div className="flex items-center gap-2">
          <label className="mr-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={live} onCheckedChange={(checked) => onLiveChange(checked === true)} />
            {t('sandbox.records.live')}
          </label>
          <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}><RefreshCwIcon />{t('sandbox.records.refresh')}</Button>
          <Button variant="outline" size="sm" className="text-destructive" disabled={loading || clear.disabled} onClick={() => setConfirming(true)}><Trash2Icon />{clear.label}</Button>
        </div>
      </header>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,40%)_minmax(0,1fr)] gap-4 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] md:grid-rows-1">
        {children}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="sandbox-glass">
          <AlertDialogHeader>
            <AlertDialogTitle>{clear.title}</AlertDialogTitle>
            <AlertDialogDescription>{clear.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('sandbox.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              setConfirming(false)
              void clear.onConfirm()
            }}>{clear.label}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** 左栏：标题、时间排序切换与筛选浮层；筛选浮层关闭时由调用方提交筛选。 */
export function RecordListPane({ label, order, onToggleOrder, filter, loading, empty, children }: {
  label: string
  order: SortOrder
  onToggleOrder(): void
  filter: { active: boolean, summary: string, open: boolean, onOpenChange(open: boolean): void, content: React.ReactNode }
  loading: boolean
  empty: boolean
  children: React.ReactNode
}) {
  const t = useT()
  const OrderIcon = order === 'asc' ? ArrowUpNarrowWideIcon : ArrowDownWideNarrowIcon
  return (
    <section aria-label={label} className="flex min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4">
        <h2 className="text-[13px] font-medium">{label}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t(order === 'asc' ? 'sandbox.records.orderAscHint' : 'sandbox.records.orderDescHint')}
            onClick={onToggleOrder}
          >
            <OrderIcon />{t(order === 'asc' ? 'sandbox.records.orderAsc' : 'sandbox.records.orderDesc')}
          </Button>
          <Popover open={filter.open} onOpenChange={filter.onOpenChange}>
            <PopoverTrigger render={(
              <Button
                variant={filter.active ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={t('sandbox.records.filterLabel', { summary: filter.summary })}
              />
            )}>
              <FilterIcon />
            </PopoverTrigger>
            <PopoverContent align="end" className="sandbox-glass flex w-72 flex-col gap-3">{filter.content}</PopoverContent>
          </Popover>
        </div>
      </header>
      {loading && empty ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : empty ? (
        <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">{t('sandbox.records.empty')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">{children}</div>
      )}
    </section>
  )
}

export function RecordItem({ active, onClick, title, badges, time, duration, extra }: {
  active: boolean
  onClick(): void
  title: string
  badges: React.ReactNode
  time: string
  duration: number
  extra?: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      className={cn('flex flex-col gap-1 rounded-lg px-2.5 py-2 text-left hover:bg-accent', active && 'bg-accent text-accent-foreground')}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <strong className="truncate text-[13px] font-medium">{title}</strong>
        {badges}
      </span>
      <RecordTiming time={time} duration={duration} extra={extra} />
    </button>
  )
}

export function RecordTiming({ time, duration, extra }: { time: string, duration: number, extra?: React.ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      <time className="flex items-center gap-1"><CalendarClockIcon className="size-3.5" />{formatRecordTime(time)}</time>
      <span className="flex items-center gap-1"><ClockIcon className="size-3.5" />{formatDuration(duration)}</span>
      {extra}
    </span>
  )
}

/** 右栏：未选中、读取中与详情三态。 */
export function RecordDetailPane({ label, loading, children }: { label: string, loading: boolean, children?: React.ReactNode }) {
  const t = useT()
  return (
    <section aria-label={label} className="flex min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border">
      {children ? (
        <article className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</article>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : (
        <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">{t('sandbox.records.pick')}</p>
      )}
    </section>
  )
}

export function StatusBadge({ status }: { status: 'success' | 'error' }) {
  const t = useT()
  return status === 'error'
    ? <Badge variant="destructive">{t('sandbox.records.statusError')}</Badge>
    : <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400">{t('sandbox.records.statusSuccess')}</Badge>
}

export function MetaList({ children }: { children: React.ReactNode }) {
  // 标签列取最长标签的宽度：英文标签（如 Implementation）比中文长，固定宽度会压到右侧的值上。
  return <dl className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-lg bg-muted/50 p-3 text-xs">{children}</dl>
}

export function MetaRow({ icon: Icon, label, value }: { icon: LucideIcon, label: string, value: React.ReactNode }) {
  return (
    <div className="contents">
      <Icon className="mt-0.5 size-3.5 text-muted-foreground" />
      <dt className="min-w-16 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  )
}

export function RecordSection({ icon: Icon, title, tone, children }: { icon: LucideIcon, title: string, tone?: 'destructive', children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className={cn('flex items-center gap-1.5 text-xs font-medium', tone === 'destructive' && 'text-destructive')}>
        <Icon className="size-3.5" />{title}
      </h3>
      {children}
    </section>
  )
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[28rem] overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

/** 筛选浮层里的一行：标签在上、控件在下。 */
export function FilterField({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

export function formatRecordTime(value: string) {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 进入页面时读一次；打开自动刷新后，页面可见期间每 2 秒重读，隐藏标签页时暂停。
 * `refresh` 每次渲染都可能是新函数，借 ref 读最新一份，计时器不随之重建。
 */
export function useRecordRefresh(live: boolean, refresh: () => void) {
  const latest = React.useRef(refresh)
  latest.current = refresh

  React.useEffect(() => {
    latest.current()
  }, [])

  React.useEffect(() => {
    if (!live) return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      const visible = document.visibilityState === 'visible'
      if (visible && !timer) timer = setInterval(() => latest.current(), MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS)
      if (!visible && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      if (timer) clearInterval(timer)
    }
  }, [live])
}

export function orderByTime<T extends { createdAt: string }>(records: readonly T[], order: SortOrder, tieBreak: (left: T, right: T) => number) {
  const sign = order === 'asc' ? 1 : -1
  return [...records].sort((left, right) => sign * (left.createdAt.localeCompare(right.createdAt) || tieBreak(left, right)))
}

import * as React from 'react'
import {
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
  CalendarClockIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
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
import { toast } from '@chatluna/ui-client/client'
import { useT } from '../i18n'
import { formatDuration } from '../shared/format-duration'
import { OverlayScrollbar } from '../shared/overlay-scrollbar'
import { MODEL_REQUEST_LIVE_REFRESH_INTERVAL_MS } from '../model-request/live-refresh'
import './records.css'

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
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-3 pb-6 text-sm leading-5">
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
        <AlertDialogContent>
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
  const scroller = React.useRef<HTMLDivElement>(null)
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
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scroller} className="sandbox-record-scroller flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">{children}</div>
          <OverlayScrollbar target={scroller} className="sandbox-record-scrollbar" />
        </div>
      )}
    </section>
  )
}

/**
 * 列表行：状态圆点 + 名称 + 右侧小标签一行，时间、耗时与 `meta`（来源、凭证等）一行。
 * 时间只写时分秒，跨天的记录补上月日；完整时间放在悬停提示里。
 */
export function RecordItem({ active, onClick, title, status, tag, time, duration, meta = [] }: {
  active: boolean
  onClick(): void
  title: string
  status: 'success' | 'error'
  tag?: string
  time: string
  duration: number
  meta?: React.ReactNode[]
}) {
  const t = useT()
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      className={cn('sandbox-record-item', active && 'is-active')}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          role="img"
          aria-label={t(status === 'error' ? 'sandbox.records.statusError' : 'sandbox.records.statusSuccess')}
          className={cn('sandbox-record-dot', status === 'error' && 'is-error')}
        />
        <strong className={cn('min-w-0 flex-1 truncate font-mono text-[13px] leading-5 font-medium', status === 'error' && 'text-destructive')}>{title}</strong>
        {tag && <RecordTag>{tag}</RecordTag>}
      </span>
      <span className="sandbox-record-item-meta">
        <time dateTime={time} title={formatRecordTime(time)}>{formatListTime(time)}</time>
        <span>{formatDuration(duration)}</span>
        {meta.map((item, index) => <span key={index} className="min-w-0 truncate">{item}</span>)}
      </span>
    </button>
  )
}

/** 方向（EVENT/ACTION）、传输方式（MCP/HTTP）这类等宽小标签。 */
export function RecordTag({ children }: { children: React.ReactNode }) {
  return <span className="sandbox-record-tag">{children}</span>
}

function RecordTiming({ time, duration }: { time: string, duration: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
      <time dateTime={time} className="flex items-center gap-1"><CalendarClockIcon className="size-3.5" />{formatRecordTime(time)}</time>
      <span className="flex items-center gap-1"><ClockIcon className="size-3.5" />{formatDuration(duration)}</span>
    </span>
  )
}

/**
 * 右栏：未选中、读取中与详情三态。详情的标题栏（`RecordDetailHeader`）固定在顶部，只有正文滚动；
 * `scrollKey` 变化（换了一条记录）时正文回到顶部。
 */
export function RecordDetailPane({ label, loading, header, scrollKey, children }: {
  label: string
  loading: boolean
  header?: React.ReactNode
  scrollKey?: string
  children?: React.ReactNode
}) {
  const t = useT()
  const scroller = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [scrollKey])
  return (
    <section aria-label={label} className="flex min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border">
      {children ? (
        <>
          {header}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <article ref={scroller} className="sandbox-record-scroller flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-6">{children}</article>
            <OverlayScrollbar target={scroller} className="sandbox-record-scrollbar" />
          </div>
        </>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : (
        <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">{t('sandbox.records.pick')}</p>
      )}
    </section>
  )
}

/** 详情标题栏：名称与状态徽标一行，时间与耗时一行，与左栏的标题栏同样以细线分隔正文。 */
export function RecordDetailHeader({ title, badges, time, duration }: {
  title: string
  badges: React.ReactNode
  time: string
  duration: number
}) {
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-5 py-3.5">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate font-mono text-[15px] leading-6 font-semibold">{title}</h2>
        {badges}
      </span>
      <RecordTiming time={time} duration={duration} />
    </header>
  )
}

export function StatusBadge({ status }: { status: 'success' | 'error' }) {
  const t = useT()
  return status === 'error'
    ? <Badge variant="destructive">{t('sandbox.records.statusError')}</Badge>
    : <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400">{t('sandbox.records.statusSuccess')}</Badge>
}

/** 元信息网格：每项小标签在上、值在下，列数随面板宽度增减（`records.css`）。 */
export function MetaList({ children }: { children: React.ReactNode }) {
  return <dl className="sandbox-record-meta">{children}</dl>
}

/** `wide` 的项独占一整行，用于关联实体这类长值。 */
export function MetaRow({ icon: Icon, label, value, wide }: { icon: LucideIcon, label: string, value: React.ReactNode, wide?: boolean }) {
  return (
    <div className={cn('sandbox-record-meta-item', wide && 'is-wide')}>
      <dt className="sandbox-record-meta-label"><Icon />{label}</dt>
      <dd className="sandbox-record-meta-value">{value}</dd>
    </div>
  )
}

/** 一组「键 值」小片，例如关联实体的 userId、groupId。 */
export function MetaChips({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <span className="sandbox-record-chips">
      {items.map(([key, value]) => (
        <span key={key} className="sandbox-record-chip"><span className="sandbox-record-chip-key">{key}</span>{value}</span>
      ))}
    </span>
  )
}

/** 提示卡片：错误诊断（`destructive`）与会话观察等需要先读到的说明。 */
export function RecordNotice({ icon: Icon, title, tone, children }: { icon: LucideIcon, title: string, tone?: 'destructive', children: React.ReactNode }) {
  return (
    <section className={cn('sandbox-record-notice', tone === 'destructive' && 'is-destructive')}>
      <Icon />
      <div className="min-w-0">
        <h3 className="sandbox-record-notice-title">{title}</h3>
        <div className="sandbox-record-notice-body">{children}</div>
      </div>
    </section>
  )
}

export function RecordSection({ icon: Icon, title, children }: { icon: LucideIcon, title: string, children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />{title}
      </h3>
      {children}
    </section>
  )
}

/** 只给 `JSON.stringify` 的输出着色：字符串先于数字匹配，键名和值里的数字不会被拆开。 */
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g

function highlightJson(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    const [token, string, colon] = match
    if (match.index > last) parts.push(text.slice(last, match.index))
    const kind = string !== undefined
      ? colon ? 'key' : 'string'
      : /^[{}[\],]$/.test(token) ? 'punct' : /^[tfn]/.test(token) ? 'literal' : 'number'
    parts.push(<span key={match.index} className={`sandbox-json-${kind}`}>{string ?? token}</span>)
    if (colon) parts.push(colon)
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** JSON 代码块：语法着色，悬停时右上角浮现复制按钮。不设内层滚动，随详情正文一起滚。 */
export function JsonBlock({ value }: { value: unknown }) {
  const t = useT()
  const text = React.useMemo(() => JSON.stringify(value, null, 2) ?? String(value), [value])
  const tokens = React.useMemo(() => highlightJson(text), [text])
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      toast.error(t('sandbox.records.copyFailed'))
    }
  }
  return (
    <div className="sandbox-record-code">
      <pre>{tokens}</pre>
      <Button
        variant="outline"
        size="icon-sm"
        className="sandbox-record-code-copy"
        aria-label={t(copied ? 'sandbox.records.copied' : 'sandbox.records.copy')}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
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

/** 列表里的时间：当天只写时分秒，其余补上月日。 */
function formatListTime(value: string) {
  const date = new Date(value)
  const full = formatRecordTime(value)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? full.slice(11) : full.slice(5)
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

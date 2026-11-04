import * as React from 'react'
import { CalendarIcon, SearchIcon, XIcon } from 'lucide-react'
import { Button, Calendar, cn, InputGroup, InputGroupAddon, InputGroupInput, Popover, PopoverContent, PopoverTrigger } from '@chatluna/ui-kit'
import type { SandboxMessageSearchHit } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { formatMentionContent } from '../webqq/mention'
import { calendarValueToLocalDate, localDateToCalendarValue, localDateToMessageSearchRange } from '../webqq/message-search-date'
import { ensureMessageLoaded } from '../webqq/message-reveal'
import { errorText } from '../workspace/store'
import { useWorkspace } from '../workspace/context'

const PAGE_SIZE = 30

export interface MessageSearchAdapter {
  conversationId?: string
  search(input: { conversationId: string, query: string, createdAtStart?: string, createdAtEnd?: string, beforeMessageId?: string, limit: number }): Promise<{ hits: SandboxMessageSearchHit[], nextBeforeMessageId?: string }>
  isLoaded(messageId: string): boolean
  canLoadMore(): boolean
  oldestLoadedId(): string | undefined
  loadMore(): Promise<void>
  reveal(messageId: string): boolean
}

/**
 * 会话内查找：关键词防抖 250ms，可叠加按本地日历日筛选，也可只按日期查。
 * 选中命中项时若消息还没加载，会持续向前翻历史直到加载到它，再滚动并高亮。
 */
export function MessageSearchPanel({ adapter, onClose }: { adapter: MessageSearchAdapter, onClose(): void }) {
  const t = useT()
  const { participants, participantNames } = useWorkspace()
  const [query, setQuery] = React.useState('')
  const [date, setDate] = React.useState('')
  const [dateOpen, setDateOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [hits, setHits] = React.useState<SandboxMessageSearchHit[]>([])
  const [next, setNext] = React.useState<string>()
  const [active, setActive] = React.useState('')
  const [revealing, setRevealing] = React.useState('')
  const serial = React.useRef(0)
  const criteria = React.useRef<{ query: string, createdAtStart?: string, createdAtEnd?: string }>({ query: '' })
  const input = React.useRef<HTMLInputElement>(null)
  const latest = React.useRef(adapter)
  latest.current = adapter

  React.useEffect(() => input.current?.focus(), [])

  const run = React.useCallback(async (text: string, localDate: string) => {
    const conversationId = latest.current.conversationId
    const range = localDate ? localDateToMessageSearchRange(localDate) : undefined
    const requested = ++serial.current
    criteria.current = { query: text, ...range }
    setActive('')
    setHits([])
    setNext(undefined)
    setError('')
    if (!conversationId || (!text && !range)) return setLoading(false)
    if (localDate && !range) {
      setLoading(false)
      return setError(t('sandbox.search.invalidDate'))
    }
    setLoading(true)
    try {
      const result = await latest.current.search({ conversationId, ...criteria.current, limit: PAGE_SIZE })
      if (requested !== serial.current) return
      setHits(result.hits)
      setNext(result.nextBeforeMessageId)
    } catch (failure) {
      if (requested === serial.current) setError(errorText(failure, t('sandbox.search.failed')))
    } finally {
      if (requested === serial.current) setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    const text = query.trim()
    if (!text) {
      void run('', date)
      return
    }
    const timer = setTimeout(() => void run(text, date), 250)
    return () => clearTimeout(timer)
  }, [query, date, run])

  const loadMore = async () => {
    const conversationId = adapter.conversationId
    if (!conversationId || !next || loading) return
    const requested = ++serial.current
    setLoading(true)
    setError('')
    try {
      const result = await adapter.search({ conversationId, ...criteria.current, beforeMessageId: next, limit: PAGE_SIZE })
      if (requested !== serial.current) return
      setHits((current) => {
        const known = new Set(current.map(({ messageId }) => messageId))
        return [...current, ...result.hits.filter(({ messageId }) => !known.has(messageId))]
      })
      setNext(result.nextBeforeMessageId)
    } catch (failure) {
      if (requested === serial.current) setError(errorText(failure, t('sandbox.search.failed')))
    } finally {
      if (requested === serial.current) setLoading(false)
    }
  }

  const reveal = async (hit: SandboxMessageSearchHit) => {
    if (revealing) return
    setRevealing(hit.messageId)
    setError('')
    try {
      const loaded = await ensureMessageLoaded({
        messageId: hit.messageId,
        isLoaded: () => latest.current.isLoaded(hit.messageId),
        canLoadMore: () => latest.current.canLoadMore(),
        getOldestLoadedMessageId: () => latest.current.oldestLoadedId(),
        loadMore: () => latest.current.loadMore(),
      })
      if (!loaded) return setError(t('sandbox.search.notLoaded'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      if (!latest.current.reveal(hit.messageId)) return setError(t('sandbox.search.notFound'))
      setActive(hit.messageId)
    } catch (failure) {
      setError(errorText(failure, t('sandbox.search.revealFailed')))
    } finally {
      setRevealing('')
    }
  }

  const status = error
    || (loading && !hits.length ? t('sandbox.search.searching') : '')
    || (revealing ? t('sandbox.search.revealing') : '')
    || (!loading && !hits.length ? t('sandbox.search.empty') : '')
  const today = new Date()

  return (
    // 标题栏变窄时搜索框先收缩，不把会话标题挤没。
    <section role="search" aria-label={t('sandbox.search.label')} className="relative w-72 min-w-36 shrink">
      <InputGroup className="h-8">
        <InputGroupAddon><SearchIcon /></InputGroupAddon>
        <InputGroupInput
          ref={input}
          type="search"
          value={query}
          autoComplete="off"
          className="sandbox-search-input text-[13px]!"
          placeholder={t('sandbox.search.placeholder')}
          aria-label={t('sandbox.search.input')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || dateOpen) return
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }}
        />
        <InputGroupAddon align="inline-end" className="gap-0.5">
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger render={(
              <Button variant="ghost" size="icon-xs" className={cn(date && 'text-primary')} aria-pressed={!!date} aria-label={date ? t('sandbox.search.dateCurrent', { date }) : t('sandbox.search.date')} />
            )}>
              <CalendarIcon />
            </PopoverTrigger>
            <PopoverContent align="end" className="sandbox-glass w-auto p-0">
              <Calendar
                mode="single"
                captionLayout="dropdown"
                startMonth={new Date(today.getFullYear() - 9, 0)}
                endMonth={today}
                selected={localDateToCalendarValue(date)}
                onSelect={(value) => {
                  setDate(calendarValueToLocalDate(value))
                  setDateOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={query || date ? t('sandbox.search.clear') : t('sandbox.search.close')}
            onClick={() => {
              if (query || date) {
                setQuery('')
                setDate('')
                input.current?.focus()
              } else onClose()
            }}
          >
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      {(query.trim() || date) && (
        <div className="absolute top-10 right-0 z-30 flex max-h-96 w-80 flex-col gap-0.5 overflow-y-auto rounded-xl sandbox-search-results p-1.5 text-popover-foreground shadow-popup ring-1 ring-border" role="listbox" aria-label={t('sandbox.search.results')}>
          {status && <p role="status" aria-live="polite" className="px-2 py-3 text-center text-xs text-muted-foreground">{status}</p>}
          {hits.map((hit) => {
            const author = participants[hit.authorId] ?? { name: hit.authorId, isBot: false }
            return (
              <button
                key={hit.messageId}
                type="button"
                role="option"
                aria-selected={active === hit.messageId}
                disabled={!!revealing}
                className={cn('flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent disabled:opacity-60', active === hit.messageId && 'bg-accent')}
                onClick={() => reveal(hit)}
              >
                <SandboxAvatar kind={author.isBot ? 'bot' : 'user'} name={author.name} src={author.avatar} className="size-7" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <strong className="truncate text-xs font-medium">{author.name}</strong>
                    <time className="ml-auto shrink-0 text-[11px] text-muted-foreground" dateTime={hit.createdAt}>
                      {new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(hit.createdAt))}
                    </time>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{formatMentionContent(hit.summary, participantNames)}</span>
                </span>
              </button>
            )
          })}
          {next && hits.length > 0 && (
            <Button variant="ghost" size="sm" disabled={loading || !!revealing} onClick={loadMore}>
              {loading ? t('sandbox.common.loading') : t('sandbox.search.more')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

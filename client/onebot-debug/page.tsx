import * as React from 'react'
import {
  ArrowRightIcon,
  BoxIcon,
  BracesIcon,
  BotIcon,
  CircleAlertIcon,
  CpuIcon,
  GitBranchIcon,
  LinkIcon,
  TagIcon,
} from 'lucide-react'
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@chatluna/ui-kit'
import type {
  GetSandboxOneBotDebugRecordsInput,
  SandboxConsoleOneBotDebugRecord,
  SandboxDirectoryBot,
  SandboxEntitySource,
} from '../../src/types'
import { buildSandboxBotDirectory } from '../environment/directory-model'
import { useT } from '../i18n'
import {
  FilterField,
  JsonBlock,
  MetaList,
  MetaRow,
  RecordDetailPane,
  RecordItem,
  RecordListPane,
  RecordPage,
  RecordSection,
  RecordTiming,
  StatusBadge,
  orderByTime,
  useRecordRefresh,
  type SortOrder,
} from '../records/record-layout'
import { SandboxAvatar } from '../shared/avatar'
import { useSandbox } from '../workspace/context'
import { errorText, invoke } from '../workspace/store'
import { useTestSpaces } from '../workspace/use-test-spaces'

type Direction = 'all' | 'action' | 'event'

interface Filters {
  botKey: string
  direction: Direction
  action: string
  requestedAction: string
  errorsOnly: boolean
}

const EMPTY_FILTERS: Filters = { botKey: 'all', direction: 'all', action: '', requestedAction: '', errorsOnly: false }

function sourceKey(source: SandboxEntitySource) {
  return source.type === 'main' ? 'main' : `space:${source.spaceId}`
}

function botKey(bot: SandboxDirectoryBot) {
  return `${sourceKey(bot.source)}:${bot.id}`
}

function recordKey(record: SandboxConsoleOneBotDebugRecord) {
  return `${sourceKey(record.source)}:${record.id}`
}

function countLargeValues(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  if (Reflect.get(value, 'kind') === 'large-value') return 1
  return Object.values(value).reduce<number>((sum, item) => sum + countLargeValues(item), 0)
}

/** OneBot 调试：被测插件经虚拟机器人发出的 action 与沙盒推送的原始事件，跨主环境与全部测试空间。 */
export function OneBotDebugPage() {
  const t = useT()
  const { view } = useSandbox()
  const snapshot = view.workspace?.snapshot
  const { spaces } = useTestSpaces()
  const bots = React.useMemo(() => snapshot ? buildSandboxBotDirectory(snapshot, spaces) : [], [snapshot, spaces])
  const [records, setRecords] = React.useState<SandboxConsoleOneBotDebugRecord[]>([])
  const [detail, setDetail] = React.useState<SandboxConsoleOneBotDebugRecord>()
  const [loading, setLoading] = React.useState(false)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS)
  const [order, setOrder] = React.useState<SortOrder>('desc')
  const [filterOpen, setFilterOpen] = React.useState(false)
  const [live, setLive] = React.useState(false)

  const query = async (next: Filters = filters, nextOrder: SortOrder = order) => {
    const input: GetSandboxOneBotDebugRecordsInput = {
      botId: next.botKey === 'all' ? undefined : bots.find((bot) => botKey(bot) === next.botKey)?.id,
      direction: next.direction === 'all' ? undefined : next.direction,
      action: next.action.trim() || undefined,
      requestedAction: next.requestedAction.trim() || undefined,
      status: next.errorsOnly ? 'error' : undefined,
      order: nextOrder,
    }
    setLoading(true)
    try {
      setRecords((await invoke('onebot-sandbox.debug-records', input)).records)
      setError('')
    } catch (failure) {
      setError(errorText(failure, t('sandbox.debug.loadFailed')))
    } finally {
      setLoading(false)
    }
  }

  const open = async (record: SandboxConsoleOneBotDebugRecord) => {
    setDetailLoading(true)
    try {
      setDetail(await invoke('onebot-sandbox.debug-record', {
        recordId: record.id,
        includeLargeValues: true,
        ...(record.source.type === 'test-space' ? { spaceId: record.source.spaceId } : {}),
      }))
      setError('')
    } catch (failure) {
      setError(errorText(failure, t('sandbox.debug.detailFailed')))
    } finally {
      setDetailLoading(false)
    }
  }

  const refresh = () => {
    void query()
    if (detail) void open(detail)
  }
  useRecordRefresh(live, refresh)

  const update = (patch: Partial<Filters>, submit = false) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    if (submit) void query(next)
  }

  const active = filters.botKey !== 'all' || filters.direction !== 'all' || !!filters.action.trim() || !!filters.requestedAction.trim() || filters.errorsOnly
  const summary = [
    filters.botKey !== 'all' ? bots.find((bot) => botKey(bot) === filters.botKey)?.name ?? filters.botKey : '',
    filters.direction !== 'all' ? t(`sandbox.debug.direction.${filters.direction}`) : '',
    filters.action.trim(),
    filters.requestedAction.trim(),
    filters.errorsOnly ? t('sandbox.records.errorsOnly') : '',
  ].filter(Boolean).join(' · ') || t('sandbox.records.noFilter')
  const botName = (record: SandboxConsoleOneBotDebugRecord) => bots.find((bot) => bot.id === record.botId && sourceKey(bot.source) === sourceKey(record.source))?.name ?? record.botId
  const selected = detail ? recordKey(detail) : undefined

  const botItems = [{ value: 'all', label: t('sandbox.debug.allBots') }, ...bots.map((bot) => ({ value: botKey(bot), label: `${bot.name} · ${bot.id} · ${bot.source.name}` }))]
  const directionItems = (['all', 'action', 'event'] as const).map((value) => ({ value, label: t(`sandbox.debug.direction.${value}`) }))

  return (
    <RecordPage
      title={t('sandbox.debug.title')}
      description={t('sandbox.debug.description')}
      loading={loading}
      error={error}
      live={live}
      onLiveChange={setLive}
      onRefresh={refresh}
      clear={{
        label: t('sandbox.debug.clear'),
        title: t('sandbox.debug.clearTitle'),
        description: t('sandbox.debug.clearDescription'),
        disabled: !records.length,
        onConfirm: async () => {
          try {
            await invoke('onebot-sandbox.clear-debug-records', {})
            setDetail(undefined)
            await query()
          } catch (failure) {
            setError(errorText(failure, t('sandbox.debug.clearFailed')))
          }
        },
      }}
    >
      <RecordListPane
        label={t('sandbox.records.list')}
        order={order}
        onToggleOrder={() => {
          const next = order === 'desc' ? 'asc' : 'desc'
          setOrder(next)
          void query(filters, next)
        }}
        loading={loading}
        empty={!records.length}
        filter={{
          active,
          summary,
          open: filterOpen,
          onOpenChange: (next) => {
            setFilterOpen(next)
            if (!next) void query()
          },
          content: (
            <>
              <FilterField label={t('sandbox.debug.bot')}>
                <Select value={filters.botKey} onValueChange={(value) => value && update({ botKey: value })} items={botItems}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('sandbox.debug.allBots')}</SelectItem>
                    {bots.map((bot) => (
                      <SelectItem key={botKey(bot)} value={botKey(bot)}>
                        <SandboxAvatar kind="bot" name={bot.name} src={bot.avatar} className="size-5" badge={false} />
                        <span className="truncate">{bot.name} · {bot.id} · {bot.source.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label={t('sandbox.debug.directionLabel')}>
                <Select value={filters.direction} onValueChange={(value) => value && update({ direction: value as Direction })} items={directionItems}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {directionItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label={t('sandbox.debug.action')}>
                <Input value={filters.action} placeholder="get_group_info" onChange={(event) => update({ action: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void query()} />
              </FilterField>
              <FilterField label={t('sandbox.debug.requestedAction')}>
                <Input value={filters.requestedAction} placeholder="getGroupInfo" onChange={(event) => update({ requestedAction: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void query()} />
              </FilterField>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={filters.errorsOnly} onCheckedChange={(checked) => update({ errorsOnly: checked === true }, true)} />
                {t('sandbox.records.errorsOnly')}
              </label>
              <Button variant="outline" size="sm" onClick={() => {
                setFilters(EMPTY_FILTERS)
                void query(EMPTY_FILTERS)
              }}>{t('sandbox.records.reset')}</Button>
            </>
          ),
        }}
      >
        {orderByTime(records, order, (left, right) => left.sequence - right.sequence).map((record) => (
          <RecordItem
            key={recordKey(record)}
            active={recordKey(record) === selected}
            onClick={() => void open(record)}
            title={record.requestedAction}
            time={record.createdAt}
            duration={record.durationMs}
            badges={(
              <>
                <StatusBadge status={record.status} />
                <Badge variant="outline" className="font-mono text-[10px]">{record.direction.toUpperCase()}</Badge>
                <Badge variant="outline" className="max-w-32 truncate">{record.source.name}</Badge>
              </>
            )}
          />
        ))}
      </RecordListPane>
      <RecordDetailPane label={t('sandbox.records.detail')} loading={detailLoading}>
        {detail && <DebugDetail record={detail} botName={botName(detail)} />}
      </RecordDetailPane>
    </RecordPage>
  )
}

function DebugDetail({ record, botName }: { record: SandboxConsoleOneBotDebugRecord, botName: string }) {
  const t = useT()
  const entities = Object.entries(record.entities).filter((entry) => entry[1]).map(([key, value]) => `${key}=${value}`).join(' · ')
  const observation = record.conversationObservation
  const isAction = record.direction === 'action'
  return (
    <>
      <header className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <strong className="text-sm font-medium">{record.requestedAction}</strong>
          <StatusBadge status={record.status} />
          <Badge variant="outline" className="font-mono text-[10px]">{record.direction.toUpperCase()}</Badge>
        </span>
        <RecordTiming time={record.createdAt} duration={record.durationMs} />
      </header>
      <MetaList>
        <MetaRow icon={BotIcon} label={t('sandbox.debug.bot')} value={`${botName} · ${record.botId}`} />
        <MetaRow icon={BoxIcon} label={t('sandbox.debug.source')} value={record.source.name} />
        <MetaRow icon={CpuIcon} label={t('sandbox.debug.implementation')} value={record.implementation === 'napcat' ? 'NapCat' : 'LLBot'} />
        <MetaRow icon={LinkIcon} label={t('sandbox.debug.entities')} value={entities || t('sandbox.debug.noEntities')} />
        {record.action !== record.requestedAction && <MetaRow icon={ArrowRightIcon} label={t('sandbox.debug.action')} value={record.action} />}
        {record.matchedAlias && <MetaRow icon={TagIcon} label={t('sandbox.debug.alias')} value={record.matchedAlias} />}
      </MetaList>
      {observation && (
        <RecordSection icon={GitBranchIcon} title={t(`sandbox.debug.observation.${observation.kind}.title`)}>
          <p className="text-xs leading-5 text-muted-foreground">
            {t(`sandbox.debug.observation.${observation.kind}.detail`, { event: observation.eventConversationId, actual: observation.conversationId })}
          </p>
        </RecordSection>
      )}
      {record.error && (
        <RecordSection icon={CircleAlertIcon} title={t('sandbox.records.diagnosis')} tone="destructive">
          <p className="font-mono text-xs break-all">{record.error.code} · {record.error.message} · trace {record.error.traceId}</p>
        </RecordSection>
      )}
      {record.payload !== undefined && (
        <RecordSection icon={BracesIcon} title={t(isAction ? 'sandbox.debug.input' : 'sandbox.debug.eventData')}>
          <JsonBlock value={record.payload} />
          {countLargeValues(record.payload) > 0 && <p className="text-[11px] text-muted-foreground">{t('sandbox.debug.folded', { count: countLargeValues(record.payload) })}</p>}
        </RecordSection>
      )}
      {record.result !== undefined && (
        <RecordSection icon={BracesIcon} title={t(isAction ? 'sandbox.debug.output' : 'sandbox.debug.handled')}>
          <JsonBlock value={record.result} />
          {countLargeValues(record.result) > 0 && <p className="text-[11px] text-muted-foreground">{t('sandbox.debug.folded', { count: countLargeValues(record.result) })}</p>}
        </RecordSection>
      )}
    </>
  )
}

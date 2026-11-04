import * as React from 'react'
import { BoxIcon, BracesIcon, CircleAlertIcon, GlobeIcon, KeyRoundIcon, PlugIcon, TagIcon } from 'lucide-react'
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
import type { ListSandboxTestCallRecordsInput } from '../../src/mcp/call-records'
import type { SandboxTestCallRecord, SandboxTestCallRecordListItem, SandboxTestCallTransport } from '../../src/mcp/types'
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
import { errorText, invoke } from '../workspace/store'

interface Filters {
  tool: string
  credentialName: string
  // 'all' 只是筛选面板的空值表述，提交查询时折成 undefined。
  transport: SandboxTestCallTransport | 'all'
  spaceId: string
  testRunId: string
  errorsOnly: boolean
}

const EMPTY_FILTERS: Filters = { tool: '', credentialName: '', transport: 'all', spaceId: '', testRunId: '', errorsOnly: false }

/** 测试调用：外部测试控制器经 MCP 或 HTTP 表述发来的工具调用，跨主环境与全部测试空间。 */
export function TestCallPage() {
  const t = useT()
  const [records, setRecords] = React.useState<SandboxTestCallRecordListItem[]>([])
  const [detail, setDetail] = React.useState<SandboxTestCallRecord>()
  const [loading, setLoading] = React.useState(false)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS)
  const [order, setOrder] = React.useState<SortOrder>('desc')
  const [filterOpen, setFilterOpen] = React.useState(false)
  const [live, setLive] = React.useState(false)

  const query = async (next: Filters = filters, nextOrder: SortOrder = order) => {
    const input: ListSandboxTestCallRecordsInput = {
      tool: next.tool.trim() || undefined,
      credentialName: next.credentialName.trim() || undefined,
      transport: next.transport === 'all' ? undefined : next.transport,
      spaceId: next.spaceId.trim() || undefined,
      testRunId: next.testRunId.trim() || undefined,
      status: next.errorsOnly ? 'error' : undefined,
      order: nextOrder,
    }
    setLoading(true)
    try {
      setRecords((await invoke('onebot-sandbox.test-call-records', input)).records)
      setError('')
    } catch (failure) {
      setError(errorText(failure, t('sandbox.testCall.loadFailed')))
    } finally {
      setLoading(false)
    }
  }

  const open = async (recordId: string) => {
    setDetailLoading(true)
    try {
      setDetail(await invoke('onebot-sandbox.test-call-record', { recordId }))
      setError('')
    } catch (failure) {
      setError(errorText(failure, t('sandbox.testCall.detailFailed')))
    } finally {
      setDetailLoading(false)
    }
  }

  const refresh = () => {
    void query()
    if (detail) void open(detail.id)
  }
  useRecordRefresh(live, refresh)

  const update = (patch: Partial<Filters>, submit = false) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    if (submit) void query(next)
  }

  const transportLabel = (value: SandboxTestCallTransport) => t(`sandbox.testCall.transport.${value}`)
  const text = [filters.tool, filters.credentialName, filters.spaceId, filters.testRunId].map((value) => value.trim())
  const active = text.some(Boolean) || filters.transport !== 'all' || filters.errorsOnly
  const summary = [
    text[0],
    text[1],
    filters.transport !== 'all' ? transportLabel(filters.transport) : '',
    text[2],
    text[3],
    filters.errorsOnly ? t('sandbox.records.errorsOnly') : '',
  ].filter(Boolean).join(' · ') || t('sandbox.records.noFilter')
  const transportItems = [
    { value: 'all', label: t('sandbox.testCall.transport.all') },
    { value: 'mcp', label: transportLabel('mcp') },
    { value: 'http', label: transportLabel('http') },
  ]

  return (
    <RecordPage
      title={t('sandbox.testCall.title')}
      description={t('sandbox.testCall.description')}
      loading={loading}
      error={error}
      live={live}
      onLiveChange={setLive}
      onRefresh={refresh}
      clear={{
        label: t('sandbox.testCall.clear'),
        title: t('sandbox.testCall.clearTitle'),
        description: t('sandbox.testCall.clearDescription'),
        disabled: !records.length,
        onConfirm: async () => {
          try {
            await invoke('onebot-sandbox.clear-test-call-records', undefined)
            setDetail(undefined)
            await query()
          } catch (failure) {
            setError(errorText(failure, t('sandbox.testCall.clearFailed')))
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
              <FilterField label={t('sandbox.testCall.tool')}>
                <Input value={filters.tool} placeholder="send_message" onChange={(event) => update({ tool: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void query()} />
              </FilterField>
              <FilterField label={t('sandbox.testCall.credential')}>
                <Input value={filters.credentialName} onChange={(event) => update({ credentialName: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void query()} />
              </FilterField>
              <FilterField label={t('sandbox.testCall.transportLabel')}>
                <Select value={filters.transport} onValueChange={(value) => value && update({ transport: value as Filters['transport'] }, true)} items={transportItems}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="sandbox-glass">
                    {transportItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label={t('sandbox.testCall.space')}>
                <Input value={filters.spaceId} placeholder="space-1" onChange={(event) => update({ spaceId: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void query()} />
              </FilterField>
              <FilterField label={t('sandbox.testCall.testRun')}>
                <Input value={filters.testRunId} placeholder="run-1" onChange={(event) => update({ testRunId: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void query()} />
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
        {orderByTime(records, order, (left, right) => left.id.localeCompare(right.id)).map((record) => (
          <RecordItem
            key={record.id}
            active={record.id === detail?.id}
            onClick={() => void open(record.id)}
            title={record.tool}
            time={record.createdAt}
            duration={record.durationMs}
            extra={<span className="flex items-center gap-1"><PlugIcon className="size-3.5" />{record.transport.toUpperCase()}</span>}
            badges={(
              <>
                <StatusBadge status={record.status} />
                <Badge variant="outline" className="max-w-32"><span className="truncate">{record.credentialName}</span></Badge>
              </>
            )}
          />
        ))}
      </RecordListPane>
      <RecordDetailPane label={t('sandbox.records.detail')} loading={detailLoading}>
        {detail && (
          <>
            <header className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <strong className="text-sm font-medium">{detail.tool}</strong>
                <StatusBadge status={detail.status} />
              </span>
              <RecordTiming time={detail.createdAt} duration={detail.durationMs} />
            </header>
            <MetaList>
              <MetaRow icon={KeyRoundIcon} label={t('sandbox.testCall.credential')} value={detail.credentialName} />
              <MetaRow icon={PlugIcon} label={t('sandbox.testCall.transportLabel')} value={transportLabel(detail.transport)} />
              {detail.sourceIp && <MetaRow icon={GlobeIcon} label={t('sandbox.testCall.sourceIp')} value={detail.sourceIp} />}
              {detail.spaceId && <MetaRow icon={BoxIcon} label={t('sandbox.testCall.space')} value={detail.spaceId} />}
              {detail.testRunId && <MetaRow icon={TagIcon} label={t('sandbox.testCall.testRun')} value={detail.testRunId} />}
            </MetaList>
            {detail.error && (
              <RecordSection icon={CircleAlertIcon} title={t('sandbox.records.diagnosis')} tone="destructive">
                <p className="font-mono text-xs break-all">{detail.error.code} · {detail.error.message}</p>
              </RecordSection>
            )}
            <RecordSection icon={BracesIcon} title={t('sandbox.testCall.arguments')}>
              <JsonBlock value={detail.arguments} />
            </RecordSection>
            {detail.result !== undefined && (
              <RecordSection icon={BracesIcon} title={t('sandbox.testCall.result')}>
                <JsonBlock value={detail.result} />
              </RecordSection>
            )}
            {detail.error && (
              <RecordSection icon={CircleAlertIcon} title={t('sandbox.testCall.error')}>
                <JsonBlock value={detail.error} />
              </RecordSection>
            )}
          </>
        )}
      </RecordDetailPane>
    </RecordPage>
  )
}

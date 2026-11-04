import * as React from 'react'
import { ChevronRightIcon, SearchIcon } from 'lucide-react'
import {
  Badge,
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Spinner,
} from '@chatluna/ui-kit'
import type { SandboxHttpApiCapabilityCatalog } from '../../src/mcp/http-api'
import type { SandboxMcpCapabilityCatalog, SandboxMcpScope } from '../../src/mcp/types'
import { useT } from '../i18n'
import { errorText } from '../workspace/store'

export const MCP_SCOPES: readonly SandboxMcpScope[] = ['read', 'interact', 'manage', 'debug']

/**
 * 一次性目录读取：独立的加载与失败态，失败只落成一条消息。两种协议表述各调一次，
 * 一页读失败不会把另一页拖成失败态，重试也只重试自己。
 */
export function useCatalog<Catalog>(read: () => Promise<Catalog>, failure: string) {
  const [catalog, setCatalog] = React.useState<Catalog>()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const latest = React.useRef(read)
  latest.current = read
  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setCatalog(await latest.current())
    } catch (cause) {
      setError(errorText(cause, failure))
    } finally {
      setLoading(false)
    }
  }, [failure])
  return { catalog, loading, error, load }
}

function CatalogState({ loading, error, onRetry, unavailable }: { loading: boolean, error: string, onRetry(): void, unavailable: string }) {
  const t = useT()
  if (loading) return <div className="flex flex-1 items-center justify-center p-8"><Spinner /></div>
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-xs">
        <p role="alert" className="text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>{t('sandbox.common.retry')}</Button>
      </div>
    )
  }
  return <p className="p-8 text-center text-xs text-muted-foreground">{unavailable}</p>
}

function Summary({ items }: { items: Array<{ value: React.ReactNode, label: string }> }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <article key={item.label} className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2.5">
          <strong className="text-base font-semibold tabular-nums">{item.value}</strong>
          <span className="text-[11px] text-muted-foreground">{item.label}</span>
        </article>
      ))}
    </div>
  )
}

function SearchInput({ value, onChange, placeholder }: { value: string, onChange(value: string): void, placeholder: string }) {
  return (
    <div className="relative flex-1">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" className="h-8 pl-8" value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

function Pill({ active, onClick, children }: { active: boolean, onClick(): void, children: React.ReactNode }) {
  return <Button size="sm" variant={active ? 'secondary' : 'ghost'} aria-pressed={active} onClick={onClick}>{children}</Button>
}

export function McpCapabilityCatalog({ catalog, loading, error, onRetry }: {
  catalog?: SandboxMcpCapabilityCatalog
  loading: boolean
  error: string
  onRetry(): void
}) {
  const t = useT()
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState<'tools' | 'resources'>('tools')
  const [scope, setScope] = React.useState<'all' | SandboxMcpScope>('all')
  if (!catalog || loading || error) return <CatalogState loading={loading} error={error} onRetry={onRetry} unavailable={t('sandbox.env.mcpUnavailable')} />

  const needle = query.trim().toLocaleLowerCase()
  const scopeLabel = (value: SandboxMcpScope) => t(`sandbox.scope.${value}`)
  const tools = catalog.tools.filter((tool) => (scope === 'all' || tool.scope === scope)
    && (!needle || [tool.name, tool.description, scopeLabel(tool.scope)].some((value) => value.toLocaleLowerCase().includes(needle))))
  const resources = catalog.resources.filter((resource) => !needle || [resource.name, resource.uri, resource.mimeType].some((value) => value.toLocaleLowerCase().includes(needle)))
  const flags = catalog.serverCapabilities

  return (
    <div className="flex flex-col gap-4 p-4">
      <Summary items={[
        { value: catalog.tools.length, label: t('sandbox.env.mcp.tools') },
        { value: catalog.resources.length, label: t('sandbox.env.mcp.resources') },
        { value: catalog.scopes.length, label: t('sandbox.env.mcp.scopes') },
      ]} />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-muted-foreground">Server capabilities</span>
        <Badge variant={flags.tools ? 'secondary' : 'outline'}>Tools</Badge>
        <Badge variant={flags.resources ? 'secondary' : 'outline'}>Resources</Badge>
        <Badge variant={flags.prompts ? 'secondary' : 'outline'}>{flags.prompts ? 'Prompts' : t('sandbox.env.mcp.promptsMissing')}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder={t('sandbox.env.mcp.search')} />
        <div className="flex gap-0.5">
          <Pill active={kind === 'tools'} onClick={() => setKind('tools')}>{t('sandbox.env.mcp.tools')}</Pill>
          <Pill active={kind === 'resources'} onClick={() => setKind('resources')}>{t('sandbox.env.mcp.resources')}</Pill>
        </div>
      </div>
      {kind === 'tools' ? (
        <>
          <div className="flex flex-wrap gap-0.5" aria-label={t('sandbox.env.mcp.scopeFilter')}>
            <Pill active={scope === 'all'} onClick={() => setScope('all')}>{t('sandbox.env.mcp.allScopes')}</Pill>
            {MCP_SCOPES.map((value) => <Pill key={value} active={scope === value} onClick={() => setScope(value)}>{scopeLabel(value)}</Pill>)}
          </div>
          <div className="flex flex-col gap-1.5">
            {tools.map((tool) => (
              <Collapsible key={tool.name} className="rounded-lg ring-1 ring-border">
                <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent/60">
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate font-mono text-xs font-medium">{tool.name}</strong>
                    <small className="line-clamp-2 text-[11px] text-muted-foreground">{tool.description}</small>
                  </span>
                  <Badge variant="outline">{scopeLabel(tool.scope)}</Badge>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-1.5 px-3 pb-3">
                  <span className="text-[11px] text-muted-foreground">{t('sandbox.env.mcp.inputSchema')}</span>
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-[11px] leading-5">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </CollapsibleContent>
              </Collapsible>
            ))}
            {!tools.length && <p className="py-6 text-center text-xs text-muted-foreground">{t('sandbox.env.mcp.noTool')}</p>}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          {resources.map((resource) => (
            <article key={resource.uri} className="flex items-center gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border">
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate text-xs font-medium">{resource.name}</strong>
                <small className="truncate font-mono text-[11px] text-muted-foreground">{resource.uri}</small>
              </span>
              <span className="flex shrink-0 flex-wrap justify-end gap-1">
                {resource.requiredScopes.map((value) => <Badge key={value} variant="outline">{scopeLabel(value)}</Badge>)}
                <Badge variant="secondary">{resource.mimeType}</Badge>
              </span>
            </article>
          ))}
          {!resources.length && <p className="py-6 text-center text-xs text-muted-foreground">{t('sandbox.env.mcp.noResource')}</p>}
        </div>
      )}
    </div>
  )
}

export function HttpCapabilityCatalog({ catalog, loading, error, onRetry }: {
  catalog?: SandboxHttpApiCapabilityCatalog
  loading: boolean
  error: string
  onRetry(): void
}) {
  const t = useT()
  const [query, setQuery] = React.useState('')
  if (!catalog || loading || error) return <CatalogState loading={loading} error={error} onRetry={onRetry} unavailable={t('sandbox.env.httpUnavailable')} />

  // 上限只用 MiB 一档：量级由服务端固定，换算成 KiB 或 GiB 读不出信息。
  const mib = catalog.maxBodyBytes / (1024 * 1024)
  const bodyLimit = `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
  // 示例路径取自服务端自述的 list-tools 路由，改了前缀或版本段，示例跟着变。
  const listTools = catalog.routes.find((route) => route.kind === 'list-tools')
  const example = listTools ? [
    `TOKEN=<${t('sandbox.env.http.tokenPlaceholder')}>`,
    '',
    `# ${t('sandbox.env.http.exampleList')}`,
    `curl -s -H "authorization: Bearer $TOKEN" "${catalog.baseUrl}${listTools.target}"`,
    '',
    `# ${t('sandbox.env.http.exampleCall')}`,
    `curl -s -X POST -H "authorization: Bearer $TOKEN" "${catalog.baseUrl}${listTools.target}/get_server_info"`,
  ].join('\n') : ''
  // 按状态码归并：HTTP 消费者手里先有状态码，要问的是「这个 429 可能是哪几种原因」。
  const keyword = query.trim().toLocaleLowerCase()
  const grouped = new Map<number, string[]>()
  for (const { code, status } of catalog.errorStatuses) {
    if (keyword && !code.includes(keyword) && !String(status).includes(keyword)) continue
    grouped.set(status, [...grouped.get(status) ?? [], code])
  }
  const statusGroups = [...grouped].sort(([left], [right]) => left - right)
  const code = (text: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{text}</code>

  return (
    <div className="flex flex-col gap-4 p-4">
      {!catalog.enabled && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-300">{t('sandbox.env.http.disabledNotice')}</p>
      )}
      <Summary items={[
        { value: catalog.routes.length, label: t('sandbox.env.http.routes') },
        { value: catalog.errorStatuses.length, label: t('sandbox.env.http.errorMappings') },
        { value: bodyLimit, label: t('sandbox.env.http.bodyLimit') },
      ]} />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-muted-foreground">{t('sandbox.env.http.protocol')}</span>
        <Badge variant={catalog.enabled ? 'secondary' : 'outline'}>{t(catalog.enabled ? 'sandbox.env.enabled' : 'sandbox.env.http.closed')}</Badge>
        <Badge variant="outline">{t('sandbox.env.http.basePath', { path: catalog.basePath })}</Badge>
        <Badge variant="outline">{t('sandbox.env.http.version', { version: catalog.version })}</Badge>
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium">{t('sandbox.env.http.auth')}</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          {t('sandbox.env.http.authBefore')}{code(catalog.baseUrl)}{t('sandbox.env.http.authMiddle')}{code('Authorization')}{t('sandbox.env.http.authCarry')}{code(`Bearer <${t('sandbox.env.http.tokenPlaceholder')}>`)}{t('sandbox.env.http.authAfter')}
        </p>
        {example && <pre className="overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-5">{example}</pre>}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium">{t('sandbox.env.http.routes')}</h3>
        {catalog.routes.map((route) => (
          <article key={route.kind} className="flex flex-col gap-1 rounded-lg px-3 py-2.5 ring-1 ring-border">
            <p className="flex min-w-0 items-center gap-2">
              <Badge variant="secondary" className="font-mono">{route.method}</Badge>
              <code className="truncate font-mono text-xs">{route.target}</code>
            </p>
            <small className="text-[11px] text-muted-foreground">{route.summary}</small>
          </article>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium">{t('sandbox.env.http.statusTitle')}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{t('sandbox.env.http.statusBefore')}{code('Retry-After')}{t('sandbox.env.http.statusAfter')}</p>
        <SearchInput value={query} onChange={setQuery} placeholder={t('sandbox.env.http.statusSearch')} />
        {statusGroups.map(([status, codes]) => (
          <article key={status} className="flex items-start gap-3 rounded-lg px-3 py-2 ring-1 ring-border">
            <Badge variant={status >= 500 ? 'destructive' : 'outline'} className="font-mono">{status}</Badge>
            <span className="flex min-w-0 flex-wrap gap-1">{codes.map((value) => <code key={value} className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[11px]')}>{value}</code>)}</span>
          </article>
        ))}
        {!statusGroups.length && <p className="py-4 text-center text-xs text-muted-foreground">{t('sandbox.env.http.noStatus')}</p>}
      </section>
    </div>
  )
}

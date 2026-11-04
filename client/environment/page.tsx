import * as React from 'react'
import { BotIcon, KeyRoundIcon, ServerCogIcon, UserIcon, UsersIcon, WebhookIcon, type LucideIcon } from 'lucide-react'
import { Badge, Button, cn } from '@chatluna/ui-kit'
import { useT } from '../i18n'
import { HttpCapabilityCatalog, McpCapabilityCatalog, useCatalog } from '../mcp/capability-catalog'
import { TestCredentialManager } from '../mcp/credential-manager'
import { SandboxAvatar } from '../shared/avatar'
import { useWorkspace } from '../workspace/context'
import { invoke } from '../workspace/store'
import { useTestSpaces } from '../workspace/use-test-spaces'
import { buildEnvironmentDirectoryModel } from './directory-model'

type Section = 'users' | 'bots' | 'groups' | 'credentials' | 'mcp' | 'http'

/** 环境管理：模拟 QQ 环境的三份目录，加上测试控制端点的凭证与两种协议表述的能力目录。 */
export function EnvironmentPage() {
  const t = useT()
  const { snapshot, resolveAvatar } = useWorkspace()
  const { spaces } = useTestSpaces()
  const directory = React.useMemo(() => buildEnvironmentDirectoryModel(snapshot, spaces, resolveAvatar), [snapshot, spaces, resolveAvatar])
  const [section, setSection] = React.useState<Section>('users')
  const mcp = useCatalog(() => invoke('onebot-sandbox.mcp-capabilities', undefined), t('sandbox.env.mcpFailed'))
  const http = useCatalog(() => invoke('onebot-sandbox.http-capabilities', undefined), t('sandbox.env.httpFailed'))
  const loadMcp = mcp.load
  const loadHttp = http.load

  React.useEffect(() => {
    void loadMcp()
    void loadHttp()
  }, [loadMcp, loadHttp])

  const sections: Array<{ id: Section, icon: LucideIcon, count?: number }> = [
    { id: 'users', icon: UserIcon, count: directory.users.length },
    { id: 'bots', icon: BotIcon, count: directory.bots.length },
    { id: 'groups', icon: UsersIcon, count: directory.groups.length },
    { id: 'credentials', icon: KeyRoundIcon },
    { id: 'mcp', icon: ServerCogIcon, count: mcp.catalog?.tools.length },
    { id: 'http', icon: WebhookIcon, count: http.catalog?.routes.length },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-3 pb-6">
      <p className="text-xs text-muted-foreground">{t('sandbox.env.description')}</p>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1">
        <nav aria-label={t('sandbox.env.sections')} className="flex gap-0.5 overflow-x-auto rounded-xl p-1.5 ring-1 ring-border md:flex-col md:overflow-x-visible">
          {sections.map(({ id, icon: Icon, count }) => (
            <Button
              key={id}
              variant="ghost"
              className={cn('shrink-0 justify-start md:w-full', section === id && 'bg-accent text-accent-foreground')}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
            >
              <Icon />
              <span>{t(`sandbox.env.section.${id}.label`)}</span>
              {count !== undefined && <Badge variant="outline" className="ml-auto tabular-nums">{count}</Badge>}
            </Button>
          ))}
        </nav>
        <section aria-label={t(`sandbox.env.section.${section}.label`)} className="flex min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border">
          <header className="flex shrink-0 flex-col gap-0.5 border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium">{t(`sandbox.env.section.${section}.label`)}</h2>
            <p className="text-[11px] text-muted-foreground">{t(`sandbox.env.section.${section}.description`)}</p>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {section === 'users' && (
              <DirectoryList empty={t('sandbox.env.noUser')}>
                {directory.users.map((user) => (
                  <DirectoryRow key={user.id} avatar={<SandboxAvatar kind="user" name={user.name} src={user.avatar} className="size-9" />} title={user.name} subtitle={user.id} />
                ))}
              </DirectoryList>
            )}
            {section === 'bots' && (
              <DirectoryList empty={t('sandbox.env.noBot')}>
                {directory.bots.map((bot) => (
                  <DirectoryRow
                    key={bot.source.type === 'main' ? `main:${bot.id}` : `space:${bot.source.spaceId}:${bot.id}`}
                    avatar={<SandboxAvatar kind="bot" name={bot.name} src={bot.avatar} className="size-9" />}
                    title={bot.name}
                    subtitle={`${bot.id} · ${bot.implementation === 'napcat' ? 'NapCat' : 'LLBot'}`}
                    badges={(
                      <>
                        <Badge variant="outline" className="max-w-40 truncate">{bot.source.name}</Badge>
                        <Badge variant={bot.enabled ? 'secondary' : 'outline'}>{t(bot.enabled ? 'sandbox.env.enabled' : 'sandbox.env.disabled')}</Badge>
                      </>
                    )}
                  />
                ))}
              </DirectoryList>
            )}
            {section === 'groups' && (
              <DirectoryList empty={t('sandbox.env.noGroup')}>
                {directory.groups.map((group) => (
                  <DirectoryRow
                    key={group.id}
                    avatar={<SandboxAvatar kind="group" name={group.name} src={group.avatar} className="size-9" />}
                    title={group.name}
                    subtitle={t('sandbox.env.groupSubtitle', { id: group.id, count: group.members.length })}
                  />
                ))}
              </DirectoryList>
            )}
            {section === 'credentials' && <TestCredentialManager />}
            {section === 'mcp' && <McpCapabilityCatalog catalog={mcp.catalog} loading={mcp.loading} error={mcp.error} onRetry={() => void mcp.load()} />}
            {section === 'http' && <HttpCapabilityCatalog catalog={http.catalog} loading={http.loading} error={http.error} onRetry={() => void http.load()} />}
          </div>
        </section>
      </div>
    </div>
  )
}

function DirectoryList({ empty, children }: { empty: string, children: React.ReactNode[] }) {
  return (
    <div className="flex flex-col gap-0.5 p-1.5">
      {children}
      {!children.length && <p className="py-8 text-center text-xs text-muted-foreground">{empty}</p>}
    </div>
  )
}

function DirectoryRow({ avatar, title, subtitle, badges }: { avatar: React.ReactNode, title: string, subtitle: string, badges?: React.ReactNode }) {
  return (
    <article className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/60">
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="truncate text-[13px] font-medium">{title}</strong>
        <small className="truncate text-[11px] text-muted-foreground">{subtitle}</small>
      </span>
      {badges && <span className="flex shrink-0 items-center gap-1.5">{badges}</span>}
    </article>
  )
}

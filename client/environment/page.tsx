import * as React from 'react'
import { BotIcon, KeyRoundIcon, PencilIcon, PlusIcon, ServerCogIcon, Trash2Icon, UserIcon, UsersIcon, WebhookIcon, type LucideIcon } from 'lucide-react'
import { Badge, Button, cn, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@chatluna/ui-kit'
import { getSandboxBots } from '../../src/types'
import { sourceName, useT } from '../i18n'
import { HttpCapabilityCatalog, McpCapabilityCatalog, useCatalog } from '../mcp/capability-catalog'
import { TestCredentialManager } from '../mcp/credential-manager'
import { SandboxAvatar } from '../shared/avatar'
import { OverlayScrollbar } from '../shared/overlay-scrollbar'
import { useSandbox, useWorkspace } from '../workspace/context'
import { invoke } from '../workspace/store'
import { useTestSpaces } from '../workspace/use-test-spaces'
import { CreateEntityPopover } from './create-popover'
import { buildEnvironmentDirectoryModel } from './directory-model'
import { implementationLabel } from '../shared/implementation'
import './page.css'

type Section = 'users' | 'bots' | 'groups' | 'credentials' | 'mcp' | 'http'

type EntityTarget = { type: 'user' | 'bot' | 'group', id: string }

/** 三份目录对应的创建类型；能力目录与测试凭证没有实体可建。 */
const CREATE_TYPES: Partial<Record<Section, EntityTarget['type']>> = { users: 'user', bots: 'bot', groups: 'group' }

interface SectionItem {
  id: Section
  icon: LucideIcon
  count?: number
}

/** 环境管理：模拟 QQ 环境的三份目录，加上测试控制端点的凭证与两种协议表述的能力目录。 */
export function EnvironmentPage() {
  const t = useT()
  const { snapshot, resolveAvatar, operator } = useWorkspace()
  const { spaces } = useTestSpaces()
  const directory = React.useMemo(() => buildEnvironmentDirectoryModel(snapshot, spaces, resolveAvatar), [snapshot, spaces, resolveAvatar])
  const [section, setSection] = React.useState<Section>('users')
  const scroller = React.useRef<HTMLDivElement>(null)
  const mcp = useCatalog(() => invoke('onebot-sandbox.mcp-capabilities', undefined), t('sandbox.env.mcpFailed'))
  const http = useCatalog(() => invoke('onebot-sandbox.http-capabilities', undefined), t('sandbox.env.httpFailed'))
  const loadMcp = mcp.load
  const loadHttp = http.load

  React.useEffect(() => {
    void loadMcp()
    void loadHttp()
  }, [loadMcp, loadHttp])

  // 导航分两组：模拟出来的 QQ 环境，与给测试脚本用的控制端点。
  const groups: Array<{ id: 'directory' | 'endpoint', items: SectionItem[] }> = [
    {
      id: 'directory',
      items: [
        { id: 'users', icon: UserIcon, count: directory.users.length },
        { id: 'bots', icon: BotIcon, count: directory.bots.length },
        { id: 'groups', icon: UsersIcon, count: directory.groups.length },
      ],
    },
    {
      id: 'endpoint',
      items: [
        { id: 'mcp', icon: ServerCogIcon, count: mcp.catalog?.tools.length },
        { id: 'http', icon: WebhookIcon, count: http.catalog?.routes.length },
        { id: 'credentials', icon: KeyRoundIcon },
      ],
    },
  ]

  const createType = CREATE_TYPES[section]

  const select = (id: Section) => {
    setSection(id)
    scroller.current?.scrollTo({ top: 0 })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-3 pb-6 text-sm leading-5">
      <p className="text-xs text-muted-foreground">{t('sandbox.env.description')}</p>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1">
        <nav aria-label={t('sandbox.env.sections')} className="sandbox-scroll-strip flex gap-0.5 self-start overflow-x-auto rounded-xl p-1.5 ring-1 ring-border md:flex-col md:overflow-x-visible">
          {groups.map((group, index) => (
            <React.Fragment key={group.id}>
              {index > 0 && <div role="separator" className="mx-1 w-px shrink-0 bg-border md:hidden" />}
              <p className={cn('hidden px-2.5 pt-1.5 pb-1 text-[11px] leading-4 font-medium text-muted-foreground md:block', index > 0 && 'md:mt-2')}>
                {t(`sandbox.env.nav.${group.id}`)}
              </p>
              {group.items.map(({ id, icon: Icon, count }) => (
                <Button
                  key={id}
                  variant="ghost"
                  className={cn('shrink-0 justify-start md:w-full', section === id && 'bg-accent text-accent-foreground')}
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => select(id)}
                >
                  <Icon />
                  <span>{t(`sandbox.env.section.${id}.label`)}</span>
                  {count !== undefined && (
                    <span className={cn('ml-auto pl-2 text-xs tabular-nums', section === id ? 'text-foreground/70' : 'text-muted-foreground')}>{count}</span>
                  )}
                </Button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <section aria-label={t(`sandbox.env.section.${section}.label`)} className="flex min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border">
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="text-sm leading-5 font-semibold">{t(`sandbox.env.section.${section}.label`)}</h2>
              <p className="text-xs leading-4 text-muted-foreground">{t(`sandbox.env.section.${section}.description`)}</p>
            </div>
            {createType && (
              <CreateEntityPopover
                key={createType}
                type={createType}
                operator={operator}
                bots={getSandboxBots(snapshot)}
                side="bottom"
                trigger={<Button size="sm" variant="outline" className="shrink-0"><PlusIcon />{t(`sandbox.create.${createType}`)}</Button>}
              />
            )}
          </header>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={scroller} className="sandbox-env-scroller min-h-0 flex-1 overflow-y-auto">
              {section === 'users' && (
                <DirectoryGrid icon={UserIcon} empty={t('sandbox.env.noUser')}>
                  {directory.users.map((user) => (
                    <EditableCard key={user.id} target={{ type: 'user', id: user.id }} avatar={<SandboxAvatar kind="user" name={user.name} src={user.avatar} className="size-10" />} title={user.name} subtitle={user.id} />
                  ))}
                </DirectoryGrid>
              )}
              {section === 'bots' && (
                <DirectoryGrid icon={BotIcon} empty={t('sandbox.env.noBot')}>
                  {directory.bots.map((bot) => {
                    const card = {
                      avatar: <SandboxAvatar kind="bot" name={bot.name} src={bot.avatar} className="size-10" />,
                      title: bot.name,
                      subtitle: bot.id,
                      meta: (
                        <>
                          <Badge variant="secondary">{implementationLabel(bot.implementation)}</Badge>
                          <Badge variant="outline" className="max-w-40"><span className="truncate">{sourceName(t, bot.source)}</span></Badge>
                          <EnabledStatus enabled={bot.enabled} />
                        </>
                      ),
                    }
                    // 测试空间的机器人属于各自的空间快照，实体弹窗只编辑主环境，这里只读展示。
                    return bot.source.type === 'main'
                      ? <EditableCard key={`main:${bot.id}`} target={{ type: 'bot', id: bot.id }} {...card} />
                      : <DirectoryCard key={`space:${bot.source.spaceId}:${bot.id}`} {...card} />
                  })}
                </DirectoryGrid>
              )}
              {section === 'groups' && (
                <DirectoryGrid icon={UsersIcon} empty={t('sandbox.env.noGroup')}>
                  {directory.groups.map((group) => (
                    <EditableCard
                      key={group.id}
                      target={{ type: 'group', id: group.id }}
                      avatar={<SandboxAvatar kind="group" name={group.name} src={group.avatar} className="size-10" />}
                      title={group.name}
                      subtitle={t('sandbox.env.groupSubtitle', { id: group.id, count: group.members.length })}
                    />
                  ))}
                </DirectoryGrid>
              )}
              {section === 'credentials' && <TestCredentialManager />}
              {section === 'mcp' && <McpCapabilityCatalog catalog={mcp.catalog} loading={mcp.loading} error={mcp.error} onRetry={() => void mcp.load()} />}
              {section === 'http' && <HttpCapabilityCatalog catalog={http.catalog} loading={http.loading} error={http.error} onRetry={() => void http.load()} />}
            </div>
            <OverlayScrollbar target={scroller} className="sandbox-env-scrollbar" />
          </div>
        </section>
      </div>
    </div>
  )
}

/** 目录卡片按面板宽度自动排列，宽屏下多列铺开，不在右侧留下大片空白。 */
function DirectoryGrid({ icon: Icon, empty, children }: { icon: LucideIcon, empty: string, children: React.ReactNode[] }) {
  if (!children.length) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-5" /></span>
        <p className="text-xs text-muted-foreground">{empty}</p>
      </div>
    )
  }
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3 p-4">{children}</div>
}

interface DirectoryCardContent {
  avatar: React.ReactNode
  title: string
  subtitle: string
  meta?: React.ReactNode
}

/** 主环境的实体卡片：点卡片打开编辑，悬停或聚焦时露出编辑与删除，右键菜单提供同样两项。 */
function EditableCard({ target, ...card }: DirectoryCardContent & { target: EntityTarget }) {
  const t = useT()
  const { dialogs } = useSandbox()
  const kind = t(`sandbox.kind.${target.type}`)
  const editLabel = t('sandbox.menu.editEntity', { kind })
  const deleteLabel = t('sandbox.menu.deleteEntity', { kind })
  const edit = () => dialogs.openEntity('edit', target)
  const remove = () => dialogs.openEntity('delete', target)
  return (
    <ContextMenu>
      <ContextMenuTrigger render={(
        <DirectoryCard
          {...card}
          onEdit={edit}
          actions={(
            <>
              <Button size="icon-sm" variant="ghost" aria-label={editLabel} onClick={edit}><PencilIcon /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={deleteLabel} className="hover:text-destructive" onClick={remove}><Trash2Icon /></Button>
            </>
          )}
        />
      )} />
      <ContextMenuContent className="sandbox-glass">
        <ContextMenuItem onClick={edit}><PencilIcon />{editLabel}</ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={remove}><Trash2Icon />{deleteLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 目录卡片。可编辑时标题是撑满整张卡片的按钮（`::after` 铺满），操作按钮叠在它上面，
 * 避免按钮嵌套按钮；焦点环也画在铺满层上，键盘聚焦时整张卡片高亮。
 */
const DirectoryCard = React.forwardRef<HTMLElement, DirectoryCardContent & Omit<React.ComponentProps<'article'>, 'title'> & {
  onEdit?(): void
  actions?: React.ReactNode
}>(function DirectoryCard({ avatar, title, subtitle, meta, onEdit, actions, className, ...props }, ref) {
  return (
    <article
      ref={ref}
      className={cn(
        'relative flex flex-col gap-3 rounded-xl bg-muted/30 p-3.5 ring-1 ring-border/70',
        onEdit && 'group transition-[background-color,box-shadow] duration-150 hover:bg-muted/60 hover:ring-border',
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-3">
        {avatar}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {onEdit ? (
            <button
              type="button"
              className="block w-full truncate text-left text-[13px] leading-5 font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
              onClick={onEdit}
            >
              {title}
            </button>
          ) : <strong className="truncate text-[13px] leading-5 font-medium">{title}</strong>}
          <small className="truncate text-xs leading-4 text-muted-foreground tabular-nums">{subtitle}</small>
        </span>
        {actions && (
          <span className="relative z-10 -my-1 -mr-1.5 flex shrink-0 items-center gap-0.5 self-start text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
            {actions}
          </span>
        )}
      </div>
      {meta && <div className="flex flex-wrap items-center gap-1.5">{meta}</div>}
    </article>
  )
})

function EnabledStatus({ enabled }: { enabled: boolean }) {
  const t = useT()
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
      <span aria-hidden className={cn('size-1.5 rounded-full', enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
      {t(enabled ? 'sandbox.env.enabled' : 'sandbox.env.disabled')}
    </span>
  )
}

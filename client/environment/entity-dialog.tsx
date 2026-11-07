import * as React from 'react'
import { CheckIcon, PencilIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@chatluna/ui-kit'
import type { SandboxBotPresetCatalog } from '../../src/console-contract'
import { getOneBotProfileBaseline } from '../../src/onebot-profiles'
import {
  getSandboxBots,
  getSandboxUsers,
  type ManageSandboxEnvironmentInput,
  type SandboxAccountSex,
  type SandboxGroupMember,
  type SandboxImplementationProfile,
} from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { useDiscardConfirm } from '../shared/discard-confirm'
import { OverlayScrollbar } from '../shared/overlay-scrollbar'
import { useSandbox, useWorkspace } from '../workspace/context'
import { errorText, invoke } from '../workspace/store'
import { AvatarChoices } from './avatar-picker'
import { ImplementationSelect } from './create-popover'
import './entity-dialog.css'

export interface EntityDialogTarget {
  type: 'user' | 'bot' | 'group'
  id: string
}

interface Draft {
  id: string
  name: string
  avatar: string
  personalNote: string
  sex: 'unset' | SandboxAccountSex
  implementation: SandboxImplementationProfile
  enabled: boolean
  disabledCapabilities: string[]
  members: SandboxGroupMember[]
}

/** 「跟随路由规则」的选项值；预设 ID 由 v2 按文件名生成，不含冒号，不会与它撞上。 */
const FOLLOW_ROUTE = 'onebot-sandbox:follow-route'

/** 机器人的预设选项：未读取、服务未加载、读取失败或读到的目录。 */
type PresetState =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; catalog: SandboxBotPresetCatalog }

const EMPTY_DRAFT: Draft = {
  id: '', name: '', avatar: '', personalNote: '', sex: 'unset', implementation: 'napcat', enabled: true, disabledCapabilities: [], members: [],
}

/** 编辑或删除一个用户、机器人或群组。ID 创建后不可修改；删除会连带清理相关会话与关系。 */
export function EntityDialog({ open, mode, target, onOpenChange }: {
  open: boolean
  mode: 'edit' | 'delete'
  target?: EntityDialogTarget
  onOpenChange(open: boolean): void
}) {
  const t = useT()
  const { store } = useSandbox()
  const { snapshot, resolveAvatar } = useWorkspace()
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT)
  // 打开时的草稿，与当前草稿比较得出是否有未保存修改。
  const [initial, setInitial] = React.useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [picking, setPicking] = React.useState(false)
  const [capabilitySearch, setCapabilitySearch] = React.useState('')
  const [editingMemberId, setEditingMemberId] = React.useState('')
  // 预设不在场景快照里，打开时另外读取，所以不进 Draft：读到之前两份都是 FOLLOW_ROUTE，选单禁用。
  const [presetState, setPresetState] = React.useState<PresetState>({ status: 'loading' })
  const [preset, setPreset] = React.useState(FOLLOW_ROUTE)
  const [initialPreset, setInitialPreset] = React.useState(FOLLOW_ROUTE)
  const scroller = React.useRef<HTMLDivElement>(null)
  const capabilityScroller = React.useRef<HTMLDivElement>(null)
  const users = getSandboxUsers(snapshot)
  const bots = getSandboxBots(snapshot)
  const participants = [
    ...users.map((user) => ({ ...user, type: 'user' as const })),
    ...bots.map((bot) => ({ ...bot, type: 'bot' as const })),
  ]
  const entity = target?.type === 'group'
    ? snapshot.groups.find(({ id }) => id === target.id)
    : snapshot.participants.find(({ id }) => id === target?.id)

  const reset = (next: Draft) => {
    setDraft(next)
    setInitial(next)
  }
  const dirty = mode === 'edit' && (JSON.stringify(draft) !== JSON.stringify(initial) || preset !== initialPreset)
  const { requestClose, confirm } = useDiscardConfirm(dirty, () => onOpenChange(false))

  React.useEffect(() => {
    if (!open || !target) return
    setError('')
    setPicking(false)
    setCapabilitySearch('')
    setEditingMemberId('')
    if (target.type === 'group') {
      const group = snapshot.groups.find(({ id }) => id === target.id)
      if (group) reset({ ...EMPTY_DRAFT, id: group.id, name: group.name, avatar: group.avatar ?? '', members: group.members.map((member) => ({ ...member })) })
      return
    }
    const participant = snapshot.participants.find(({ id }) => id === target.id)
    if (!participant) return
    reset({
      ...EMPTY_DRAFT,
      id: participant.id,
      name: participant.name,
      avatar: participant.avatar ?? '',
      personalNote: participant.profile?.personalNote ?? '',
      sex: participant.profile?.sex ?? 'unset',
      ...(participant.kind === 'bot' ? {
        implementation: participant.implementation,
        enabled: participant.enabled,
        disabledCapabilities: participant.disabledCapabilities ?? [],
      } : {}),
    })
    // 打开时取一次快照作为草稿；编辑期间的场景刷新不覆盖用户正在输入的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.type, target?.id])

  React.useEffect(() => {
    setPreset(FOLLOW_ROUTE)
    setInitialPreset(FOLLOW_ROUTE)
    if (!open || mode !== 'edit' || target?.type !== 'bot') return
    const botId = target.id
    let active = true
    setPresetState({ status: 'loading' })
    invoke('onebot-sandbox.bot-presets', undefined).then((catalog) => {
      if (!active) return
      const assigned = catalog.assignments.find((assignment) => assignment.botId === botId)?.presetId ?? FOLLOW_ROUTE
      setPresetState({ status: 'ready', catalog })
      setPreset(assigned)
      setInitialPreset(assigned)
    }, (failure) => {
      if (active) setPresetState({ status: 'failed', error: errorText(failure) })
    })
    return () => { active = false }
  }, [open, mode, target?.type, target?.id])

  /** `prepare` 先于环境变更执行：预设依赖外部服务，更容易失败，失败时整次保存都不落地。 */
  const runAction = async (input: ManageSandboxEnvironmentInput, prepare?: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await prepare?.()
      await store.manageEnvironment(input)
      onOpenChange(false)
    } catch (failure) {
      setError(errorText(failure, t('sandbox.entity.failed')))
    } finally {
      setBusy(false)
    }
  }

  const accountProfile = () => {
    const profile = {
      ...(draft.personalNote.trim() ? { personalNote: draft.personalNote.trim() } : {}),
      ...(draft.sex !== 'unset' ? { sex: draft.sex } : {}),
    }
    return Object.keys(profile).length ? profile : undefined
  }

  const submitEdit = (event: React.FormEvent) => {
    event.preventDefault()
    if (target?.type === 'user') {
      void runAction({ action: 'update-user', data: { id: draft.id, name: draft.name, avatar: draft.avatar, profile: accountProfile() } })
    } else if (target?.type === 'bot') {
      void runAction({
        action: 'update-bot',
        data: {
          id: draft.id,
          name: draft.name,
          implementation: draft.implementation,
          enabled: draft.enabled,
          disabledCapabilities: [...draft.disabledCapabilities],
          avatar: draft.avatar,
          profile: accountProfile(),
        },
      }, preset === initialPreset ? undefined : async () => {
        await invoke('onebot-sandbox.set-bot-preset', {
          botId: draft.id,
          presetId: preset === FOLLOW_ROUTE ? null : preset,
          ...(store.spaceId ? { spaceId: store.spaceId } : {}),
        })
        setInitialPreset(preset)
      })
    } else if (target?.type === 'group') {
      void runAction({ action: 'update-group', data: { id: draft.id, name: draft.name, avatar: draft.avatar, members: draft.members.map((member) => ({ ...member })) } })
    }
  }

  const submitDelete = () => {
    if (!target) return
    void runAction({ action: `delete-${target.type}`, data: { id: target.id } } as ManageSandboxEnvironmentInput)
  }

  const memberOf = (participantId: string) => draft.members.find((member) => member.participantId === participantId)
  const toggleMember = (participantId: string) => {
    if (memberOf(participantId)) {
      setDraft((value) => ({ ...value, members: value.members.filter((member) => member.participantId !== participantId) }))
      if (editingMemberId === participantId) setEditingMemberId('')
      return
    }
    const participant = participants.find(({ id }) => id === participantId)
    if (!participant) return
    setDraft((value) => ({
      ...value,
      members: [...value.members, { participantId, card: participant.name, role: value.members.some(({ role }) => role === 'owner') ? 'member' : 'owner' }],
    }))
  }
  const patchMember = (participantId: string, patch: Partial<SandboxGroupMember>) => setDraft((value) => ({
    ...value,
    members: value.members.map((member) => member.participantId === participantId ? { ...member, ...patch } : member),
  }))

  const baseline = getOneBotProfileBaseline(draft.implementation)
  const query = capabilitySearch.trim().toLowerCase()
  const capabilities = query
    ? baseline.capabilities.filter((capability) => [capability.id, capability.action, capability.description, capability.reason, ...(capability.aliases ?? [])]
      .some((value) => value?.toLowerCase().includes(query)))
    : baseline.capabilities
  const supportedCapabilityCount = baseline.capabilities.filter(({ supported }) => supported).length
  const enabledCapabilityCount = baseline.capabilities.filter(({ id, supported }) => supported && !draft.disabledCapabilities.includes(id)).length
  const type = target?.type ?? 'user'
  const entityLabel = t(`sandbox.kind.${type}`)
  const editingParticipant = participants.find(({ id }) => id === editingMemberId)
  const editingMember = memberOf(editingMemberId)
  const presetItems = presetState.status === 'ready' ? [
    { value: FOLLOW_ROUTE, label: t('sandbox.entity.presetFollowRoute') },
    ...presetState.catalog.presets.map(({ id, name, status }) => {
      const label = name === id ? id : `${name}（${id}）`
      return { value: id, label: status === 'error' ? t('sandbox.entity.presetError', { name: label }) : label }
    }),
    // 规则指向的预设已被删掉时仍列出并标明，否则选单显示空白，也无从看出该恢复默认。
    ...(preset !== FOLLOW_ROUTE && !presetState.catalog.presets.some(({ id }) => id === preset)
      ? [{ value: preset, label: t('sandbox.entity.presetMissing', { id: preset }) }]
      : []),
  ] : [{ value: FOLLOW_ROUTE, label: t('sandbox.entity.presetFollowRoute') }]
  const presetReady = presetState.status === 'ready' && presetState.catalog.available
  const presetHint = presetState.status === 'loading'
    ? t('sandbox.entity.presetLoading')
    : presetState.status === 'failed'
      ? t('sandbox.entity.presetFailed', { error: presetState.error })
      : presetState.catalog.available ? t('sandbox.entity.presetHint') : t('sandbox.entity.presetUnavailable')
  const roleItems = [
    { value: 'owner', label: t('sandbox.role.owner') },
    { value: 'admin', label: t('sandbox.role.admin') },
    { value: 'member', label: t('sandbox.role.member') },
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : requestClose()}>
      <DialogContent className={cn('flex flex-col overflow-hidden', mode === 'edit' && 'sm:max-w-lg')}>
        <DialogHeader>
          <DialogTitle>{t(mode === 'edit' ? 'sandbox.entity.editTitle' : 'sandbox.entity.deleteTitle', { kind: entityLabel })}</DialogTitle>
          <DialogDescription>{t(mode === 'edit' ? 'sandbox.entity.editHint' : 'sandbox.entity.deleteHint')}</DialogDescription>
        </DialogHeader>
        {mode === 'delete' ? (
          <>
            <div className="flex flex-col gap-4">
              <p className="text-[13px] leading-6">
                {t(target?.type === 'user' ? 'sandbox.entity.deleteUser' : 'sandbox.entity.deleteOther', { kind: entityLabel, name: entity?.name ?? target?.id ?? '' })}
              </p>
              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t('sandbox.common.cancel')}</Button>
              <Button variant="destructive" disabled={busy} onClick={submitDelete}>{busy ? t('sandbox.entity.deleting') : t('sandbox.entity.confirmDelete')}</Button>
            </DialogFooter>
          </>
        ) : (
          // 三段式：页头与页脚固定，只有正文滚动；视口很矮时正文先收缩，不会滚到透明的毛玻璃页头下面。
          <form className="flex min-h-0 flex-col gap-4" onSubmit={submitEdit}>
            <div className="sandbox-entity-body">
              <div ref={scroller} className="sandbox-entity-scroller">
                <div className="sandbox-entity-hero">
                  <button type="button" className="sandbox-entity-avatar" aria-label={t('sandbox.avatar.change')} onClick={() => setPicking(true)}>
                    <SandboxAvatar kind={type} name={draft.name} src={resolveAvatar(draft.avatar)} className="sandbox-entity-avatar-image" badge={false} />
                    <span className="sandbox-entity-avatar-edit" aria-hidden><PencilIcon /></span>
                  </button>
                  <div className="sandbox-entity-identity">
                    <strong className={cn('sandbox-entity-name', !draft.name.trim() && 'is-empty')}>{draft.name.trim() || t(`sandbox.field.name.${type}`)}</strong>
                    <span className="sandbox-entity-id">{type === 'group' ? t('sandbox.field.groupId') : t('sandbox.field.qqId')} {draft.id}</span>
                  </div>
                </div>
                <section className="sandbox-entity-section">
                  <h3 className="sandbox-entity-section-title">{t('sandbox.entity.section.basic')}</h3>
                  <div className="sandbox-entity-grid">
                    <div className={cn('sandbox-entity-field', type === 'group' && 'is-wide')}>
                      <Label htmlFor="sandbox-entity-name">{t(`sandbox.field.name.${type}`)}</Label>
                      <Input id="sandbox-entity-name" required value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
                    </div>
                    {type !== 'group' && (
                      <>
                        <div className="sandbox-entity-field">
                          <Label>{t('sandbox.field.sex')}</Label>
                          <Select
                            value={draft.sex}
                            onValueChange={(value) => value && setDraft((current) => ({ ...current, sex: value === 'unset' ? 'unset' : value === 'male' ? 'male' : value === 'female' ? 'female' : 'unknown' }))}
                            items={['unset', 'unknown', 'male', 'female'].map((value) => ({ value, label: t(`sandbox.sex.${value}`) }))}
                          >
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent className="sandbox-glass">
                              {['unset', 'unknown', 'male', 'female'].map((value) => <SelectItem key={value} value={value}>{t(`sandbox.sex.${value}`)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="sandbox-entity-field is-wide">
                          <Label htmlFor="sandbox-entity-note">{t('sandbox.field.personalNote')}</Label>
                          <Input
                            id="sandbox-entity-note"
                            placeholder={t('sandbox.field.personalNotePlaceholder')}
                            value={draft.personalNote}
                            onChange={(event) => setDraft((value) => ({ ...value, personalNote: event.target.value }))}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </section>
                {type === 'bot' && (
                  <section className="sandbox-entity-section">
                    <h3 className="sandbox-entity-section-title">{t('sandbox.entity.section.runtime')}</h3>
                    <label className="sandbox-entity-toggle">
                      <span>{t('sandbox.field.botEnabled')}</span>
                      <Switch checked={draft.enabled} onCheckedChange={(value) => setDraft((current) => ({ ...current, enabled: value === true }))} />
                    </label>
                    <ImplementationSelect value={draft.implementation} onChange={(implementation) => setDraft((value) => ({ ...value, implementation }))} />
                    <div className="sandbox-entity-field">
                      <Label>{t('sandbox.entity.preset')}</Label>
                      <Select value={preset} disabled={!presetReady} onValueChange={(value) => value && setPreset(value)} items={presetItems}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent className="sandbox-glass">
                          {presetItems.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <p className={cn('sandbox-entity-hint', presetState.status === 'failed' && 'is-error')}>{presetHint}</p>
                    </div>
                    <div className="sandbox-entity-field">
                      <div className="sandbox-entity-section-title">
                        <Label>{t('sandbox.entity.capabilities')}</Label>
                        <span className="sandbox-entity-section-meta">{t('sandbox.entity.capabilityCount', { enabled: enabledCapabilityCount, total: supportedCapabilityCount })}</span>
                      </div>
                      <div className="relative">
                        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input type="search" className="sandbox-search-input pl-8!" value={capabilitySearch} placeholder={t('sandbox.entity.capabilitySearch')} aria-label={t('sandbox.entity.capabilitySearch')} onChange={(event) => setCapabilitySearch(event.target.value)} />
                      </div>
                      <div className="sandbox-entity-capabilities">
                        <div ref={capabilityScroller} className="sandbox-entity-capability-list">
                          {capabilities.map((capability) => (
                            <label key={capability.id} className={cn('sandbox-entity-capability', !capability.supported && 'is-unsupported')}>
                              <Checkbox
                                className="mt-0.5"
                                checked={capability.supported && !draft.disabledCapabilities.includes(capability.id)}
                                disabled={!capability.supported}
                                onCheckedChange={(checked) => setDraft((value) => ({
                                  ...value,
                                  disabledCapabilities: checked === true
                                    ? value.disabledCapabilities.filter((id) => id !== capability.id)
                                    : [...new Set([...value.disabledCapabilities, capability.id])],
                                }))}
                              />
                              <span className="sandbox-entity-capability-text">
                                <span className="sandbox-entity-capability-action">
                                  {capability.action}
                                  <Badge variant="secondary" className="text-[10px]">{t(capability.surface === 'standard' ? 'sandbox.entity.standard' : 'sandbox.entity.native')}</Badge>
                                </span>
                                <span className="sandbox-entity-capability-description">{capability.description}</span>
                                {(capability.aliases?.length || !capability.supported) && (
                                  <small className="sandbox-entity-capability-note">
                                    {capability.aliases?.length ? t('sandbox.entity.aliases', { aliases: capability.aliases.join('、') }) : ''}
                                    {capability.aliases?.length && !capability.supported ? ' · ' : ''}
                                    {!capability.supported ? capability.reason : ''}
                                  </small>
                                )}
                              </span>
                            </label>
                          ))}
                          {!capabilities.length && <p className="sandbox-entity-empty">{t('sandbox.entity.noCapability')}</p>}
                        </div>
                        <OverlayScrollbar target={capabilityScroller} className="sandbox-entity-capability-scrollbar" />
                      </div>
                    </div>
                  </section>
                )}
                {type === 'group' && (
                  <section className="sandbox-entity-section">
                    <h3 className="sandbox-entity-section-title">
                      <span>{t('sandbox.entity.members')}</span>
                      <span className="sandbox-entity-section-meta">{draft.members.length} / {participants.length}</span>
                    </h3>
                    <p className="sandbox-entity-hint">{t('sandbox.entity.membersHint')}</p>
                    <div className="sandbox-entity-members">
                      {participants.map((participant) => {
                        const member = memberOf(participant.id)
                        return (
                          <article key={participant.id} className={cn('sandbox-entity-member', member && 'is-member', editingMemberId === participant.id && 'is-editing')}>
                            <button
                              type="button"
                              className="sandbox-entity-member-toggle"
                              aria-pressed={!!member}
                              aria-label={t(member ? 'sandbox.entity.removeMember' : 'sandbox.entity.addMember', { name: participant.name, id: participant.id })}
                              onClick={() => toggleMember(participant.id)}
                            >
                              <span className="sandbox-entity-member-avatar">
                                <SandboxAvatar kind={participant.type} name={participant.name} src={resolveAvatar(participant.avatar)} className="size-8" />
                                <span className="sandbox-entity-member-marker" aria-hidden>{member ? <CheckIcon /> : <PlusIcon />}</span>
                              </span>
                              <span className="sandbox-entity-member-text">
                                <strong>{participant.name}</strong>
                                <small>{member ? `${member.card || t('sandbox.entity.noCard')} · ${t(`sandbox.role.${member.role}`)}` : participant.id}</small>
                              </span>
                            </button>
                            {member && (
                              <Button type="button" variant="ghost" size="icon-xs" aria-label={t('sandbox.entity.editMember', { name: participant.name })} onClick={() => setEditingMemberId(participant.id)}>
                                <PencilIcon />
                              </Button>
                            )}
                          </article>
                        )
                      })}
                    </div>
                    {editingParticipant && editingMember && (
                      <div className="sandbox-entity-member-editor">
                        <div className="sandbox-entity-member-editor-head">
                          <SandboxAvatar kind={editingParticipant.type} name={editingParticipant.name} src={resolveAvatar(editingParticipant.avatar)} className="size-7" />
                          <span className="sandbox-entity-member-text flex-1">
                            <strong>{editingParticipant.name}</strong>
                            <small>{editingParticipant.id}</small>
                          </span>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('sandbox.common.close')} onClick={() => setEditingMemberId('')}><XIcon /></Button>
                        </div>
                        <div className="sandbox-entity-grid">
                          <div className="sandbox-entity-field">
                            <Label>{t('sandbox.entity.card')}</Label>
                            <Input value={editingMember.card ?? ''} onChange={(event) => patchMember(editingParticipant.id, { card: event.target.value })} />
                          </div>
                          <div className="sandbox-entity-field">
                            <Label>{t('sandbox.entity.role')}</Label>
                            <Select
                              value={editingMember.role}
                              onValueChange={(value) => value && patchMember(editingParticipant.id, { role: value === 'owner' ? 'owner' : value === 'admin' ? 'admin' : 'member' })}
                              items={roleItems}
                            >
                              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                              <SelectContent className="sandbox-glass">
                                {roleItems.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>
                    )}
                    {!draft.members.length && <p className="text-xs text-destructive">{t('sandbox.entity.needOwner')}</p>}
                  </section>
                )}
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
              </div>
              <OverlayScrollbar target={scroller} className="sandbox-entity-scrollbar" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={requestClose}>{t('sandbox.common.cancel')}</Button>
              <Button type="submit" disabled={busy}>{busy ? t('sandbox.common.saving') : t('sandbox.common.save')}</Button>
            </DialogFooter>
          </form>
        )}
        {target && (
          <Dialog open={picking} onOpenChange={setPicking}>
            <DialogContent className="flex flex-col overflow-hidden sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{t('sandbox.avatar.title')}</DialogTitle>
                <DialogDescription>{t('sandbox.avatar.description')}</DialogDescription>
              </DialogHeader>
              <div className="-mx-5 min-h-0 overflow-y-auto px-5">
                <AvatarChoices kind={target.type} onSelect={(avatar) => {
                  setDraft((value) => ({ ...value, avatar }))
                  setPicking(false)
                }} />
              </div>
            </DialogContent>
          </Dialog>
        )}
        {confirm}
      </DialogContent>
    </Dialog>
  )
}

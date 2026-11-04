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
} from '@chatluna/ui-kit'
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
import { useSandbox, useWorkspace } from '../workspace/context'
import { errorText } from '../workspace/store'
import { AvatarChoices } from './avatar-picker'
import { ImplementationSelect } from './create-popover'

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
  const dirty = mode === 'edit' && JSON.stringify(draft) !== JSON.stringify(initial)
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

  const runAction = async (input: ManageSandboxEnvironmentInput) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
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
  const entityLabel = t(`sandbox.kind.${target?.type ?? 'user'}`)
  const editingParticipant = participants.find(({ id }) => id === editingMemberId)
  const editingMember = memberOf(editingMemberId)
  const roleItems = [
    { value: 'owner', label: t('sandbox.role.owner') },
    { value: 'admin', label: t('sandbox.role.admin') },
    { value: 'member', label: t('sandbox.role.member') },
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : requestClose()}>
      <DialogContent className={cn('sandbox-glass flex flex-col overflow-hidden', mode === 'edit' && 'sm:max-w-lg')}>
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
            <div className="-mx-5 flex max-h-[62vh] min-h-0 flex-col gap-4 overflow-y-auto px-5">
              <button type="button" className="group flex items-center gap-3 self-start rounded-lg" aria-label={t('sandbox.avatar.title')} onClick={() => setPicking(true)}>
                <SandboxAvatar kind={target?.type ?? 'user'} name={draft.name} src={resolveAvatar(draft.avatar)} className="size-12" badge={false} />
                <span className="text-xs text-muted-foreground group-hover:text-foreground">{t('sandbox.avatar.change')}</span>
              </button>
              <div className="flex flex-col gap-2">
                <Label>{target?.type === 'group' ? t('sandbox.field.groupId') : t('sandbox.field.qqId')}</Label>
                <Input value={draft.id} disabled />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="sandbox-entity-name">{t(`sandbox.field.name.${target?.type ?? 'user'}`)}</Label>
                <Input id="sandbox-entity-name" required value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
              </div>
              {target?.type !== 'group' && (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="sandbox-entity-note">{t('sandbox.field.personalNote')}</Label>
                    <Input
                      id="sandbox-entity-note"
                      placeholder={t('sandbox.field.personalNotePlaceholder')}
                      value={draft.personalNote}
                      onChange={(event) => setDraft((value) => ({ ...value, personalNote: event.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
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
                </>
              )}
              {target?.type === 'bot' && (
                <>
                  <ImplementationSelect value={draft.implementation} onChange={(implementation) => setDraft((value) => ({ ...value, implementation }))} />
                  <div className="flex flex-col gap-2">
                    <Label>{t('sandbox.entity.capabilities')}</Label>
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input className="pl-8!" value={capabilitySearch} placeholder={t('sandbox.entity.capabilitySearch')} aria-label={t('sandbox.entity.capabilitySearch')} onChange={(event) => setCapabilitySearch(event.target.value)} />
                    </div>
                    <div className="h-56 overflow-y-auto rounded-lg border border-border">
                      <div className="flex flex-col p-1">
                        {capabilities.map((capability) => (
                          <label key={capability.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/60">
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
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="flex items-center gap-1.5">
                                <span className="font-mono text-xs">{capability.action}</span>
                                <Badge variant="secondary" className="text-[10px]">{t(capability.surface === 'standard' ? 'sandbox.entity.standard' : 'sandbox.entity.native')}</Badge>
                              </span>
                              <span className="text-xs text-muted-foreground">{capability.description}</span>
                              {(capability.aliases?.length || !capability.supported) && (
                                <small className="text-[11px] text-muted-foreground">
                                  {capability.aliases?.length ? t('sandbox.entity.aliases', { aliases: capability.aliases.join('、') }) : ''}
                                  {capability.aliases?.length && !capability.supported ? ' · ' : ''}
                                  {!capability.supported ? capability.reason : ''}
                                </small>
                              )}
                            </span>
                          </label>
                        ))}
                        {!capabilities.length && <p className="p-3 text-center text-xs text-muted-foreground">{t('sandbox.entity.noCapability')}</p>}
                      </div>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[13px]">
                    <Checkbox checked={draft.enabled} onCheckedChange={(value) => setDraft((current) => ({ ...current, enabled: value === true }))} />
                    {t('sandbox.field.botEnabled')}
                  </label>
                </>
              )}
              {target?.type === 'group' && (
                <section className="flex flex-col gap-3">
                  <div className="flex items-end justify-between">
                    <div className="flex flex-col gap-1">
                      <strong className="text-[13px] font-medium">{t('sandbox.entity.members')}</strong>
                      <p className="text-xs text-muted-foreground">{t('sandbox.entity.membersHint')}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{draft.members.length} / {participants.length}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {participants.map((participant) => {
                      const member = memberOf(participant.id)
                      return (
                        <article key={participant.id} className="relative flex items-center gap-2 rounded-lg border border-border p-2 data-[member=true]:border-primary/50 data-[member=true]:bg-primary/5" data-member={!!member}>
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            aria-pressed={!!member}
                            aria-label={t(member ? 'sandbox.entity.removeMember' : 'sandbox.entity.addMember', { name: participant.name, id: participant.id })}
                            onClick={() => toggleMember(participant.id)}
                          >
                            <span className="relative">
                              <SandboxAvatar kind={participant.type} name={participant.name} src={resolveAvatar(participant.avatar)} className="size-8" />
                              <span className="absolute -top-1 -left-1 flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border">
                                {member ? <CheckIcon className="size-3 text-primary" /> : <PlusIcon className="size-3 text-muted-foreground" />}
                              </span>
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <strong className="truncate text-xs font-medium">{participant.name}</strong>
                              <small className="truncate text-[11px] text-muted-foreground">
                                {member ? `${member.card || t('sandbox.entity.noCard')} · ${t(`sandbox.role.${member.role}`)}` : participant.id}
                              </small>
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
                    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                      <div className="flex items-center gap-2">
                        <SandboxAvatar kind={editingParticipant.type} name={editingParticipant.name} src={resolveAvatar(editingParticipant.avatar)} className="size-7" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <strong className="truncate text-xs font-medium">{editingParticipant.name}</strong>
                          <small className="text-[11px] text-muted-foreground">{editingParticipant.id}</small>
                        </span>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={t('sandbox.common.close')} onClick={() => setEditingMemberId('')}><XIcon /></Button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-2">
                          <Label>{t('sandbox.entity.card')}</Label>
                          <Input value={editingMember.card ?? ''} onChange={(event) => patchMember(editingParticipant.id, { card: event.target.value })} />
                        </div>
                        <div className="flex flex-col gap-2">
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
            <DialogFooter>
              <Button type="button" variant="outline" onClick={requestClose}>{t('sandbox.common.cancel')}</Button>
              <Button type="submit" disabled={busy}>{busy ? t('sandbox.common.saving') : t('sandbox.common.save')}</Button>
            </DialogFooter>
          </form>
        )}
        {target && (
          <Dialog open={picking} onOpenChange={setPicking}>
            <DialogContent className="sandbox-glass flex flex-col overflow-hidden sm:max-w-md">
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

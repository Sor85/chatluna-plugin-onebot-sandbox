import * as React from 'react'
import {
  Button,
  Checkbox,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@chatluna/ui-kit'
import type { ManageSandboxEnvironmentInput, SandboxBotProfile, SandboxImplementationProfile, SandboxParticipant } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { useSandbox } from '../workspace/context'
import { errorText } from '../workspace/store'
import { AvatarPicker } from './avatar-picker'
import { implementationOptions } from '../shared/implementation'

export type EnvironmentCreateType = 'user' | 'bot' | 'group' | 'participant'

/**
 * 快速创建测试实体的浮层。`participant` 允许在用户与机器人之间切换，供发送框的头像栈使用；
 * 建群时当前操作者成为群主、全部机器人自动入群，与源插件的默认场景口径一致。
 */
export function CreateEntityPopover({ type, operator, bots = [], side = 'right', trigger, onOpenChange }: {
  type: EnvironmentCreateType
  operator?: Pick<SandboxParticipant, 'id' | 'name'>
  bots?: Pick<SandboxBotProfile, 'id' | 'name'>[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  trigger: React.ReactElement
  onOpenChange?(open: boolean): void
}) {
  const t = useT()
  const { store } = useSandbox()
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [picking, setPicking] = React.useState(false)
  const [participantType, setParticipantType] = React.useState<'user' | 'bot'>('user')
  const [implementation, setImplementation] = React.useState<SandboxImplementationProfile>('napcat')
  const [enabled, setEnabled] = React.useState(true)
  const [draft, setDraft] = React.useState({ id: '', name: '', avatar: '', personalNote: '' })
  const kind = type === 'participant' ? participantType : type
  const canCreateGroup = !!operator && bots.length > 0

  const changeOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
    if (!next) return
    setError('')
    setPicking(false)
    setDraft({ id: '', name: '', avatar: '', personalNote: '' })
    setParticipantType('user')
    setImplementation('napcat')
    setEnabled(true)
  }

  const buildInput = (): ManageSandboxEnvironmentInput | undefined => {
    const profile = draft.personalNote.trim() ? { personalNote: draft.personalNote.trim() } : undefined
    const avatar = draft.avatar ? { avatar: draft.avatar } : {}
    if (kind === 'user') return { action: 'create-user', data: { id: draft.id, name: draft.name, ...avatar, ...(profile ? { profile } : {}) } }
    if (kind === 'bot') {
      return { action: 'create-bot', data: { id: draft.id, name: draft.name, implementation, enabled, ...avatar, ...(profile ? { profile } : {}) } }
    }
    if (!operator || !bots.length) return undefined
    return {
      action: 'create-group',
      data: {
        id: draft.id,
        name: draft.name,
        ...avatar,
        members: [
          { participantId: operator.id, card: operator.name, role: 'owner' },
          ...bots.filter(({ id }) => id !== operator.id).map((bot) => ({ participantId: bot.id, card: bot.name, role: 'member' as const })),
        ],
      },
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    const input = buildInput()
    if (!input) return
    setBusy(true)
    setError('')
    try {
      await store.manageEnvironment(input)
      changeOpen(false)
    } catch (failure) {
      setError(errorText(failure, t('sandbox.create.failed')))
    } finally {
      setBusy(false)
    }
  }

  const title = type === 'participant' ? t('sandbox.create.participant') : t(`sandbox.create.${type}`)
  const description = kind === 'user'
    ? t('sandbox.create.userHint')
    : kind === 'bot'
      ? t('sandbox.create.botHint')
      : !operator
        ? t('sandbox.create.groupNoOperator')
        : !bots.length
          ? t('sandbox.create.groupNoBot')
          : t('sandbox.create.groupHint', { name: operator.name })

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent side={side} align="start" className="sandbox-glass w-80 gap-4 p-4" aria-label={title}>
        {picking ? (
          <AvatarPicker kind={kind} onBack={() => setPicking(false)} onSelect={(avatar) => {
            setDraft((value) => ({ ...value, avatar }))
            setPicking(false)
          }} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex items-center gap-3">
              <button type="button" className="group relative rounded-full" aria-label={t('sandbox.avatar.title')} onClick={() => setPicking(true)}>
                <SandboxAvatar kind={kind} name={draft.name} src={draft.avatar} className="size-12" badge={false} />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {t('sandbox.avatar.change')}
                </span>
              </button>
              <header className="flex min-w-0 flex-col gap-1">
                <strong className="text-sm font-medium">{title}</strong>
                <p className="text-xs leading-5 text-muted-foreground">{description}</p>
              </header>
            </div>
            {type === 'participant' && (
              <div className="flex flex-col gap-2">
                <Label>{t('sandbox.create.accountType')}</Label>
                <Select
                  value={participantType}
                  onValueChange={(value) => value && setParticipantType(value === 'bot' ? 'bot' : 'user')}
                  items={[{ value: 'user', label: t('sandbox.kind.user') }, { value: 'bot', label: t('sandbox.kind.bot') }]}
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="sandbox-glass">
                    <SelectItem value="user">{t('sandbox.kind.user')}</SelectItem>
                    <SelectItem value="bot">{t('sandbox.kind.bot')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="sandbox-create-id">{kind === 'group' ? t('sandbox.field.groupId') : t('sandbox.field.qqId')}</Label>
              <Input
                id="sandbox-create-id"
                inputMode="numeric"
                pattern="[0-9]+"
                required
                value={draft.id}
                onChange={(event) => setDraft((value) => ({ ...value, id: event.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sandbox-create-name">{t(`sandbox.field.name.${kind}`)}</Label>
              <Input
                id="sandbox-create-name"
                required
                value={draft.name}
                onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
              />
            </div>
            {kind !== 'group' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="sandbox-create-note">{t('sandbox.field.personalNote')}</Label>
                <Input
                  id="sandbox-create-note"
                  placeholder={t('sandbox.field.optional')}
                  value={draft.personalNote}
                  onChange={(event) => setDraft((value) => ({ ...value, personalNote: event.target.value }))}
                />
              </div>
            )}
            {kind === 'bot' && (
              <>
                <ImplementationSelect value={implementation} onChange={setImplementation} />
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
                  {t('sandbox.field.botEnabled')}
                </label>
              </>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || (kind === 'group' && !canCreateGroup)}>
              {busy ? t('sandbox.create.busy') : t(`sandbox.create.${kind}`)}
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ImplementationSelect({ value, onChange }: {
  value: SandboxImplementationProfile
  onChange(value: SandboxImplementationProfile): void
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-2">
      <Label>{t('sandbox.field.implementation')}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          const option = implementationOptions.find(({ value }) => value === next)
          if (option) onChange(option.value)
        }}
        items={implementationOptions}
      >
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent className="sandbox-glass">
          {implementationOptions.map(({ value, label }) => (
            <SelectItem key={value} value={value}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

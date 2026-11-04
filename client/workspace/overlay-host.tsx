import * as React from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@chatluna/ui-kit'
import { useT } from '../i18n'
import { EntityDialog, type EntityDialogTarget } from '../environment/entity-dialog'
import { SandboxAvatar } from '../shared/avatar'
import { useDiscardConfirm } from '../shared/discard-confirm'
import { useRetained } from '../shared/use-retained'
import { clampFloatingPanelPosition, getFloatingPanelPosition, isFloatingPanelInteractiveTarget } from '../shared/floating-panel'
import { buildGroupProfileCardModel, buildProfileCardModel, groupProfileCardFields, type ProfileCardModel } from '../webqq/profile-card'
import type { SandboxDialogs } from './context'
import { errorText, type WorkspaceStore } from './store'
import { useSandbox, useWorkspace } from './context'

type TextDialog =
  | { kind: 'remark', targetId: string, value: string }
  | { kind: 'card' | 'name' | 'title', targetId: string, groupId: string, value: string }
  | { kind: 'rename', conversationId: string, value: string }

export interface OverlayState {
  entity?: { mode: 'edit' | 'delete', target: EntityDialogTarget }
  text?: TextDialog
  profile?: { card: ProfileCardModel, x: number, y: number }
}

/** 二级面的打开意图：工作区把它们收成一份状态，由 {@link OverlayHost} 统一渲染。 */
export function useOverlayState(store: WorkspaceStore) {
  const t = useT()
  const [state, setState] = React.useState<OverlayState>({})
  const dialogs = React.useMemo<SandboxDialogs>(() => {
    const anchorOf = (anchor?: { x: number, y: number }) => anchor ?? { x: window.innerWidth / 2 - 160, y: window.innerHeight / 3 }
    return {
      openEntity: (mode, target) => setState((value) => ({ ...value, entity: { mode, target } })),
      openRemark: (targetId) => {
        const snapshot = store.snapshot
        const operatorId = store.getView().currentOperatorId ?? ''
        const friendship = snapshot?.friendships.find(({ participantIds }) => participantIds.includes(operatorId) && participantIds.includes(targetId))
        setState((value) => ({ ...value, text: { kind: 'remark', targetId, value: friendship?.remarks[operatorId] ?? '' } }))
      },
      openGroupAction: (kind, targetId, groupId) => {
        const group = store.snapshot?.groups.find(({ id }) => id === groupId)
        if (!group) return
        const member = group.members.find(({ participantId }) => participantId === targetId)
        const value = kind === 'name' ? group.name : kind === 'title' ? member?.title ?? '' : member?.card ?? ''
        setState((current) => ({ ...current, text: { kind, targetId, groupId: group.id, value } }))
      },
      openConversationRename: (conversationId) => {
        const instance = store.snapshot?.conversationInstances?.find(({ id }) => id === conversationId)
        if (instance) setState((value) => ({ ...value, text: { kind: 'rename', conversationId, value: instance.title ?? '' } }))
      },
      openProfile: (participantId, anchor) => {
        const snapshot = store.snapshot
        if (!snapshot) return
        const view = store.getView()
        const conversation = [...snapshot.conversations, ...(snapshot.conversationInstances ?? [])].find(({ id }) => id === view.activeConversationId)
        const groupId = conversation && 'groupId' in conversation ? conversation.groupId : undefined
        const card = buildProfileCardModel(t, { snapshot, participantId, viewerId: view.currentOperatorId, groupId })
        if (card) setState((value) => ({ ...value, profile: { card, ...anchorOf(anchor) } }))
      },
      openGroupProfile: (groupId, anchor) => {
        const group = store.snapshot?.groups.find(({ id }) => id === groupId)
        if (group) setState((value) => ({ ...value, profile: { card: buildGroupProfileCardModel(t, group), ...anchorOf(anchor) } }))
      },
    }
  }, [store, t])
  return { state, setState, dialogs }
}

export function OverlayHost({ state, setState }: {
  state: OverlayState
  setState: React.Dispatch<React.SetStateAction<OverlayState>>
}) {
  const entity = useRetained(state.entity)
  return (
    <>
      <EntityDialog
        open={!!state.entity}
        mode={entity?.mode ?? 'edit'}
        target={entity?.target}
        onOpenChange={(open) => !open && setState((value) => ({ ...value, entity: undefined }))}
      />
      <TextActionDialog dialog={state.text} onClose={() => setState((value) => ({ ...value, text: undefined }))} />
      {state.profile && <ProfileCard {...state.profile} onClose={() => setState((value) => ({ ...value, profile: undefined }))} />}
    </>
  )
}

/** 备注、群名片、群名称、专属头衔与会话实例改名共用一个单行输入对话框。 */
function TextActionDialog({ dialog, onClose }: { dialog?: TextDialog, onClose(): void }) {
  const t = useT()
  const { store } = useSandbox()
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const shown = useRetained(dialog)
  const { requestClose, confirm } = useDiscardConfirm(!!dialog && value !== dialog.value, onClose)

  // 布局阶段回填：打开的首帧就是本次的值，不闪出上一次输入的内容。
  React.useLayoutEffect(() => {
    if (!dialog) return
    setValue(dialog.value)
    setError('')
  }, [dialog])

  const submit = async () => {
    if (!dialog || busy) return
    setBusy(true)
    setError('')
    try {
      if (dialog.kind === 'remark') await store.performFriendAction({ action: 'set-remark', targetId: dialog.targetId, remark: value })
      else if (dialog.kind === 'rename') await store.renameConversationInstance({ conversationId: dialog.conversationId, title: value })
      else if (dialog.kind === 'name') await store.performGroupAction({ action: 'set-name', groupId: dialog.groupId, name: value })
      else if (dialog.kind === 'title') await store.performGroupAction({ action: 'set-title', groupId: dialog.groupId, targetId: dialog.targetId, title: value })
      else await store.performGroupAction({ action: 'set-card', groupId: dialog.groupId, targetId: dialog.targetId, card: value })
      onClose()
    } catch (failure) {
      setError(errorText(failure, t('sandbox.common.failed')))
    } finally {
      setBusy(false)
    }
  }

  const kind = shown?.kind ?? 'remark'
  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="sandbox-glass">
        <DialogHeader>
          <DialogTitle>{t(`sandbox.text.${kind}.title`)}</DialogTitle>
          <DialogDescription>{t(`sandbox.text.${kind}.description`)}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder={t(`sandbox.text.${kind}.placeholder`)}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit()
          }}
        />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={requestClose}>{t('sandbox.common.cancel')}</Button>
          <Button disabled={busy} onClick={submit}>{busy ? t('sandbox.common.saving') : t('sandbox.common.save')}</Button>
        </DialogFooter>
        {confirm}
      </DialogContent>
    </Dialog>
  )
}

const PROFILE_WIDTH = 320
/** 首帧定位用的估计高度；挂载后按实际高度重新收进视口。 */
const PROFILE_HEIGHT = 380

/** 资料卡：在点击位置附近浮出，可拖动标题栏移动，点外部或 Esc 关闭。 */
function ProfileCard({ card, x, y, onClose }: { card: ProfileCardModel, x: number, y: number, onClose(): void }) {
  const t = useT()
  const { resolveAvatar } = useWorkspace()
  const panel = React.useRef<HTMLElement>(null)
  const [position, setPosition] = React.useState(() => getFloatingPanelPosition({ x, y }, { width: window.innerWidth, height: window.innerHeight }, { width: PROFILE_WIDTH, height: PROFILE_HEIGHT }))
  const drag = React.useRef<{ id: number, x: number, y: number, left: number, top: number } | undefined>(undefined)

  // 资料卡最高 32rem，字段多时比估计高度高；在绘制前按实际尺寸重新定位，下缘不越出视口。
  React.useLayoutEffect(() => {
    const size = panel.current
      ? { width: panel.current.offsetWidth, height: panel.current.offsetHeight }
      : { width: PROFILE_WIDTH, height: PROFILE_HEIGHT }
    setPosition(getFloatingPanelPosition({ x, y }, { width: window.innerWidth, height: window.innerHeight }, size))
  }, [card, x, y])

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // 延后一帧挂载，避免打开资料卡的那次点击立刻把它关掉。
    const timer = setTimeout(() => document.addEventListener('pointerdown', onPointerDown))
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const sections = groupProfileCardFields(t, card.fields)
  return createPortal(
    <section
      ref={panel}
      aria-label={t('sandbox.profile.title')}
      className="sandbox-glass fixed z-50 flex max-h-[min(32rem,calc(100vh-24px))] w-80 flex-col overflow-hidden rounded-xl bg-popover text-sm leading-6 text-popover-foreground shadow-popup ring-1 ring-border animate-in fade-in-0 zoom-in-95"
      style={{ left: position.x, top: position.y }}
    >
      <header
        className="flex h-10 shrink-0 touch-none items-center justify-between border-b border-border pr-1.5 pl-4 select-none"
        onPointerDown={(event) => {
          if (event.button !== 0 || isFloatingPanelInteractiveTarget(event.target) || !panel.current) return
          const rect = panel.current.getBoundingClientRect()
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state || state.id !== event.pointerId || !panel.current) return
          setPosition(clampFloatingPanelPosition(
            { x: state.left + event.clientX - state.x, y: state.top + event.clientY - state.y },
            { width: window.innerWidth, height: window.innerHeight },
            { width: panel.current.offsetWidth, height: panel.current.offsetHeight },
          ))
        }}
        onPointerUp={() => {
          drag.current = undefined
        }}
      >
        <strong className="text-[13px] font-medium">{t('sandbox.profile.title')}</strong>
        <Button variant="ghost" size="icon-xs" aria-label={t('sandbox.common.close')} onClick={onClose}><XIcon /></Button>
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          <SandboxAvatar kind={card.avatarKind} name={card.name} src={resolveAvatar(card.avatar)} className="size-14" />
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate text-base font-medium">{card.name}</h2>
            <p className="text-xs text-muted-foreground">{card.identityLabel} {card.participantId}</p>
            {card.personalNote && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.personalNote}</p>}
          </div>
        </div>
        {sections.map((section) => (
          <section key={section.group} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">{section.label}</h3>
            <dl className="flex flex-col gap-1 rounded-lg bg-muted/50 p-2.5 text-xs">
              {section.fields.map((field) => (
                <div key={`${field.label}:${field.value}`} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">{field.label}</dt>
                  <dd className="min-w-0 text-right break-words">{field.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </section>,
    document.body,
  )
}

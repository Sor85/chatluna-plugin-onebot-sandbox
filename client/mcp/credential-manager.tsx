import * as React from 'react'
import { CopyIcon, PlusIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@chatluna/ui-kit'
import { toast } from '@chatluna/ui-client/client'
import type { SandboxMcpScope, SandboxTestPublicCredential } from '../../src/mcp/types'
import { useT } from '../i18n'
import { useDiscardConfirm } from '../shared/discard-confirm'
import { useRetained } from '../shared/use-retained'
import { errorText, invoke } from '../workspace/store'
import { MCP_SCOPES } from './capability-catalog'

/**
 * 测试凭证：同一个凭证同时用于 MCP 客户端与 HTTP 脚本。每个写操作成功后都重新列举一次，
 * 服务端是凭证的唯一拥有者，本地拼接会在 Token 明文可见性这类派生字段上与服务端分叉。
 */
export function TestCredentialManager() {
  const t = useT()
  const [credentials, setCredentials] = React.useState<SandboxTestPublicCredential[]>([])
  const [listError, setListError] = React.useState('')
  const [form, setForm] = React.useState<{ editing?: SandboxTestPublicCredential, name: string, scopes: SandboxMcpScope[] }>()
  const [formError, setFormError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [createdToken, setCreatedToken] = React.useState('')
  const [revoking, setRevoking] = React.useState<SandboxTestPublicCredential>()

  const refresh = React.useCallback(async () => {
    try {
      setCredentials(await invoke('onebot-sandbox.test-credentials', undefined))
      setListError('')
    } catch (failure) {
      setListError(errorText(failure, t('sandbox.credential.loadFailed')))
    }
  }, [t])
  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const guard = async (fallback: string, action: () => Promise<void>) => {
    setSaving(true)
    try {
      await action()
    } catch (failure) {
      setFormError(errorText(failure, fallback))
    } finally {
      setSaving(false)
    }
  }

  const submit = async () => {
    if (!form) return
    setFormError('')
    if (!form.name.trim() || !form.scopes.length) {
      setFormError(t('sandbox.credential.invalid'))
      return
    }
    const editing = form.editing
    if (editing) {
      await guard(t('sandbox.credential.saveFailed'), async () => {
        await invoke('onebot-sandbox.update-test-credential', { id: editing.id, name: form.name, scopes: form.scopes })
        setForm(undefined)
        await refresh()
      })
    } else {
      await guard(t('sandbox.credential.createFailed'), async () => {
        const created = await invoke('onebot-sandbox.create-test-credential', { name: form.name, scopes: form.scopes })
        setForm(undefined)
        setCreatedToken(created.token)
        await refresh()
      })
    }
  }

  const rotate = async () => {
    const editing = form?.editing
    if (!editing) return
    setFormError('')
    await guard(t('sandbox.credential.rotateFailed'), async () => {
      const rotated = await invoke('onebot-sandbox.rotate-test-credential-token', { id: editing.id })
      setForm((value) => value && { ...value, editing: rotated })
      await refresh()
    })
  }

  const run = async (fallback: string, action: () => Promise<unknown>) => {
    try {
      await action()
      await refresh()
    } catch (failure) {
      setListError(errorText(failure, fallback))
    }
  }

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      toast.success(t('sandbox.credential.copied'))
    } catch {
      toast.error(t('sandbox.credential.copyFailed'))
    }
  }

  // 退场动画期间沿用最后一份内容，标题、Token 区与输入框不在淡出时变成空态。
  const shownForm = useRetained(form)
  const shownRevoking = useRetained(revoking)
  const shownToken = useRetained(createdToken || undefined) ?? ''
  const baseline = form?.editing ? { name: form.editing.name, scopes: form.editing.scopes } : { name: '', scopes: ['read'] }
  const dirty = !!form && (form.name !== baseline.name || [...form.scopes].sort().join() !== [...baseline.scopes].sort().join())
  const { requestClose, confirm } = useDiscardConfirm(dirty, () => setForm(undefined))

  const scopeText = (scopes: readonly SandboxMcpScope[]) => scopes.map((scope) => t(`sandbox.scope.${scope}`)).join(' · ')
  const time = (value: string) => new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  const editing = shownForm?.editing

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">{t('sandbox.credential.hint')}</p>
        <Button size="sm" onClick={() => {
          setFormError('')
          setForm({ name: '', scopes: ['read'] })
        }}><PlusIcon />{t('sandbox.credential.create')}</Button>
      </div>
      {listError && <p role="alert" className="text-xs text-destructive">{listError}</p>}
      {credentials.map((credential) => (
        <article key={credential.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ring-border">
          <button type="button" className="flex min-w-0 flex-col gap-0.5 text-left" onClick={() => {
            setFormError('')
            setForm({ editing: credential, name: credential.name, scopes: [...credential.scopes] })
          }}>
            <strong className="truncate text-xs font-medium">{credential.name}</strong>
            <small className="text-[11px] text-muted-foreground">{scopeText(credential.scopes)} · {time(credential.createdAt)}</small>
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={credential.enabled ? 'secondary' : 'outline'}>{t(credential.enabled ? 'sandbox.env.enabled' : 'sandbox.env.disabled')}</Badge>
            <Button size="sm" variant="outline" onClick={() => {
              setFormError('')
              setForm({ editing: credential, name: credential.name, scopes: [...credential.scopes] })
            }}>{t('sandbox.credential.view')}</Button>
            <Button size="sm" variant="outline" onClick={() => void run(t('sandbox.common.failed'), () => invoke('onebot-sandbox.set-test-credential-enabled', { id: credential.id, enabled: !credential.enabled }))}>
              {t(credential.enabled ? 'sandbox.credential.disable' : 'sandbox.credential.enable')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setRevoking(credential)}>{t('sandbox.credential.revoke')}</Button>
          </div>
        </article>
      ))}
      {!credentials.length && !listError && <p className="py-6 text-center text-xs text-muted-foreground">{t('sandbox.credential.empty')}</p>}

      <Dialog open={!!form} onOpenChange={(open) => !open && requestClose()}>
        <DialogContent className="flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t(editing ? 'sandbox.credential.viewTitle' : 'sandbox.credential.createTitle')}</DialogTitle>
            <DialogDescription>{t(editing ? 'sandbox.credential.viewDescription' : 'sandbox.credential.createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="-mx-5 flex min-h-0 flex-col gap-4 overflow-y-auto px-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sandbox-credential-name">{t('sandbox.credential.name')}</Label>
              <Input id="sandbox-credential-name" autoComplete="off" value={shownForm?.name ?? ''} onChange={(event) => setForm((value) => value && { ...value, name: event.target.value })} />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{t('sandbox.credential.scopes')}</legend>
              <div className="grid grid-cols-2 gap-2">
                {MCP_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={shownForm?.scopes.includes(scope) ?? false}
                      onCheckedChange={(checked) => setForm((value) => value && {
                        ...value,
                        scopes: checked === true ? [...new Set([...value.scopes, scope])] : value.scopes.filter((item) => item !== scope),
                      })}
                    />
                    {t(`sandbox.scope.${scope}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            {editing && (
              <div className="flex flex-col gap-2">
                <Label>Token</Label>
                {editing.token ? (
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-2 font-mono text-xs break-all">{editing.token}</code>
                    <Button size="icon-sm" variant="ghost" aria-label={t('sandbox.credential.copy')} onClick={() => void copy(editing.token!)}><CopyIcon /></Button>
                  </div>
                ) : (
                  <p className="text-xs leading-5 text-muted-foreground">{t('sandbox.credential.noPlainToken')}</p>
                )}
                <Button size="sm" variant="outline" className="self-start" disabled={saving} onClick={() => void rotate()}>
                  {t(editing.token ? 'sandbox.credential.rotate' : 'sandbox.credential.generate')}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {t('sandbox.credential.createdAt', { time: time(editing.createdAt) })} · {t(editing.enabled ? 'sandbox.env.enabled' : 'sandbox.env.disabled')}
                </p>
              </div>
            )}
            {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={requestClose}>{t('sandbox.common.cancel')}</Button>
            <Button disabled={saving} onClick={() => void submit()}>{t(editing ? 'sandbox.common.save' : 'sandbox.credential.createAction')}</Button>
          </DialogFooter>
          {confirm}
        </DialogContent>
      </Dialog>

      <Dialog open={!!createdToken} onOpenChange={(open) => !open && setCreatedToken('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sandbox.credential.tokenTitle')}</DialogTitle>
            <DialogDescription>{t('sandbox.credential.tokenDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={shownToken} className="font-mono text-xs!" />
            <Button size="icon-sm" variant="ghost" aria-label={t('sandbox.credential.copy')} onClick={() => void copy(shownToken)}><CopyIcon /></Button>
          </div>
          <DialogFooter><Button onClick={() => setCreatedToken('')}>{t('sandbox.credential.saved')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sandbox.credential.revokeTitle', { name: shownRevoking?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('sandbox.credential.revokeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('sandbox.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              const target = revoking
              setRevoking(undefined)
              if (target) void run(t('sandbox.common.failed'), () => invoke('onebot-sandbox.revoke-test-credential', { id: target.id }))
            }}>{t('sandbox.credential.revoke')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

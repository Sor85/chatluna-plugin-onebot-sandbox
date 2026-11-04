import * as React from 'react'
import { SaveIcon, Undo2Icon } from 'lucide-react'
import { Alert, AlertDescription, Button, Spinner } from '@chatluna/ui-kit'
import { apiErrorMessage, callAction, toast, useLive } from '@chatluna/ui-client/client'
import { SchemaForm, useFormValidation } from '@chatluna/ui-schema-form/client'
import { useT } from '../i18n'

type Values = Record<string, unknown>

const sameValues = (left: Values | undefined, right: Values | undefined) => JSON.stringify(left) === JSON.stringify(right)

/**
 * 插件设置页。读写的是 chatluna.yml 里本插件条目的配置（`src/settings.ts`），v2 插件页不再显示这些字段。
 *
 * 保存后插件按新配置重启，实时 state 要等重启完成才推来新值；这段时间里表单先显示刚保存的值，
 * 文件戳一变再换成服务端读回的值，避免先闪回旧值。
 */
export function SettingsPage() {
  const t = useT()
  const live = useLive('onebot-sandbox.settings')
  const validation = useFormValidation()
  const [draft, setDraft] = React.useState<Values>()
  const [pending, setPending] = React.useState<{ revision: string, value: Values }>()
  const [saving, setSaving] = React.useState(false)
  const data = live.data
  const saved = pending && pending.revision === data?.revision ? pending.value : data?.value
  const value = draft ?? saved ?? {}
  const dirty = draft !== undefined && !sameValues(draft, saved)

  const discard = () => {
    setDraft(undefined)
    validation.reset()
  }

  const save = async () => {
    if (!data || !draft) return
    if (!validation.attempt()) {
      toast.error(t('sandbox.settings.invalid'))
      return
    }
    setSaving(true)
    try {
      await callAction('onebot-sandbox.settings.save', { config: draft, revision: data.revision })
      setPending({ revision: data.revision, value: draft })
      setDraft(undefined)
      validation.reset()
      toast.success(t('sandbox.settings.saved'))
    } catch (error) {
      toast.error(t('sandbox.settings.saveFailed'), { description: apiErrorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center justify-between gap-3 px-6 pt-3 pb-3">
        <p className="min-w-0 text-xs text-muted-foreground">{t('sandbox.settings.description')}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={discard}>
            <Undo2Icon />{t('sandbox.settings.discard')}
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : <SaveIcon />}{t(saving ? 'sandbox.common.saving' : 'sandbox.common.save')}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 pb-6">
          {data ? (
            <fieldset disabled={saving} className="min-w-0">
              <SchemaForm
                schema={data.schema}
                value={value}
                initial={saved}
                onChange={setDraft}
                validation={validation}
                formId="onebot-sandbox.settings"
              />
            </fieldset>
          ) : live.error ? (
            <Alert variant="destructive">
              <AlertDescription>{t('sandbox.settings.unavailable')}：{live.error}</AlertDescription>
            </Alert>
          ) : (
            <div className="flex justify-center py-12 text-muted-foreground"><Spinner /></div>
          )}
        </div>
      </div>
    </div>
  )
}

import { FlaskConicalIcon } from 'lucide-react'
import { Badge } from '@chatluna/ui-kit'
import { license, name, version } from '../../package.json'
import { useT } from '../i18n'

/**
 * 设置页导航末尾的「关于」面板。版本号、包名与协议直接取自 package.json，发版只改那一处；
 * 读的是客户端打包时的 package.json，不依赖服务端，设置读不到时也照常显示。
 */
export function AboutPanel() {
  const t = useT()
  const rows: Array<{ label: string, value: string, mono?: boolean }> = [
    { label: t('sandbox.settings.about.version'), value: version, mono: true },
    { label: t('sandbox.settings.about.package'), value: name, mono: true },
    { label: t('sandbox.settings.about.license'), value: license },
    { label: t('sandbox.settings.about.protocol'), value: 'OneBot v11' },
    { label: t('sandbox.settings.about.host'), value: 'ChatLuna v2' },
  ]
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FlaskConicalIcon className="size-5" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] leading-5 font-semibold">{t('onebot-sandbox.title')}</h3>
            <Badge variant="outline" className="font-mono">v{version}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t('sandbox.settings.about.summary')}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2.5 border-t border-border pt-4 text-[13px] leading-5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className={row.mono ? 'font-mono text-xs leading-5 break-all' : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

import { FlaskConicalIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@chatluna/ui-kit'
import { useT } from '../i18n'

/** 菜单项尾部标记：该操作不是 OneBot action，只用于构造测试场景。 */
export function ExtensionMark() {
  const t = useT()
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ml-auto inline-flex text-muted-foreground" aria-label={t('sandbox.extension.description')} />}>
        <FlaskConicalIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="right">{t('sandbox.extension.description')}</TooltipContent>
    </Tooltip>
  )
}

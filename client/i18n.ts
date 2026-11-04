import * as React from 'react'
import { useLocale, useTranslate, type Translate } from '@chatluna/ui-client/client'

export const LOCALE_NS = 'onebot-sandbox'

/**
 * 宿主按命名空间缓存 `t`，切换语言后引用不变，依赖它的 `useMemo`/`useCallback` 不会重算，
 * 缓存下来的文案停在旧语言。这里按语言快照换一个新引用，把 `t` 写进依赖即可跟随切换。
 */
export function useT(): Translate {
  const locale = useLocale()
  const translate = useTranslate(LOCALE_NS)
  return React.useMemo<Translate>(() => (key, params) => translate(key, params), [translate, locale])
}

/** 记录来源的显示名：主环境的名字由服务端写成中文，按当前语言替换；测试空间用用户起的名字。 */
export function sourceName(t: Translate, source: { type: string, name: string }): string {
  return source.type === 'main' ? t('sandbox.source.main') : source.name
}

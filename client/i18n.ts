import { useTranslate, type Translate } from '@chatluna/ui-client/client'

export const LOCALE_NS = 'onebot-sandbox'

export function useT(): Translate {
  return useTranslate(LOCALE_NS)
}

import type { StudioLocaleText } from '@mui/x-studio';
import { ptBRLocaleText } from '@mui/x-studio';
import { ptBR as pickersPtBR } from '@mui/x-date-pickers/locales';
import 'dayjs/locale/pt-br';

export type SupportedLocale = 'en' | 'pt-BR';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
};

type PickersLocaleTextBundle =
  typeof pickersPtBR.components.MuiLocalizationProvider.defaultProps.localeText;

export interface LocaleBundle {
  /** dayjs locale string (for AdapterDayjs). */
  dayjsLocale: string;
  /** Studio locale text partial (for Studio localeText prop). */
  studioLocaleText: Partial<StudioLocaleText> | undefined;
  /** MUI X Date Pickers locale text (for LocalizationProvider localeText prop). */
  pickersLocaleText: PickersLocaleTextBundle | undefined;
}

export const LOCALE_BUNDLES: Record<SupportedLocale, LocaleBundle> = {
  en: {
    dayjsLocale: 'en',
    studioLocaleText: undefined,
    pickersLocaleText: undefined,
  },
  'pt-BR': {
    dayjsLocale: 'pt-br',
    studioLocaleText: ptBRLocaleText,
    pickersLocaleText:
      pickersPtBR.components.MuiLocalizationProvider.defaultProps.localeText,
  },
};

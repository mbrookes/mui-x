import { DEFAULT_STUDIO_LOCALE_TEXT } from '../internals/StudioUIConfigContext';
import { getStudioLocalization, type Localization } from './utils/getStudioLocalization';

export const enUS: Localization = getStudioLocalization(DEFAULT_STUDIO_LOCALE_TEXT);

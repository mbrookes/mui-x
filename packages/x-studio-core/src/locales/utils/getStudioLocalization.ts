import type { StudioLocaleText } from '../../engine/localeText';

export interface Localization {
  components: {
    MuiStudio: {
      defaultProps: {
        localeText: Partial<StudioLocaleText>;
      };
    };
  };
}

export const getStudioLocalization = (
  studioTranslations: Partial<StudioLocaleText>,
): Localization => ({
  components: {
    MuiStudio: {
      defaultProps: { localeText: studioTranslations },
    },
  },
});

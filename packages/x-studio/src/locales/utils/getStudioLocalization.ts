import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';

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

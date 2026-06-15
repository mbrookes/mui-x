declare module '@mui/x-date-pickers/locales' {
  type PickersLocale = {
    components: {
      MuiLocalizationProvider: {
        defaultProps: {
          localeText: Record<string, unknown>;
        };
      };
    };
  };
  export const ptBR: PickersLocale;
  export const deDE: PickersLocale;
  export const esES: PickersLocale;
  export const frFR: PickersLocale;
}

import type { StudioLocaleText } from '@mui/x-studio';
import { deLocaleText, esLocaleText, frLocaleText, ptBRLocaleText } from '@mui/x-studio';
import {
  deDE as pickersDeDE,
  esES as pickersEsES,
  frFR as pickersFrFR,
  ptBR as pickersPtBR,
} from '@mui/x-date-pickers/locales';
import 'dayjs/locale/de';
import 'dayjs/locale/es';
import 'dayjs/locale/fr';
import 'dayjs/locale/pt-br';

export type SupportedLocale = 'en' | 'fr' | 'de' | 'es' | 'pt-BR';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
};

type PickersLocaleTextBundle =
  typeof pickersPtBR.components.MuiLocalizationProvider.defaultProps.localeText;

export interface AppLocaleText {
  undoTooltip: string;
  undoAriaLabel: string;
  redoTooltip: string;
  redoAriaLabel: string;
  downloadTooltip: string;
  downloadAriaLabel: string;
  uploadTooltip: string;
  uploadAriaLabel: string;
  settingsTooltip: string;
  settingsAriaLabel: string;
  removePageTitle: string;
  removePageDescription: (pageTitle: string) => string;
  cancelButtonLabel: string;
  removeButtonLabel: string;
  viewLabel: string;
  editLabel: string;
  toggleEditModeAriaLabel: string;
  settingsDialogTitle: string;
  settingsTabLabel: string;
  featuresTabLabel: string;
  datasetLabel: string;
  languageLabel: string;
  sidebarLayoutLabel: string;
  sidebarLayoutTabbed: string;
  sidebarLayoutStacked: string;
  sidebarPositionLabel: string;
  sidebarPositionLeft: string;
  sidebarPositionRight: string;
  tableSourceModeLabel: string;
  tableSourceExplicit: string;
  tableSourceImplicit: string;
  stackBreakpointLabel: string;
  stackBreakpointHelper: string;
  rowCountLabel: string;
  rowCountHelper: string;
  rowCountUnit: string;
  rowCountOverridesServerHint: string;
  serverAdapterLabel: string;
  dataSourceModeLabel: string;
  dataModeMemory: string;
  dataModeServerUnavailableHint: string;
  settingsReloadHint: string;
  devServerConnectionLabel: string;
  devServerConnectedLabel: string;
  devServerConnectedDescription: string;
  devServerChangeInstructions: string;
  devServerNotConnectedDescription: string;
  datasetSales: string;
  datasetAg: string;
  applyReloadButtonLabel: string;
  closeButtonLabel: string;
  alertBannerSettingsTitle: string;
  alertTitleLabel: string;
  alertMessageLabel: string;
  alertSeverityLabel: string;
  alertSeverityInfo: string;
  alertSeveritySuccess: string;
  alertSeverityWarning: string;
  alertSeverityError: string;
  alertMessageHelper: string;
  alertValueFieldLabel: string;
  alertDateFieldLabel: string;
  alertLookbackLabel: string;
  alertAggregationLabel: string;
  alertAggSum: string;
  alertAggAvg: string;
  alertAggMax: string;
  alertAggMin: string;
  alertAggCount: string;
  alertThresholdsTitle: string;
  alertThresholdSuccess: string;
  alertThresholdWarning: string;
  alertThresholdError: string;
  alertHideBelowLabel: string;
  alertHideNever: string;
  alertHideBelowWarning: string;
  alertHideBelowError: string;
  alertComputedLabel: (value: string, days: number) => string;
  alertHiddenInViewNote: string;
  adapterModeLabel: string;
  serverModeLabel: string;
  generatedRowsLabel: (rowCount: number) => string;
  demoDataLabel: string;
  dashboardSavedMessage: string;
  dashboardLoadedMigratedMessage: (
    fromVersion: string | number,
    toVersion: string | number,
  ) => string;
  dashboardLoadedMessage: string;
  dashboardLoadFailedMessage: string;
}

const enAppLocaleText: AppLocaleText = {
  undoTooltip: 'Undo (⌘Z)',
  undoAriaLabel: 'Undo',
  redoTooltip: 'Redo (⌘⇧Z)',
  redoAriaLabel: 'Redo',
  downloadTooltip: 'Download dashboard',
  downloadAriaLabel: 'Download dashboard',
  uploadTooltip: 'Upload dashboard',
  uploadAriaLabel: 'Upload dashboard',
  settingsTooltip: 'Settings',
  settingsAriaLabel: 'Settings',
  removePageTitle: 'Remove page?',
  removePageDescription: (pageTitle) =>
    `Remove "${pageTitle}" and all its widgets? This action can be undone.`,
  cancelButtonLabel: 'Cancel',
  removeButtonLabel: 'Remove',
  viewLabel: 'View',
  editLabel: 'Edit',
  toggleEditModeAriaLabel: 'Toggle edit mode',
  settingsDialogTitle: 'Settings',
  settingsTabLabel: 'Settings',
  featuresTabLabel: 'Features',
  datasetLabel: 'Dataset',
  languageLabel: 'Language',
  sidebarLayoutLabel: 'Sidebar layout',
  sidebarLayoutTabbed: 'Tabbed',
  sidebarLayoutStacked: 'Stacked',
  sidebarPositionLabel: 'Sidebar position',
  sidebarPositionLeft: 'Left',
  sidebarPositionRight: 'Right',
  tableSourceModeLabel: 'Table source mode',
  tableSourceExplicit: 'Explicit (picker)',
  tableSourceImplicit: 'Implicit (inferred)',
  stackBreakpointLabel: 'Responsive stack breakpoint',
  stackBreakpointHelper: 'Canvas width (px) below which widgets stack. Set to 0 to disable.',
  rowCountLabel: 'Generated row count',
  rowCountHelper: 'Leave blank to use the default bundled data',
  rowCountUnit: 'rows',
  rowCountOverridesServerHint:
    'When rows are set, server mode is bypassed — generated data is used in-memory.',
  serverAdapterLabel: 'Simulated server adapter',
  dataSourceModeLabel: 'Data source mode',
  dataModeMemory: 'In-memory (default)',
  dataModeServerUnavailableHint:
    'Set STUDIO_SERVER_URL in .env.local (or add ?server=URL) to enable server mode.',
  settingsReloadHint: 'Dataset, row count and data source mode changes take effect after reload.',
  devServerConnectionLabel: 'Dev Server Connection',
  devServerConnectedLabel: 'Connected to:',
  devServerConnectedDescription: 'AI and data queries are routed through the dev server.',
  devServerChangeInstructions: 'To change, update STUDIO_SERVER_URL in .env.local.',
  devServerNotConnectedDescription:
    'Not connected. Set STUDIO_SERVER_URL in .env.local to route queries through examples/x-studio-dev-server.',
  datasetSales: 'MUI X Sales (generated)',
  datasetAg: 'AG Studio Office Supplies',
  applyReloadButtonLabel: 'Apply & Reload',
  closeButtonLabel: 'Close',
  alertBannerSettingsTitle: 'Alert Banner settings',
  alertTitleLabel: 'Title (optional)',
  alertMessageLabel: 'Message',
  alertSeverityLabel: 'Severity',
  alertSeverityInfo: 'Info',
  alertSeveritySuccess: 'Success',
  alertSeverityWarning: 'Warning',
  alertSeverityError: 'Error',
  alertMessageHelper:
    'Use {value} as a placeholder for the computed value (e.g. "Sales hit {value} this week").',
  alertValueFieldLabel: 'Value field',
  alertDateFieldLabel: 'Date field (for time range)',
  alertLookbackLabel: 'Time range (days)',
  alertAggregationLabel: 'Aggregation',
  alertAggSum: 'Sum',
  alertAggAvg: 'Average',
  alertAggMax: 'Maximum',
  alertAggMin: 'Minimum',
  alertAggCount: 'Count',
  alertThresholdsTitle: 'Severity thresholds',
  alertThresholdSuccess: 'Success at or above',
  alertThresholdWarning: 'Warning at or above',
  alertThresholdError: 'Error at or above',
  alertHideBelowLabel: 'Hide widget (view mode)',
  alertHideNever: 'Always show',
  alertHideBelowWarning: 'Hide below Warning',
  alertHideBelowError: 'Hide below Error',
  alertComputedLabel: (value, days) => `Computed value: ${value} (last ${days} day(s))`,
  alertHiddenInViewNote: 'Hidden in view mode when the condition is not met.',
  adapterModeLabel: 'Adapter Mode',
  serverModeLabel: 'Server Mode',
  generatedRowsLabel: (rowCount) => `Generated · ${rowCount.toLocaleString()} rows`,
  demoDataLabel: 'Demo Data',
  dashboardSavedMessage: 'Dashboard saved successfully',
  dashboardLoadedMigratedMessage: (fromVersion, toVersion) =>
    `Dashboard loaded and migrated from v${fromVersion} to v${toVersion}`,
  dashboardLoadedMessage: 'Dashboard loaded successfully',
  dashboardLoadFailedMessage: 'Failed to load dashboard',
};

const ptBrAppLocaleText: AppLocaleText = {
  undoTooltip: 'Desfazer (⌘Z)',
  undoAriaLabel: 'Desfazer',
  redoTooltip: 'Refazer (⌘⇧Z)',
  redoAriaLabel: 'Refazer',
  downloadTooltip: 'Baixar painel',
  downloadAriaLabel: 'Baixar painel',
  uploadTooltip: 'Carregar painel',
  uploadAriaLabel: 'Carregar painel',
  settingsTooltip: 'Configurações',
  settingsAriaLabel: 'Configurações',
  removePageTitle: 'Remover página?',
  removePageDescription: (pageTitle) =>
    `Remover "${pageTitle}" e todos os seus widgets? Esta ação pode ser desfeita.`,
  cancelButtonLabel: 'Cancelar',
  removeButtonLabel: 'Remover',
  viewLabel: 'Visualizar',
  editLabel: 'Editar',
  toggleEditModeAriaLabel: 'Alternar modo de edição',
  settingsDialogTitle: 'Configurações',
  settingsTabLabel: 'Configurações',
  featuresTabLabel: 'Recursos',
  datasetLabel: 'Conjunto de dados',
  languageLabel: 'Idioma',
  sidebarLayoutLabel: 'Layout da barra lateral',
  sidebarLayoutTabbed: 'Abas',
  sidebarLayoutStacked: 'Empilhado',
  sidebarPositionLabel: 'Posição da barra lateral',
  sidebarPositionLeft: 'Esquerda',
  sidebarPositionRight: 'Direita',
  tableSourceModeLabel: 'Modo de origem da tabela',
  tableSourceExplicit: 'Explícito (seletor)',
  tableSourceImplicit: 'Implícito (inferido)',
  stackBreakpointLabel: 'Ponto de quebra da pilha responsiva',
  stackBreakpointHelper:
    'Largura do canvas (px) abaixo da qual os widgets são empilhados. Defina 0 para desativar.',
  rowCountLabel: 'Número de linhas geradas',
  rowCountHelper: 'Deixe em branco para usar os dados padrão incluídos',
  rowCountUnit: 'linhas',
  rowCountOverridesServerHint:
    'Quando as linhas estão definidas, o modo servidor é ignorado — os dados gerados são usados em memória.',
  serverAdapterLabel: 'Adaptador de servidor simulado',
  dataSourceModeLabel: 'Modo da fonte de dados',
  dataModeMemory: 'Em memória (padrão)',
  dataModeServerUnavailableHint:
    'Defina STUDIO_SERVER_URL em .env.local (ou adicione ?server=URL) para ativar o modo servidor.',
  settingsReloadHint:
    'As alterações de conjunto de dados, número de linhas e modo da fonte de dados entram em vigor após recarregar.',
  devServerConnectionLabel: 'Conexão com o servidor de desenvolvimento',
  devServerConnectedLabel: 'Conectado a:',
  devServerConnectedDescription:
    'As consultas de IA e dados são roteadas pelo servidor de desenvolvimento.',
  devServerChangeInstructions: 'Para alterar, atualize STUDIO_SERVER_URL em .env.local.',
  devServerNotConnectedDescription:
    'Não conectado. Defina STUDIO_SERVER_URL em .env.local para rotear consultas por examples/x-studio-dev-server.',
  datasetSales: 'Vendas do MUI X (geradas)',
  datasetAg: 'Suprimentos de escritório do AG Studio',
  applyReloadButtonLabel: 'Aplicar e recarregar',
  closeButtonLabel: 'Fechar',
  alertBannerSettingsTitle: 'Configurações do banner de alerta',
  alertTitleLabel: 'Título (opcional)',
  alertMessageLabel: 'Mensagem',
  alertSeverityLabel: 'Severidade',
  alertSeverityInfo: 'Informativo',
  alertSeveritySuccess: 'Sucesso',
  alertSeverityWarning: 'Aviso',
  alertSeverityError: 'Erro',
  alertMessageHelper:
    'Use {value} como espaço reservado para o valor calculado (ex.: "Vendas atingiram {value} esta semana").',
  alertValueFieldLabel: 'Campo de valor',
  alertDateFieldLabel: 'Campo de data (para intervalo de tempo)',
  alertLookbackLabel: 'Intervalo de tempo (dias)',
  alertAggregationLabel: 'Agregação',
  alertAggSum: 'Soma',
  alertAggAvg: 'Média',
  alertAggMax: 'Máximo',
  alertAggMin: 'Mínimo',
  alertAggCount: 'Contagem',
  alertThresholdsTitle: 'Limites de severidade',
  alertThresholdSuccess: 'Sucesso igual ou acima de',
  alertThresholdWarning: 'Aviso igual ou acima de',
  alertThresholdError: 'Erro igual ou acima de',
  alertHideBelowLabel: 'Ocultar widget (modo de visualização)',
  alertHideNever: 'Sempre mostrar',
  alertHideBelowWarning: 'Ocultar abaixo de Aviso',
  alertHideBelowError: 'Ocultar abaixo de Erro',
  alertComputedLabel: (value, days) => `Valor calculado: ${value} (últimos ${days} dia(s))`,
  alertHiddenInViewNote: 'Oculto no modo de visualização quando a condição não é atendida.',
  adapterModeLabel: 'Modo do adaptador',
  serverModeLabel: 'Modo do servidor',
  generatedRowsLabel: (rowCount) => `Gerado · ${rowCount.toLocaleString()} linhas`,
  demoDataLabel: 'Dados de demonstração',
  dashboardSavedMessage: 'Painel salvo com sucesso',
  dashboardLoadedMigratedMessage: (fromVersion, toVersion) =>
    `Painel carregado e migrado da v${fromVersion} para a v${toVersion}`,
  dashboardLoadedMessage: 'Painel carregado com sucesso',
  dashboardLoadFailedMessage: 'Falha ao carregar o painel',
};

export interface LocaleBundle {
  /** dayjs locale string (for AdapterDayjs). */
  dayjsLocale: string;
  /** Studio locale text partial (for StudioProvider localeText prop). */
  studioLocaleText: Partial<StudioLocaleText> | undefined;
  /** MUI X Date Pickers locale text (for LocalizationProvider localeText prop). */
  pickersLocaleText: PickersLocaleTextBundle | undefined;
  /** App shell locale text. */
  appLocaleText: AppLocaleText;
}

export const LOCALE_BUNDLES: Record<SupportedLocale, LocaleBundle> = {
  en: {
    dayjsLocale: 'en',
    studioLocaleText: undefined,
    pickersLocaleText: undefined,
    appLocaleText: enAppLocaleText,
  },
  fr: {
    dayjsLocale: 'fr',
    studioLocaleText: frLocaleText,
    pickersLocaleText: pickersFrFR.components.MuiLocalizationProvider.defaultProps.localeText,
    appLocaleText: enAppLocaleText,
  },
  de: {
    dayjsLocale: 'de',
    studioLocaleText: deLocaleText,
    pickersLocaleText: pickersDeDE.components.MuiLocalizationProvider.defaultProps.localeText,
    appLocaleText: enAppLocaleText,
  },
  es: {
    dayjsLocale: 'es',
    studioLocaleText: esLocaleText,
    pickersLocaleText: pickersEsES.components.MuiLocalizationProvider.defaultProps.localeText,
    appLocaleText: enAppLocaleText,
  },
  'pt-BR': {
    dayjsLocale: 'pt-br',
    studioLocaleText: ptBRLocaleText,
    pickersLocaleText: pickersPtBR.components.MuiLocalizationProvider.defaultProps.localeText,
    appLocaleText: ptBrAppLocaleText,
  },
};

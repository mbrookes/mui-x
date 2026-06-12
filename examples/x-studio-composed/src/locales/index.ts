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

export interface AppLocaleText {
  addPageTooltip: string;
  addPageAriaLabel: string;
  undoTooltip: string;
  undoAriaLabel: string;
  redoTooltip: string;
  redoAriaLabel: string;
  dataSourcesTooltip: string;
  dataSourcesAriaLabel: string;
  configureWidgetTooltip: string;
  configureWidgetAriaLabel: string;
  filtersTooltip: string;
  filtersAriaLabel: string;
  downloadTooltip: string;
  downloadAriaLabel: string;
  uploadTooltip: string;
  uploadAriaLabel: string;
  resetTooltip: string;
  resetAriaLabel: string;
  settingsTooltip: string;
  settingsAriaLabel: string;
  addWidgetTooltip: string;
  addWidgetAriaLabel: string;
  backAriaLabel: string;
  closeComposeDialogAriaLabel: string;
  closeDataDialogAriaLabel: string;
  closeFiltersDialogAriaLabel: string;
  closeTooltip: string;
  closeAiAssistantAriaLabel: string;
  removePageTitle: string;
  removePageDescription: (pageTitle: string) => string;
  cancelButtonLabel: string;
  removeButtonLabel: string;
  viewLabel: string;
  editLabel: string;
  toggleEditModeAriaLabel: string;
  openAiAssistantTooltip: string;
  openAiAssistantAriaLabel: string;
  closeAiAssistantTooltip: string;
  settingsDialogTitle: string;
  settingsTabLabel: string;
  featuresTabLabel: string;
  datasetLabel: string;
  languageLabel: string;
  datasetSales: string;
  datasetAg: string;
  settingsReloadHint: string;
  devServerConnectionLabel: string;
  devServerConnectedLabel: string;
  devServerConnectedDescription: string;
  devServerChangeInstructions: string;
  devServerNotConnectedDescription: string;
  applyReloadButtonLabel: string;
  closeButtonLabel: string;
  dataSourcesTitle: string;
  filtersTitle: string;
  aiAssistantTitle: string;
  buildPageWithAiTitle: string;
  buildPageWithAiDescription: string;
  doneButtonLabel: string;
  configureWidgetTitle: string;
  widgetFallbackTitle: string;
  adapterModeLabel: string;
  dashboardSavedMessage: string;
  dashboardLoadedMigratedMessage: (
    fromVersion: string | number,
    toVersion: string | number,
  ) => string;
  dashboardLoadedMessage: string;
  dashboardLoadFailedMessage: string;
  resetDemoReloadingMessage: string;
  newPageLabel: string;
}

const enAppLocaleText: AppLocaleText = {
  addPageTooltip: 'Add page',
  addPageAriaLabel: 'Add page',
  undoTooltip: 'Undo (⌘Z)',
  undoAriaLabel: 'Undo',
  redoTooltip: 'Redo (⌘⇧Z)',
  redoAriaLabel: 'Redo',
  dataSourcesTooltip: 'Data sources',
  dataSourcesAriaLabel: 'Data sources',
  configureWidgetTooltip: 'Configure widget',
  configureWidgetAriaLabel: 'Configure widget',
  filtersTooltip: 'Filters',
  filtersAriaLabel: 'Filters',
  downloadTooltip: 'Download dashboard',
  downloadAriaLabel: 'Download dashboard',
  uploadTooltip: 'Upload dashboard',
  uploadAriaLabel: 'Upload dashboard',
  resetTooltip: 'Reset demo',
  resetAriaLabel: 'Reset to demo',
  settingsTooltip: 'Settings',
  settingsAriaLabel: 'Settings',
  addWidgetTooltip: 'Add widget',
  addWidgetAriaLabel: 'Add widget',
  backAriaLabel: 'Back',
  closeComposeDialogAriaLabel: 'Close compose dialog',
  closeDataDialogAriaLabel: 'Close data dialog',
  closeFiltersDialogAriaLabel: 'Close filters dialog',
  closeTooltip: 'Close',
  closeAiAssistantAriaLabel: 'Close AI assistant',
  removePageTitle: 'Remove page?',
  removePageDescription: (pageTitle) =>
    `Remove "${pageTitle}" and all its widgets? This action can be undone.`,
  cancelButtonLabel: 'Cancel',
  removeButtonLabel: 'Remove',
  viewLabel: 'View',
  editLabel: 'Edit',
  toggleEditModeAriaLabel: 'Toggle edit mode',
  openAiAssistantTooltip: 'Open AI assistant',
  openAiAssistantAriaLabel: 'Open AI assistant',
  closeAiAssistantTooltip: 'Close AI assistant',
  settingsDialogTitle: 'Settings',
  settingsTabLabel: 'Settings',
  featuresTabLabel: 'Features',
  datasetLabel: 'Dataset',
  languageLabel: 'Language',
  datasetSales: 'MUI X Sales (generated)',
  datasetAg: 'AG Studio Office Supplies',
  settingsReloadHint: 'Dataset changes take effect after reload.',
  devServerConnectionLabel: 'Dev Server Connection',
  devServerConnectedLabel: 'Connected to:',
  devServerConnectedDescription: 'AI and data queries are routed through the dev server.',
  devServerChangeInstructions: 'To change, update STUDIO_SERVER_URL in .env.local.',
  devServerNotConnectedDescription:
    'Not connected. Set STUDIO_SERVER_URL in .env.local to route queries through examples/x-studio-dev-server.',
  applyReloadButtonLabel: 'Apply & reload',
  closeButtonLabel: 'Close',
  dataSourcesTitle: 'Data sources',
  filtersTitle: 'Filters',
  aiAssistantTitle: 'AI assistant',
  buildPageWithAiTitle: 'Build this page with AI',
  buildPageWithAiDescription: "Describe what you'd like to add and the AI will build it for you.",
  doneButtonLabel: 'Done',
  configureWidgetTitle: 'Configure widget',
  widgetFallbackTitle: 'Widget',
  adapterModeLabel: 'Adapter Mode',
  dashboardSavedMessage: 'Dashboard saved successfully',
  dashboardLoadedMigratedMessage: (fromVersion, toVersion) =>
    `Dashboard loaded and migrated from v${fromVersion} to v${toVersion}`,
  dashboardLoadedMessage: 'Dashboard loaded successfully',
  dashboardLoadFailedMessage: 'Failed to load dashboard',
  resetDemoReloadingMessage: 'Local changes cleared — reloading demo…',
  newPageLabel: 'New Page',
};

const ptBrAppLocaleText: AppLocaleText = {
  addPageTooltip: 'Adicionar página',
  addPageAriaLabel: 'Adicionar página',
  undoTooltip: 'Desfazer (⌘Z)',
  undoAriaLabel: 'Desfazer',
  redoTooltip: 'Refazer (⌘⇧Z)',
  redoAriaLabel: 'Refazer',
  dataSourcesTooltip: 'Fontes de dados',
  dataSourcesAriaLabel: 'Fontes de dados',
  configureWidgetTooltip: 'Configurar widget',
  configureWidgetAriaLabel: 'Configurar widget',
  filtersTooltip: 'Filtros',
  filtersAriaLabel: 'Filtros',
  downloadTooltip: 'Baixar painel',
  downloadAriaLabel: 'Baixar painel',
  uploadTooltip: 'Carregar painel',
  uploadAriaLabel: 'Carregar painel',
  resetTooltip: 'Redefinir demonstração',
  resetAriaLabel: 'Redefinir demonstração',
  settingsTooltip: 'Configurações',
  settingsAriaLabel: 'Configurações',
  addWidgetTooltip: 'Adicionar widget',
  addWidgetAriaLabel: 'Adicionar widget',
  backAriaLabel: 'Voltar',
  closeComposeDialogAriaLabel: 'Fechar diálogo de composição',
  closeDataDialogAriaLabel: 'Fechar diálogo de dados',
  closeFiltersDialogAriaLabel: 'Fechar diálogo de filtros',
  closeTooltip: 'Fechar',
  closeAiAssistantAriaLabel: 'Fechar assistente de IA',
  removePageTitle: 'Remover página?',
  removePageDescription: (pageTitle) =>
    `Remover "${pageTitle}" e todos os seus widgets? Esta ação pode ser desfeita.`,
  cancelButtonLabel: 'Cancelar',
  removeButtonLabel: 'Remover',
  viewLabel: 'Visualizar',
  editLabel: 'Editar',
  toggleEditModeAriaLabel: 'Alternar modo de edição',
  openAiAssistantTooltip: 'Abrir assistente de IA',
  openAiAssistantAriaLabel: 'Abrir assistente de IA',
  closeAiAssistantTooltip: 'Fechar assistente de IA',
  settingsDialogTitle: 'Configurações',
  settingsTabLabel: 'Configurações',
  featuresTabLabel: 'Recursos',
  datasetLabel: 'Conjunto de dados',
  languageLabel: 'Idioma',
  datasetSales: 'Vendas do MUI X (geradas)',
  datasetAg: 'Suprimentos de escritório do AG Studio',
  settingsReloadHint: 'As alterações no conjunto de dados entram em vigor após recarregar.',
  devServerConnectionLabel: 'Conexão com o servidor de desenvolvimento',
  devServerConnectedLabel: 'Conectado a:',
  devServerConnectedDescription:
    'As consultas de IA e dados são roteadas pelo servidor de desenvolvimento.',
  devServerChangeInstructions: 'Para alterar, atualize STUDIO_SERVER_URL em .env.local.',
  devServerNotConnectedDescription:
    'Não conectado. Defina STUDIO_SERVER_URL em .env.local para rotear consultas por examples/x-studio-dev-server.',
  applyReloadButtonLabel: 'Aplicar e recarregar',
  closeButtonLabel: 'Fechar',
  dataSourcesTitle: 'Fontes de dados',
  filtersTitle: 'Filtros',
  aiAssistantTitle: 'Assistente de IA',
  buildPageWithAiTitle: 'Crie esta página com IA',
  buildPageWithAiDescription: 'Descreva o que você gostaria de adicionar e a IA criará para você.',
  doneButtonLabel: 'Concluir',
  configureWidgetTitle: 'Configurar widget',
  widgetFallbackTitle: 'Widget',
  adapterModeLabel: 'Modo do adaptador',
  dashboardSavedMessage: 'Painel salvo com sucesso',
  dashboardLoadedMigratedMessage: (fromVersion, toVersion) =>
    `Painel carregado e migrado da v${fromVersion} para a v${toVersion}`,
  dashboardLoadedMessage: 'Painel carregado com sucesso',
  dashboardLoadFailedMessage: 'Falha ao carregar o painel',
  resetDemoReloadingMessage: 'Alterações locais removidas — recarregando a demonstração…',
  newPageLabel: 'Nova página',
};

export interface LocaleBundle {
  /** dayjs locale string (for AdapterDayjs). */
  dayjsLocale: string;
  /** Studio locale text partial (for Studio localeText prop). */
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
  'pt-BR': {
    dayjsLocale: 'pt-br',
    studioLocaleText: ptBRLocaleText,
    pickersLocaleText: pickersPtBR.components.MuiLocalizationProvider.defaultProps.localeText,
    appLocaleText: ptBrAppLocaleText,
  },
};

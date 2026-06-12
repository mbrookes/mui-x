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
  undoTooltip: string;
  undoAriaLabel: string;
  redoTooltip: string;
  redoAriaLabel: string;
  downloadTooltip: string;
  downloadAriaLabel: string;
  uploadTooltip: string;
  uploadAriaLabel: string;
  resetTooltip: string;
  resetAriaLabel: string;
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
  serverAdapterLabel: string;
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
  resetDemoReloadingMessage: string;
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
  resetTooltip: 'Reset demo',
  resetAriaLabel: 'Reset to demo',
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
  serverAdapterLabel: 'Simulated server adapter',
  settingsReloadHint: 'Dataset, row count and adapter changes take effect after reload.',
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
  adapterModeLabel: 'Adapter Mode',
  serverModeLabel: 'Server Mode',
  generatedRowsLabel: (rowCount) => `Generated · ${rowCount.toLocaleString()} rows`,
  demoDataLabel: 'Demo Data',
  dashboardSavedMessage: 'Dashboard saved successfully',
  dashboardLoadedMigratedMessage: (fromVersion, toVersion) =>
    `Dashboard loaded and migrated from v${fromVersion} to v${toVersion}`,
  dashboardLoadedMessage: 'Dashboard loaded successfully',
  dashboardLoadFailedMessage: 'Failed to load dashboard',
  resetDemoReloadingMessage: 'Local changes cleared — reloading demo…',
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
  resetTooltip: 'Redefinir demonstração',
  resetAriaLabel: 'Redefinir demonstração',
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
  serverAdapterLabel: 'Adaptador de servidor simulado',
  settingsReloadHint:
    'As alterações de conjunto de dados, número de linhas e adaptador entram em vigor após recarregar.',
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
  adapterModeLabel: 'Modo do adaptador',
  serverModeLabel: 'Modo do servidor',
  generatedRowsLabel: (rowCount) => `Gerado · ${rowCount.toLocaleString()} linhas`,
  demoDataLabel: 'Dados de demonstração',
  dashboardSavedMessage: 'Painel salvo com sucesso',
  dashboardLoadedMigratedMessage: (fromVersion, toVersion) =>
    `Painel carregado e migrado da v${fromVersion} para a v${toVersion}`,
  dashboardLoadedMessage: 'Painel carregado com sucesso',
  dashboardLoadFailedMessage: 'Falha ao carregar o painel',
  resetDemoReloadingMessage: 'Alterações locais removidas — recarregando a demonstração…',
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
  'pt-BR': {
    dayjsLocale: 'pt-br',
    studioLocaleText: ptBRLocaleText,
    pickersLocaleText: pickersPtBR.components.MuiLocalizationProvider.defaultProps.localeText,
    appLocaleText: ptBrAppLocaleText,
  },
};

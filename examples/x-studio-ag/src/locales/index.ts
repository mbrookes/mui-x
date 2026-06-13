export type SupportedLocale = 'en' | 'fr' | 'de' | 'es' | 'pt-BR';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
};

export interface AppLocaleText {
  // Toolbar
  editModeLabel: string;
  viewModeLabel: string;
  saveButtonLabel: string;
  loadButtonLabel: string;
  settingsButtonLabel: string;

  // Settings dialog
  settingsDialogTitle: string;
  datasetLabel: string;
  datasetSalesLabel: string;
  datasetAgLabel: string;
  sidebarPositionLabel: string;
  sidebarLeft: string;
  sidebarRight: string;
  rowCountLabel: string;
  rowCountHelper: string;
  dataSourceModeLabel: string;
  dataModeMemory: string;
  serverAdapterLabel: string;
  reloadNotice: string;
  closeButton: string;
  applyReloadButton: string;
  languageLabel: string;
}

const enLocaleText: AppLocaleText = {
  editModeLabel: 'Edit',
  viewModeLabel: 'View',
  saveButtonLabel: 'Save',
  loadButtonLabel: 'Load',
  settingsButtonLabel: 'Settings',

  settingsDialogTitle: 'Settings',
  datasetLabel: 'Dataset',
  datasetSalesLabel: 'Sales (default)',
  datasetAgLabel: 'AG Studio Data',
  sidebarPositionLabel: 'Sidebar position',
  sidebarLeft: 'Left',
  sidebarRight: 'Right',
  rowCountLabel: 'Generated row count',
  rowCountHelper: 'Leave blank to use the default bundled data',
  dataSourceModeLabel: 'Data source mode',
  dataModeMemory: 'In-memory (default)',
  serverAdapterLabel: 'Simulated server adapter',
  reloadNotice: 'Changes take effect after reload.',
  closeButton: 'Close',
  applyReloadButton: 'Apply & Reload',
  languageLabel: 'Language',
};

const ptBRLocaleText: AppLocaleText = {
  editModeLabel: 'Editar',
  viewModeLabel: 'Visualizar',
  saveButtonLabel: 'Salvar',
  loadButtonLabel: 'Carregar',
  settingsButtonLabel: 'Configurações',

  settingsDialogTitle: 'Configurações',
  datasetLabel: 'Conjunto de dados',
  datasetSalesLabel: 'Vendas (padrão)',
  datasetAgLabel: 'AG Studio Data',
  sidebarPositionLabel: 'Posição do painel lateral',
  sidebarLeft: 'Esquerda',
  sidebarRight: 'Direita',
  rowCountLabel: 'Número de linhas geradas',
  rowCountHelper: 'Deixe em branco para usar os dados padrão',
  dataSourceModeLabel: 'Modo da fonte de dados',
  dataModeMemory: 'Em memória (padrão)',
  serverAdapterLabel: 'Adaptador de servidor simulado',
  reloadNotice: 'As alterações entram em vigor após recarregar.',
  closeButton: 'Fechar',
  applyReloadButton: 'Aplicar e recarregar',
  languageLabel: 'Idioma',
};

export interface LocaleBundle {
  appLocaleText: AppLocaleText;
}

export const LOCALE_BUNDLES: Record<SupportedLocale, LocaleBundle> = {
  en: { appLocaleText: enLocaleText },
  fr: { appLocaleText: enLocaleText },
  de: { appLocaleText: enLocaleText },
  es: { appLocaleText: enLocaleText },
  'pt-BR': { appLocaleText: ptBRLocaleText },
};

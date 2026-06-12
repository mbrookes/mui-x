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
  newPageTitle: (pageNumber: number) => string;
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
  newChatTooltip: string;
  searchTooltip: string;
  recentChatsTooltip: string;
  recentChatsTitle: string;
  favoritesTooltip: string;
  favoritesTitle: string;
  favoritesEmptyText: string;
  chatsEmptyText: string;
  renameTooltip: string;
  addToFavoritesTooltip: string;
  removeFromFavoritesTooltip: string;
  searchPlaceholder: string;
  searchNoResultsText: string;
  searchEmptyText: string;
  chatHomeTitle: string;
  chatHomeDescription: string;
  chatInputPlaceholder: string;
  homeSuggestions: string[];
  settingsDialogTitle: string;
  languageLabel: string;
  devServerConnectionLabel: string;
  devServerConnectedLabel: string;
  devServerConnectedDescription: string;
  devServerChangeInstructions: string;
  serverUrlLabel: string;
  serverUrlHelper: string;
  serverUrlPlaceholder: string;
  serverUrlSessionHint: string;
  closeButtonLabel: string;
  newChatTitle: string;
  aiNotConfiguredMessage: string;
}

const enAppLocaleText: AppLocaleText = {
  addPageTooltip: 'Add page',
  addPageAriaLabel: 'Add page',
  newPageTitle: (pageNumber) => `Page ${pageNumber}`,
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
  newChatTooltip: 'New Chat',
  searchTooltip: 'Search',
  recentChatsTooltip: 'Recent Chats',
  recentChatsTitle: 'Recent Chats',
  favoritesTooltip: 'Favorites',
  favoritesTitle: 'Favorites',
  favoritesEmptyText: 'No favorites yet',
  chatsEmptyText: 'No chats yet',
  renameTooltip: 'Rename',
  addToFavoritesTooltip: 'Add to favorites',
  removeFromFavoritesTooltip: 'Remove from favorites',
  searchPlaceholder: 'Search chats…',
  searchNoResultsText: 'No chats match your search.',
  searchEmptyText: 'No chats yet.',
  chatHomeTitle: 'What would you like to build?',
  chatHomeDescription: 'Describe a dashboard and AI will build it from your sales data.',
  chatInputPlaceholder: 'Ask me anything about your data…',
  homeSuggestions: [
    'Show revenue by category as a bar chart',
    'Which products have the highest margin?',
    'Add a KPI for total orders this month',
    'Show customer distribution by country',
    'Identify any anomalies in the sales data',
    'Build an overview dashboard with key metrics',
  ],
  settingsDialogTitle: 'Settings',
  languageLabel: 'Language',
  devServerConnectionLabel: 'Dev Server Connection',
  devServerConnectedLabel: 'Connected to:',
  devServerConnectedDescription: 'AI and data queries are routed through the dev server.',
  devServerChangeInstructions: 'To change, update STUDIO_SERVER_URL in .env.local.',
  serverUrlLabel: 'Server URL',
  serverUrlHelper: 'Optional. Set STUDIO_SERVER_URL in .env.local to persist.',
  serverUrlPlaceholder: 'http://localhost:3020',
  serverUrlSessionHint:
    'URL changes here apply only for this session — the page must reload to take effect. Add to .env.local to persist.',
  closeButtonLabel: 'Close',
  newChatTitle: 'New Chat',
  aiNotConfiguredMessage: 'AI is not configured. Set STUDIO_SERVER_URL in your .env.local file.',
};

const ptBrAppLocaleText: AppLocaleText = {
  addPageTooltip: 'Adicionar página',
  addPageAriaLabel: 'Adicionar página',
  newPageTitle: (pageNumber) => `Página ${pageNumber}`,
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
  newChatTooltip: 'Nova conversa',
  searchTooltip: 'Pesquisar',
  recentChatsTooltip: 'Conversas recentes',
  recentChatsTitle: 'Conversas recentes',
  favoritesTooltip: 'Favoritos',
  favoritesTitle: 'Favoritos',
  favoritesEmptyText: 'Nenhum favorito ainda',
  chatsEmptyText: 'Nenhuma conversa ainda',
  renameTooltip: 'Renomear',
  addToFavoritesTooltip: 'Adicionar aos favoritos',
  removeFromFavoritesTooltip: 'Remover dos favoritos',
  searchPlaceholder: 'Pesquisar conversas…',
  searchNoResultsText: 'Nenhuma conversa corresponde à sua pesquisa.',
  searchEmptyText: 'Nenhuma conversa ainda.',
  chatHomeTitle: 'O que você gostaria de criar?',
  chatHomeDescription: 'Descreva um painel e a IA o criará a partir dos seus dados de vendas.',
  chatInputPlaceholder: 'Pergunte qualquer coisa sobre seus dados…',
  homeSuggestions: [
    'Mostrar receita por categoria como gráfico de barras',
    'Quais produtos têm a maior margem?',
    'Adicionar um KPI para o total de pedidos deste mês',
    'Mostrar a distribuição de clientes por país',
    'Identificar possíveis anomalias nos dados de vendas',
    'Criar um painel de visão geral com métricas principais',
  ],
  settingsDialogTitle: 'Configurações',
  languageLabel: 'Idioma',
  devServerConnectionLabel: 'Conexão com o servidor de desenvolvimento',
  devServerConnectedLabel: 'Conectado a:',
  devServerConnectedDescription:
    'As consultas de IA e dados são roteadas pelo servidor de desenvolvimento.',
  devServerChangeInstructions: 'Para alterar, atualize STUDIO_SERVER_URL em .env.local.',
  serverUrlLabel: 'URL do servidor',
  serverUrlHelper: 'Opcional. Defina STUDIO_SERVER_URL em .env.local para persistir.',
  serverUrlPlaceholder: 'http://localhost:3020',
  serverUrlSessionHint:
    'As alterações de URL aqui valem apenas para esta sessão — a página precisa ser recarregada para entrarem em vigor. Adicione em .env.local para persistir.',
  closeButtonLabel: 'Fechar',
  newChatTitle: 'Nova conversa',
  aiNotConfiguredMessage:
    'A IA não está configurada. Defina STUDIO_SERVER_URL no seu arquivo .env.local.',
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

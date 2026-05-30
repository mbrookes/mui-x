import type { StudioLocaleText } from '../internals/StudioUIConfigContext';

/**
 * Brazilian Portuguese (pt-BR) locale text for Studio.
 *
 * @example
 * ```tsx
 * import { ptBRLocaleText } from '@mui/x-studio';
 * <Studio localeText={ptBRLocaleText} />
 * ```
 */
export const ptBRLocaleText: Partial<StudioLocaleText> = {
  // Drawers
  dataDrawerTitle: 'Dados',
  composeDrawerTitle: 'Compor',
  filtersDrawerTitle: 'Filtros',

  // Date range presets
  dateRangePresetAllTime: 'Todo período',
  dateRangePresetYTD: 'Ano atual',
  dateRangePresetThisMonth: 'Este mês',
  dateRangePresetLast3Months: 'Últimos 3 meses',
  dateRangePresetLast12Months: 'Últimos 12 meses',

  // Filters drawer
  filterSearchPlaceholder: 'Pesquisar filtros…',
  filtersSectionPageFiltersTitle: 'Filtros da página',
  filtersSectionNoFilters: 'Nenhum filtro aplicado.',
  filtersSectionNoMatchingFilters: 'Nenhum filtro correspondente.',
  filtersAddFilterTooltip: 'Adicionar filtro',
  filtersSavedViewsTitle: 'Visualizações salvas',
  filtersSaveViewTooltip: 'Salvar filtros da página como uma visualização nomeada',
  filtersSaveViewButton: 'Salvar',
  filtersSaveViewPlaceholder: 'Nome da visualização',
  filtersDeleteViewTooltip: 'Excluir visualização',
  filtersNoSavedViews: 'Nenhuma visualização salva. Aplique filtros e salve aqui.',
  filtersAddDataSourceHint: 'Adicione uma fonte de dados e widgets primeiro.',

  // Widget states
  widgetConfigureChartHint: 'Use a aba Configurar para configurar este gráfico.',
  widgetConfigureGaugeHint: 'Use a aba Configurar para escolher o campo de valor do medidor.',
  widgetConfigurePivotHint: 'Use a aba Configurar para configurar a tabela dinâmica.',
  widgetConfigureMapHint: 'Use a aba Configurar para escolher o campo de país e o campo de valor.',
  widgetNoData: 'Sem dados',
  widgetLoadError: 'Falha ao carregar dados',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Abrir painel de filtros',
  quickFilterBarClearAll: 'Limpar todos os filtros da página',

  // Widget actions
  widgetEditTooltip: 'Editar widget',
  widgetExportCsvTooltip: 'Exportar como CSV',
  widgetExportPngTooltip: 'Exportar como PNG',
  widgetExpandTooltip: 'Expandir gráfico',
  widgetMoveToPageLabel: 'Mover para página',

  // AI assistant
  aiAssistantOpenTooltip: 'Abrir assistente de IA',
  aiAssistantCloseTooltip: 'Fechar assistente de IA',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Descrever um widget',
  aiCreateWidgetPlaceholder:
    'ex.: Gráfico de barras mostrando receita por país, KPI de pedidos totais\u2026',
  aiCreateWidgetButton: 'Criar',
  aiCreateWidgetLoading: 'Criando\u2026',
  aiCreateWidgetError: 'Falha ao criar widget',
};

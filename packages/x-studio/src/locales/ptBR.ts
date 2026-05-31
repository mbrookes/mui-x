import type { StudioLocaleText } from '../internals/StudioUIConfigContext';
import { getStudioLocalization, type Localization } from './utils/getStudioLocalization';

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
  filterSearchPlaceholder: 'Pesquisar filtros\u2026',
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
  quickFilterBarFiltered: 'Filtrado',

  // Widget card actions
  widgetEditTooltip: 'Editar widget',
  widgetExportCsvTooltip: 'Exportar como CSV',
  widgetExportPngTooltip: 'Exportar como PNG',
  widgetExpandTooltip: 'Expandir gráfico',
  widgetMoveToPageLabel: 'Mover para página',
  widgetDuplicateTooltip: 'Duplicar widget',
  widgetDeleteTooltip: 'Excluir widget',
  widgetAiAssistantTooltip: 'Assistente de IA',
  widgetAiInsightTooltip: 'Insight de IA',
  widgetDetectAnomalyTooltip: 'Detectar anomalias',
  widgetHideAnomalyTooltip: 'Ocultar anomalias',
  widgetExplainAnomalyTooltip: 'Explicar anomalias',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Configurar',
  widgetEditDialogTabFilters: 'Filtros',
  widgetEditDialogTabFormat: 'Formatar',
  widgetEditDialogCloseAriaLabel: 'Fechar diálogo de edição',
  widgetUntitledLabel: (kindLabel) => `${kindLabel} sem título`,

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

  // AI dashboard summary panel
  aiSummaryTitle: 'Resumo do painel',
  aiSummarizeTooltip: 'Resumir painel',
  aiRegenerateTooltip: 'Regenerar',
  aiCopyTooltip: 'Copiar',
  aiCopiedTooltip: 'Copiado!',
  aiCloseTooltip: 'Fechar',

  // Widget type names
  widgetKindGrid: 'Tabela',
  widgetKindChart: 'Gráfico',
  widgetKindKpi: 'KPI',
  widgetKindText: 'Texto',
  widgetKindFilter: 'Filtro',
  widgetKindPivot: 'Tabela Dinâmica',
  widgetKindMap: 'Mapa',

  // Data type labels
  dataTypeString: 'Texto',
  dataTypeNumber: 'Número',
  dataTypeBoolean: 'Booleano',
  dataTypeDate: 'Data',
  dataTypeDatetime: 'Data e hora',

  // Compose drawer / widget picker
  composeDrawerTabSetup: 'Configurar',
  composeChooseWidgetType: 'Escolha um tipo de widget',
  composeNoDataSources:
    'Nenhuma fonte de dados disponível. Apenas widgets de texto podem ser adicionados.',
  composeOnThisPage: 'Nesta página',
  composeAddWidgetLabel: (widgetTypeLabel) => `Adicionar widget ${widgetTypeLabel}`,
  composeCloseAriaLabel: 'Fechar',
  composeBackToWidgetTypesAriaLabel: 'Voltar para tipos de widget',
  composeCancel: 'Cancelar',

  // Format panel
  formatAutoTitle: 'Título gerado automaticamente',
  formatResetTitle: 'Redefinir para título gerado automaticamente',
  formatAutoSubtitle: 'Subtítulo gerado automaticamente',
  formatResetSubtitle: 'Redefinir para subtítulo gerado automaticamente',

  // Data drawer
  dataDrawerNoSources:
    'Nenhuma fonte de dados configurada. Adicione um widget ao painel para carregar dados de exemplo.',
  dataDrawerViewLineage: 'Ver linhagem de dados',
  dataDrawerLineageTitle: 'Linhagem de dados',
  dataDrawerLineageHelper:
    'Clique em um nó para visualizar seus dados. Clique em uma aresta para inspecionar os campos de chave de junção.',
  dataDrawerRowsLabel: 'linhas',
  dataDrawerFieldsLabel: 'campos',
  dataDrawerBackAriaLabel: 'Voltar ao grafo de linhagem',
  dataDrawerCloseAriaLabel: 'Fechar linhagem de dados',
  dataDrawerEditTooltip: 'Editar',
  dataDrawerDeleteTooltip: 'Excluir',

  // Relationship management
  relationshipEditTooltip: 'Editar',
  relationshipRemoveTooltip: 'Remover',
  relationshipCancel: 'Cancelar',
  relationshipTypeManyToOne: 'Muitos-para-um',
  relationshipTypeOneToOne: 'Um-para-um',
  relationshipTypeManyToMany: 'Muitos-para-muitos',

  // Filter conditions & values
  filterConditionAnd: 'E',
  filterConditionOr: 'OU',
  filterOperatorLabel: 'Operador',
  filterRemoveSecondCondition: 'Remover segunda condição',
  filterAbsoluteDate: 'Data absoluta',
  filterRelativeDate: 'Data relativa',
  filterLinkToField: 'Vincular ao campo',
  filterRemoveFieldLink: 'Remover vínculo com campo',
  filterBooleanTrue: 'Verdadeiro',
  filterBooleanFalse: 'Falso',
  filterRemoveAriaLabel: 'Remover filtro',
  filterInteractiveSectionTitle: 'Filtros interativos',
  filterCrossSectionTitle: 'Filtros cruzados',
  filterClearFilter: 'Limpar filtro',
  filterClearAllCrossFilters: 'Limpar todos os filtros cruzados',
  filterRemoveCrossFilter: 'Remover filtro cruzado',
  filterSearchValues: 'Pesquisar valores\u2026',
  filterSelectField: 'Selecione um campo\u2026',
  filterValueLabel: 'Valor',
  filterValueHelper: 'Valor para comparar',
  filterSelectParent: 'Selecione o filtro pai\u2026',
  filterSourceLabel: 'Fonte',
  filterMetricRowLabel: 'Linha de métrica',
  filterFieldLabel: 'Campo',
  filterRankByLabel: 'Classificar por',

  // Expression field dialog
  exprNodeTypeField: 'Campo',
  exprNodeTypeLiteral: 'Literal',
  exprNodeTypeFunction: 'Função',
  exprDataTypeNumber: 'Número',
  exprDataTypeText: 'Texto',
  exprDataTypeBoolean: 'Booleano',
  exprBooleanTrue: 'Verdadeiro',
  exprBooleanFalse: 'Falso',
  exprExpandTooltip: 'Expandir',
  exprCollapseTooltip: 'Recolher',
  exprRemoveInputTooltip: 'Remover entrada',
  exprCancel: 'Cancelar',
  exprSave: 'Salvar',
  exprAddField: 'Adicionar campo',

  // Shared aggregation function labels
  aggFnSum: 'Soma',
  aggFnCount: 'Contagem',
  aggFnCountRows: 'Contagem (linhas)',
  aggFnAverage: 'Média',
  aggFnMin: 'Mín.',
  aggFnMax: 'Máx.',

  // Shared time granularity labels
  timeGranNone: 'Nenhum (valores brutos)',
  timeGranDay: 'Dia',
  timeGranWeek: 'Semana',
  timeGranMonth: 'Mês',
  timeGranQuarter: 'Trimestre',
  timeGranYear: 'Ano',

  // Shared sort direction labels
  sortAscendingAriaLabel: 'Crescente',
  sortDescendingAriaLabel: 'Decrescente',

  // Chart setup panel
  chartSetupValueFieldLabel: 'Campo de valor',
  chartSetupAggregationLabel: 'Agregação',
  chartSetupMinLabel: 'Mín.',
  chartSetupMaxLabel: 'Máx.',
  chartSetupGroupByLabel: 'Agrupar por',
  chartSetupSortByLabel: 'Ordenar por',
  chartSetupSortCategory: 'Categoria',
  chartSetupSortValue: 'Valor',
  chartSetupSortNone: 'Nenhum',
  chartSetupSortPercent: 'Percentual',
  chartSetupAnnotationsTitle: 'Anotações',
  chartSetupInteractionsTitle: 'Interações',
  chartSetupInteractionsDescription: 'Quando outros widgets forem clicados, este gráfico\u2026',
  chartSetupAddSeries: 'Adicionar série',
  chartSetupNoMoreFields: 'Não há mais campos a adicionar',
  chartSetupRemoveSeries: 'Remover série',
  chartSetupAddReferenceLine: 'Adicionar linha de referência',
  chartSetupRemoveAnnotation: 'Remover anotação',
  chartSetupNoReferenceLines: 'Sem linhas de referência. Clique em + para adicionar uma.',
  chartSetupDualYAxis: 'Eixo Y duplo (série de linha no eixo direito)',

  // KPI setup panel
  kpiSetupChartLine: 'Linha',
  kpiSetupChartBar: 'Barra',
  kpiSetupChartGauge: 'Medidor',
  kpiSetupCompPrevPeriod: 'Período anterior (duração equivalente)',
  kpiSetupCompPrevCalendarPeriod: 'Período do calendário anterior',
  kpiSetupCompSameLastYear: 'Mesmo período do ano passado',
  kpiSetupInteractionsTitle: 'Interações',
  kpiSetupInteractionsDescription: 'Quando outros widgets forem clicados, este KPI\u2026',

  // KPI widget
  kpiGrandTotalTooltip:
    'Total geral \u2014 widgets de filtro ativos não são aplicados a este KPI. Ative o modo Filtro cruzado nas configurações do KPI para respeitá-los.',

  // Grid setup panel
  gridSetupDataSourceLabel: 'Fonte de dados',
  gridSetupAllColumnsAdded: 'Todas as colunas disponíveis foram adicionadas',
  gridSetupCrossFilterFieldLabel: 'Campo de filtro cruzado',
  gridSetupCrossFilterFieldHelper:
    'Campo aplicado a outros widgets quando uma linha é selecionada; padrão é a primeira coluna visível',
  gridSetupGroupByLabel: 'Agrupar por',
  gridSetupGroupByHelper: 'Recolher linhas em grupos \u2014 defina a agregação por coluna abaixo',
  gridSetupDefaultSortLabel: 'Ordenação padrão',
  gridSetupConditionalFormattingTitle: 'Formatação condicional',
  gridSetupConditionalCustom: 'Personalizado',
  gridSetupRemoveRuleAriaLabel: 'Remover regra',
  gridSetupInteractionsTitle: 'Interações',
  gridSetupInteractionsDescription: 'Quando outros widgets forem clicados, esta tabela\u2026',

  // Map setup panel
  mapSetupColorBlues: 'Azuis',
  mapSetupColorReds: 'Vermelhos',
  mapSetupColorGreens: 'Verdes',
  mapSetupColorOranges: 'Laranjas',
  mapSetupColorPurples: 'Roxos',
  mapSetupLegendBottom: 'Inferior',
  mapSetupLegendTop: 'Superior',
  mapSetupLegendLeft: 'Esquerda',
  mapSetupLegendRight: 'Direita',
  mapSetupLegendHidden: 'Oculto',

  // Pivot setup panel
  pivotSetupDescription:
    'Crie uma tabulação cruzada escolhendo um campo de linha, campo de coluna e medida de valor.',
  pivotSetupRowFieldLabel: 'Campo de linha',
  pivotSetupRowFieldHelper: 'Campo categórico exibido como grupos de linhas à esquerda',
  pivotSetupColFieldLabel: 'Campo de coluna',
  pivotSetupColFieldHelper: 'Campo categórico distribuído pelos cabeçalhos de coluna',
  pivotSetupValueFieldLabel: 'Campo de valor',
  pivotSetupValueFieldHelper: 'Campo numérico agregado em cada célula',
  pivotSetupShowTotals: 'Mostrar linha e coluna de totais',

  // Filter setup panel
  filterSetupControlTypeLabel: 'Tipo de controle',
  filterSetupMultiSelect: 'Seleção múltipla',
  filterSetupMultiSelectDescription: 'Menu suspenso com caixas de seleção para valores categóricos',
  filterSetupToggleChips: 'Chips de alternância',
  filterSetupToggleChipsDescription: 'Botões chip inline para valores categóricos',
  filterSetupDateRange: 'Intervalo de datas',
  filterSetupDateRangeDescription: 'Seletores de data de início e fim',
  filterSetupSlider: 'Controle deslizante',
  filterSetupSliderDescription: 'Controle deslizante de intervalo para campos numéricos ou de data',
  filterSetupMinLabel: 'Mín.',
  filterSetupMaxLabel: 'Máx.',
  filterSetupStepLabel: 'Passo',
  filterSetupSelectFieldAlert: 'Selecione um campo para configurar o controle de filtro.',

  // Text setup panel
  textSetupTitleLabel: 'Título',
  textSetupTitleHelper: 'Cabeçalho exibido no topo do widget',
  textSetupSubtitleLabel: 'Subtítulo',
  textSetupSubtitleHelper: 'Texto menor abaixo do cabeçalho',
  textSetupBodyLabel: 'Corpo',
  textSetupBodyHelper: 'Conteúdo principal do widget; suporta texto simples',

  // Page config panel
  pageConfigPageSectionTitle: 'Página',
  pageConfigCardsSectionTitle: 'Cartões',
  pageConfigBackgroundColourLabel: 'Cor de fundo',
  pageConfigBackgroundColourPlaceholder: 'ex.: #f5f5f5',
  pageConfigCardBackgroundLabel: 'Fundo do cartão',
  pageConfigCardBackgroundPlaceholder: 'ex.: #ffffff',
  pageConfigPaddingLabel: 'Preenchimento',
  pageConfigCornerRadiusLabel: 'Raio do canto (px)',
  pageConfigCardBorderLabel: 'Borda do cartão',
  pageConfigBorderColourLabel: 'Cor da borda',
  pageConfigBorderColourPlaceholder: 'ex.: #e0e0e0',
  pageConfigBorderWidthLabel: 'Largura da borda (px)',
};

export const ptBR: Localization = getStudioLocalization(ptBRLocaleText);

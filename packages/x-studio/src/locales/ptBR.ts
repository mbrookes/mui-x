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
  dateRangeBarFieldLabel: 'Intervalo de datas',

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

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Fechar configuração do widget',
  sidebarPanelsAriaLabel: 'Painéis laterais',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Aumentar',
  numberFieldDecreaseAriaLabel: 'Diminuir',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Fechar gráfico expandido',
  widgetCardExportPngAriaLabel: 'Exportar gráfico expandido como PNG',

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

  // Widget type descriptions
  widgetKindTextDescription: 'Título, subtítulo e corpo de texto',
  widgetKindKpiDescription: 'Métrica única com agregação',
  widgetKindChartDescription: 'Visualize dados com um gráfico configurável',
  widgetKindGridDescription: 'Grade de dados com ordenação e filtragem',
  widgetKindFilterDescription: 'Controle de filtro interativo para o modo de visualização',
  widgetKindPivotDescription: 'Tabulação cruzada com dimensões de linha e coluna',
  widgetKindMapDescription: 'Mapa coroplético mundial por país',
  composeCustomWidgetDescription: 'Widget personalizado',

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
  formatPanelCompactNumbers: 'Números compactos',
  formatPanelWidgetTitleLabel: 'Título do widget',
  formatPanelWidgetTitleHelperText: 'Exibido no cabeçalho do widget',
  formatPanelSubtitleLabel: 'Subtítulo',
  formatPanelSubtitleHelperText: 'Linha opcional exibida abaixo do título',

  // Text format panel
  textFormatFontFamilyLabel: 'Família da fonte',
  textFormatFontSizeLabel: 'Tamanho da fonte',
  textFormatColorLabel: 'Cor',
  textFormatColorPlaceholder: 'Padrão',
  textFormatAlignLeftAriaLabel: 'Alinhar à esquerda',
  textFormatAlignCenterAriaLabel: 'Centralizar',
  textFormatAlignRightAriaLabel: 'Alinhar à direita',
  textFormatDefaultFont: 'Padrão (tema)',
  textFormatSerifFont: 'Serifa',
  textFormatMonospaceFont: 'Monoespaçada',
  textFormatDefaultSize: 'Padrão',
  textFormatAlignmentLabel: 'Alinhamento',

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
  dataDrawerViewSourceTooltip: 'Ver dados da fonte',
  dataDrawerAddCalculatedField: 'Adicionar campo calculado',
  dataDrawerNoData: (sourceLabel) => `Sem dados disponíveis para ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} ${count === 1 ? 'linha' : 'linhas'} a mais`,
  dataDrawerMoreColumns: (count) => `${count} ${count === 1 ? 'coluna' : 'colunas'} a mais`,
  dataDrawerViewSourceLink: 'Ver dados da fonte →',
  dataDrawerMorePreviewRows: (count) => `+${count} a mais`,
  lineageTypePrefix: (type) => `Tipo: ${type}`,
  lineageJoinDetail: (srcSource, srcField, tgtSource, tgtField) =>
    `Junção: ${srcSource}.${srcField} = ${tgtSource}.${tgtField}`,
  lineageViaDetail: (via) => `Via: ${via}`,
  lineagePreviewAriaLabel: (label) => `Visualizar ${label}`,
  lineageNoRelationships: 'Nenhum relacionamento definido entre as fontes',

  // Relationship management
  relationshipEditTooltip: 'Editar',
  relationshipRemoveTooltip: 'Remover',
  relationshipCancel: 'Cancelar',
  relationshipTypeManyToOne: 'Muitos-para-um',
  relationshipTypeOneToOne: 'Um-para-um',
  relationshipTypeManyToMany: 'Muitos-para-muitos',
  relationshipTypeLabel: 'Tipo',
  relationshipJoinFieldLabel: 'Campo de junção',
  relationshipJunctionTableLabel: 'Tabela de junção (ponte)',
  relationshipJunctionSourceLabel: 'Fonte de junção',
  relationshipJunctionSourceFkLabel: '\u2192 FK de origem',
  relationshipJunctionTargetFkLabel: '\u2192 FK de destino',
  relationshipAddTitle: 'Adicionar relacionamento',
  relationshipEditTitle: 'Editar relacionamento',
  relationshipSourceManyLabel: 'Lado muitos',
  relationshipSourceLabel: 'Origem',
  relationshipTargetOneLabel: 'Lado um',
  relationshipTargetLabel: 'Destino',
  relationshipUpdate: 'Atualizar',
  relationshipAdd: 'Adicionar',
  relationshipSectionTitle: 'Relacionamentos',
  relationshipAddButton: 'Adicionar',
  relationshipNone: 'Nenhum relacionamento configurado.',
  relationshipVia: (junctionLabel) => `via ${junctionLabel}`,

  // Filter conditions & values
  filterConditionAnd: 'E',
  filterConditionOr: 'OU',
  filterOperatorLabel: 'Operador',
  filterRemoveSecondCondition: 'Remover segunda condição',
  filterAbsoluteDate: 'Data absoluta',
  filterRelativeDate: 'Data relativa',
  filterBooleanTrue: 'Verdadeiro',
  filterBooleanFalse: 'Falso',
  filterRemoveAriaLabel: 'Remover filtro',
  filterInteractiveSectionTitle: 'Filtros interativos',
  filterCrossSectionTitle: 'Filtros cruzados',
  filterClearFilter: 'Limpar filtro',
  filterClearInteractiveAriaLabel: 'Limpar filtro interativo',
  filterClearAllCrossFilters: 'Limpar todos os filtros cruzados',
  filterRemoveCrossFilter: 'Remover filtro cruzado',
  filterSearchValues: 'Pesquisar valores\u2026',
  filterSelectField: 'Selecione um campo\u2026',
  filterValueLabel: 'Valor',
  filterValueHelper: 'Valor para comparar',
  filterValueAmountLabel: 'Valor',
  filterSelectParent: 'Selecione o filtro pai\u2026',
  filterFieldLabel: 'Campo',
  filterRankByLabel: 'Classificar por',
  filterSelectionNoValues: 'Nenhum valor encontrado.',
  filterSelectionAll: 'Todos',
  filterSelectionSelectedCount: (count) => `${count} selecionado${count === 1 ? '' : 's'}`,
  filterSectionNoInteractiveFilters:
    'Nenhum filtro interativo ativo. Use widgets de filtro na tela para definir filtros.',
  filterSectionNoCrossFilters:
    'Nenhum filtro cruzado ativo. Clique em elementos do gráfico ou selecione linhas da tabela para criar filtros cruzados.',
  filterSectionSelectedCount: (count) => `${count} selecionado${count === 1 ? '' : 's'}`,
  filterSectionValueDisplay: (fieldLabel, value) => `${fieldLabel} = ${value}`,
  filterSectionSourcePrefix: (widgetTitle) => `De: ${widgetTitle}`,
  filterBodyAddCondition: 'Adicionar condição',
  filterBodyNarrowOptions: 'Restringir opções com base em:',
  filterModeFilter: 'Filtrar',
  filterModeSelect: 'Selecionar',
  filterModeRank: 'Classificar',
  filterRelativeUnitSeconds: 'segundos',
  filterRelativeUnitMinutes: 'minutos',
  filterRelativeUnitHours: 'horas',
  filterRelativeUnitDays: 'dias',
  filterRelativeUnitWeeks: 'semanas',
  filterRelativeUnitMonths: 'meses',
  filterRelativeUnitYears: 'anos',
  filterDatePreset7Days: '7 dias',
  filterDatePreset30Days: '30 dias',
  filterDatePreset3Months: '3 meses',
  filterDatePreset12Months: '12 meses',
  filterDatePreset1Year: '1 ano',
  filterRelativeDateAgo: 'atrás',
  filterRelativeDateFromNow: 'a partir de agora',
  filterDateLabel: 'Data',
  filterRankAggSumLabel: 'Soma de todas as séries',
  filterRankAggAvgLabel: 'Média de todas as séries',
  filterRankAggMaxLabel: 'Máximo de todas as séries',
  filterRankAggMinLabel: 'Mínimo de todas as séries',
  filterRankTop: 'Maiores',
  filterRankBottom: 'Menores',

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
  expressionNameLabel: 'Nome',
  expressionNameHelperText: 'Usado como rótulo do campo em seletores e colunas da tabela',
  expressionNamePlaceholder: 'ex.: Lucro, Receita por Unidade',
  expressionDescriptionLabel: 'Descrição',
  expressionDescriptionHelperText:
    'Opcional. Exibido como dica de ferramenta nos seletores de campo',
  expressionDescriptionPlaceholder: 'Opcional: descreva o que este campo calcula',
  expressionPrecisionLabel: 'Precisão',
  expressionPrecisionHelperText:
    'Casas decimais (0\u201310) usadas na formatação deste campo calculado',

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
  crossFilterModeHighlight: 'Destacar',
  crossFilterModeFilter: 'Filtrar',
  crossFilterModeNone: 'Nenhum',

  // Chart setup panel
  chartTypePickerLabel: 'Tipo de gráfico',
  chartTypeBarGrouped: 'Barra (agrupado)',
  chartTypeBarStacked: 'Barra (empilhado)',
  chartTypeBar100: 'Barra (100%)',
  chartTypeBarHorizontal: 'Barra (horizontal)',
  chartTypeBarStackedHorizontal: 'Barra (empilhado, horizontal)',
  chartTypeBar100Horizontal: 'Barra (100%, horizontal)',
  chartTypeLine: 'Linha',
  chartTypeArea: 'Área',
  chartTypeAreaStacked: 'Área (empilhada)',
  chartTypeArea100: 'Área (100%)',
  chartTypeScatter: 'Dispersão',
  chartTypeMixed: 'Misto (barra + linha)',
  chartTypeHeatmap: 'Mapa de calor',
  chartTypeFunnel: 'Funil',
  chartTypeGantt: 'Gantt / Linha do tempo',
  chartTypeSankey: 'Sankey',
  chartTypePie: 'Pizza',
  chartTypeDonut: 'Rosca',
  chartTypeGauge: 'Medidor',
  chartSetupValueFieldLabel: 'Campo de valor',
  chartSetupValueFieldHelperText: 'Campo numérico a agregar',
  chartSetupAggregationLabel: 'Agregação',
  chartSetupMinLabel: 'Mín.',
  chartSetupMaxLabel: 'Máx.',
  chartSetupGroupByLabel: 'Agrupar por',
  chartSetupSortByLabel: 'Ordenar por',
  chartSetupSortCategory: 'Categoria',
  chartSetupSortValue: 'Valor',
  chartSetupSortNatural: 'Natural',
  chartSetupSortNone: 'Nenhum',
  chartSetupSortPercent: 'Percentual',
  chartSetupSortDirectionAriaLabel: 'Direção da ordenação',
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
  chartSetupReferenceLineValueLabel: 'Valor',
  chartSetupReferenceLineLabelLabel: 'Rótulo',
  chartSetupYFieldLabel: 'Campo Y (numérico)',
  chartSetupYFieldHelperText: 'Campo numérico plotado no eixo vertical',
  chartSetupColorByLabel: 'Colorir por (opcional)',
  chartSetupColorByHelperText: 'Divide os pontos em séries por categoria com código de cores',
  chartSetupSizeByLabel: 'Tamanho por (opcional)',
  chartSetupSizeByHelperText:
    'Campo numérico que controla o raio da bolha (produz um gráfico de bolhas)',
  chartSetupMinRadiusLabel: 'Raio mínimo',
  chartSetupMaxRadiusLabel: 'Raio máximo',
  chartSetupFunnelValueHelperText:
    'Campo numérico somado por estágio \u2014 os estágios são ordenados por valor (maior primeiro)',
  chartSetupHeatmapRowAxisLabel: 'Campo do eixo de linha',
  chartSetupHeatmapRowAxisHelperText:
    'Campo para o eixo vertical (linha) — qualquer tipo de campo, ex.: categoria, desconto % ou hora do dia',
  chartSetupHeatmapValueLabel: 'Campo de valor / cor',
  chartSetupHeatmapValueHelperText:
    'Campo numérico somado por célula para determinar a intensidade da cor',
  chartSetupHeatmapColourSchemeLabel: 'Esquema de cores',
  chartSetupHeatmapSortByLabel: 'Ordenar por',
  chartSetupHeatmapSortXAxis: 'Eixo de colunas (X)',
  chartSetupHeatmapSortYAxis: 'Eixo de linhas (Y)',
  chartSetupArcLabelLabel: 'Rótulo de arco',
  chartSetupMinAngleLabel: 'Ângulo mínimo (\u00b0)',
  chartSetupMinAngleHelperText: 'Fatias menores que este ângulo (graus) n\u00e3o exibirão rótulo',
  chartSetupGanttLabelFieldLabel: 'Campo de rótulo',
  chartSetupGanttLabelFieldHelperText:
    'Campo exibido como rótulo de linha no eixo Y (ex.: nome de tarefa ou pedido)',
  chartSetupGanttStartDateLabel: 'Campo de data de início',
  chartSetupGanttStartDateHelperText: 'Campo de data/hora para o início de cada barra',
  chartSetupGanttEndDateLabel: 'Campo de data de fim',
  chartSetupGanttEndDateHelperText: 'Campo de data/hora para o fim de cada barra',
  chartSetupGanttColourByLabel: 'Colorir por (opcional)',
  chartSetupGanttColourByHelperText:
    'Campo categórico usado para colorir as barras (ex.: status ou categoria)',
  chartSetupXFieldNumericLabel: 'Campo X (numérico)',
  chartSetupXFieldCategoryVertLabel: 'Campo Y / categoria',
  chartSetupXFieldCategoryHorizLabel: 'Campo X / categoria',
  chartSetupXFieldHorizontalHelperText: 'Plotado no eixo horizontal',
  chartSetupXFieldGroupVertHelperText: 'Agrupa os dados ao longo do eixo vertical',
  chartSetupXFieldGroupHorizHelperText: 'Agrupa os dados ao longo do eixo horizontal',
  chartSetupYMeasureFieldsLabel: 'Campos Y / medida',
  chartSetupXMeasureFieldsLabel: 'Campos X / medida',
  chartSetupYMeasureFieldLabel: 'Campo Y / medida',
  chartSetupXMeasureFieldLabel: 'Campo X / medida',
  chartSetupNoDataAlert: 'Nenhum campo de dados disponível para a configuração do gráfico.',
  chartSetupSeriesLabel: (index) => `Série ${index + 1}`,
  chartSetupSeriesNumericHorizHelperText: 'Campo numérico plotado ao longo do eixo horizontal',
  chartSetupSeriesNumericSumHelperText: 'Campo numérico somado ou calculado em média por categoria',
  chartSetupMixedSeriesBar: 'Barra',
  chartSetupMixedSeriesLine: 'Linha',
  chartSetupCalculatedField: 'Campo calculado…',
  chartSetupCategoryFieldLabel: 'Campo de categoria',
  chartSetupRemoveSplitByTooltip: 'Remova campos de medida extras para ativar dividir por',
  chartSetupInnerRingLabel: 'Categoria do anel interno',
  chartSetupSplitByLabel: 'Dividir por (campo de série)',
  chartSetupArcLabelsTitle: 'Rótulos de arco',
  chartSetupSplitByHelperText: 'Divide os dados em uma série separada por valor',
  chartSetupSplitByDisabledHelperText:
    'Não disponível quando vários campos de medida estão configurados',
  chartSetupInnerRingHelperText: 'Adiciona um anel interno concêntrico agrupado por este campo',

  // KPI setup panel
  kpiSetupChartLine: 'Linha',
  kpiSetupChartBar: 'Barra',
  kpiSetupChartGauge: 'Medidor',
  kpiSetupCompPrevPeriod: 'Período anterior (duração equivalente)',
  kpiSetupCompPrevCalendarPeriod: 'Período do calendário anterior',
  kpiSetupCompSameLastYear: 'Mesmo período do ano passado',
  kpiSetupInteractionsTitle: 'Interações',
  kpiSetupInteractionsDescription: 'Quando outros widgets forem clicados, este KPI\u2026',
  kpiSetupTimeFieldLabel: 'Campo de tempo',
  kpiSetupGranularityLabel: 'Granularidade',
  kpiSetupPlotTypeLabel: 'Tipo de gráfico',
  kpiSetupValueFieldLabel: 'Campo de valor',
  kpiSetupValueFieldHelperText: 'Campo a agregar',
  kpiSetupSparklineLabel: 'Minigráfico',
  kpiSetupTargetLabel: 'Meta',
  kpiSetupTrendLabel: 'Tendência',
  kpiSetupDateRangeLabel: 'Intervalo de datas',
  kpiSetupDateRangeFieldLabel: 'Campo de data',
  kpiSetupCompPeriodLabel: 'Período de comparação',
  kpiSetupDateAggEarliest: 'Mais cedo',
  kpiSetupDateAggLatest: 'Mais tarde',
  kpiSetupFillAreaLabel: 'Preencher área',
  kpiSetupCumulativeLabel: 'Acumulado (total cumulativo)',
  kpiSetupAutoDateFilterPrefix: 'Usando filtro de data:',
  kpiSetupCalculatedField: 'Campo calculado…',
  kpiSetupTargetHelperText:
    'Valor de referência para a linha de meta no minigráfico. Quando Tendência também estiver ativado, o indicador de delta compara o valor atual com essa meta.',
  kpiSetupInvertColours: 'Inverter cores (menor é melhor)',
  kpiSetupFixedWindowLabel: 'Trend window',
  kpiSetupFixedWindowNone: 'From date filter',
  kpiSetupFixedWindowMonth: 'Last 30 days',
  kpiSetupFixedWindowQuarter: 'Last 90 days',
  kpiSetupFixedWindowYear: 'Last 365 days',

  // KPI widget
  kpiGrandTotalTooltip:
    'Total geral \u2014 widgets de filtro ativos não são aplicados a este KPI. Ative o modo Filtro cruzado nas configurações do KPI para respeitá-los.',
  kpiGranularityAutoLabel: 'Auto',
  kpiWidgetComparisonTargetLabel: 'meta',

  // Grid setup panel
  gridSetupDataSourceLabel: 'Fonte de dados',
  gridSetupDataSourcePlaceholder: 'Selecione uma fonte de dados\u2026',
  gridSetupAllColumnsAdded: 'Todas as colunas disponíveis foram adicionadas',
  gridSetupCrossFilterFieldLabel: 'Campo de filtro cruzado',
  gridSetupCrossFilterFieldHelper:
    'Campo aplicado a outros widgets quando uma linha é selecionada; padrão é a primeira coluna visível',
  gridSetupGroupByLabel: 'Agrupar por',
  gridSetupGroupByHelper: 'Recolher linhas em grupos \u2014 defina a agregação por coluna abaixo',
  gridSetupDefaultSortLabel: 'Ordenação padrão',
  gridSetupHeightLabel: 'Altura (px)',
  gridSetupConditionalFormattingTitle: 'Formatação condicional',
  gridSetupConditionalCustom: 'Personalizado',
  gridSetupRemoveRuleAriaLabel: 'Remover regra',
  gridSetupInteractionsTitle: 'Interações',
  gridSetupInteractionsDescription: 'Quando outros widgets forem clicados, esta tabela\u2026',
  gridSetupChooseSourceHelper: 'Escolha uma fonte de dados para configurar as colunas',
  gridSetupNoSourceAlert:
    'Selecione uma fonte de dados acima para configurar as colunas e as definições desta tabela.',
  gridSetupColumnsTitle: 'Colunas',
  gridSetupColumnOptionsAriaLabel: (label) => `Opções de ${label}`,
  gridSetupColumnGroupLabel: '(grupo)',
  gridSetupColumnRemove: 'Remover',
  gridSetupColumnAggNone: 'Nenhum',
  gridSetupColumnAggUnique: 'Único',
  gridSetupColumnAggSummaryTooltip: 'Definir resumo / remover',
  gridSetupColumnAggLabel: (isGroupBy, aggLabel) =>
    `${isGroupBy ? 'Agregação' : 'Resumo'}: ${aggLabel}`,
  gridSetupColumnSetAggTooltip: 'Definir agregação',
  gridSetupAddColumn: 'Adicionar coluna',
  gridSetupCalculatedColumn: 'Coluna calculada…',
  gridSetupAddRule: 'Adicionar regra',
  gridSetupCFContains: 'contém',
  gridSetupCFIsEmpty: 'está vazio',
  gridSetupCFNotEmpty: 'não está vazio',
  gridSetupCFStyleRed: 'Vermelho',
  gridSetupCFStyleGreen: 'Verde',
  gridSetupCFStyleYellow: 'Amarelo',
  gridSetupCFStyleBlue: 'Azul',
  gridSetupCFStyleBold: 'Negrito',

  // Map setup panel
  mapSetupMapTypeLabel: 'Tipo de mapa',
  mapSetupValueFieldLabel: 'Campo de valor (opcional para contagem)',
  mapSetupColourSchemeLabel: 'Esquema de cores',
  mapSetupLegendPositionLabel: 'Posição da legenda',
  mapSetupScaleFromZeroLabel: 'Escalar a partir do zero',
  mapSetupClickableLabel: 'Clicável (fonte de filtro)',
  mapSetupCrossFilterLabel: 'Responder a filtros cruzados',
  mapSetupColorBlues: 'Azuis',
  mapSetupColorReds: 'Vermelhos',
  mapSetupColorGreens: 'Verdes',
  mapSetupColorOranges: 'Laranjas',
  mapSetupColorPurples: 'Roxos',
  mapSetupLegendBottom: 'Inferior',
  mapSetupLegendTop: 'Superior',
  mapSetupLegendLeft: 'Esquerda',
  mapSetupLegendRight: 'Direita',
  mapSetupLegendHidden: 'Nenhuma',
  mapSetupLegendAlignLabel: 'Alinhamento da legenda',
  mapSetupLegendAlignStart: 'Topo',
  mapSetupLegendAlignCenter: 'Meio',
  mapSetupLegendAlignEnd: 'Base',
  mapFormatLegendAlignLeft: 'Esquerda',
  mapFormatLegendAlignRight: 'Direita',
  mapSetupRegionFieldLabel: 'Campo de região',
  mapSetupRegionFieldHelperText:
    'Um campo que contém identificadores de região correspondentes aos IDs dos recursos geográficos.',

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
  pivotSetupAggregationLabel: 'Agregação',

  // Inline formula bar
  inlineFormulaBarAddTooltip: 'Adicionar campo de fórmula calculada',
  inlineFormulaBarCloseAriaLabel: 'Fechar barra de fórmula',
  inlineFormulaBarLabelLabel: 'Rótulo',
  inlineFormulaBarAutoHelperText:
    'Gerado automaticamente a partir da fórmula \u2014 edite para personalizar',
  inlineFormulaBarCancelButton: 'Cancelar',
  inlineFormulaBarAddButton: 'Adicionar',
  inlineFormulaBarFieldOperandLabel: 'Campo',
  inlineFormulaBarNumberOperandLabel: 'Número',
  inlineFormulaBarOperandTypeAriaLabel: (label) => `tipo de ${label}`,
  inlineFormulaBarButtonLabel: 'Fórmula',
  inlineFormulaBarOperandALabel: 'A',
  inlineFormulaBarOperandBLabel: 'B',

  // Field detail view
  fieldDetailRowSourceId: 'ID da fonte',
  fieldDetailRowName: 'Nome',
  fieldDetailRowDescription: 'Descrição',
  fieldDetailRowDataType: 'Tipo de dado',
  fieldDetailRowCalculationType: 'Tipo de cálculo',
  fieldDetailRowNoCalculation: 'Sem cálculo',
  fieldDetailRowFormat: 'Formato',
  fieldDetailNumberFormatLabel: 'Formato numérico',
  fieldDetailNumberFormatDefault: 'Padrão',
  fieldDetailFormatInteger: 'Inteiro',
  fieldDetailFormatDecimal: 'Decimal',
  fieldDetailFormatPercent: 'Percentual',
  fieldDetailFormatCurrency: 'Moeda',

  // Filters drawer
  filtersDrawerRenameViewTooltip: 'Renomear visualização',
  filtersSectionWidgetTitle: (title) => `Widget: ${title}`,
  filtersRenameViewAriaLabel: 'Renomear visualização salva',
  filtersRenameViewButtonAriaLabel: (name) => `Renomear visualização "${name}"`,
  filtersDeleteViewAriaLabel: (name) => `Excluir visualização "${name}"`,

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
  filterSetupSliderRangeHelperText:
    'Intervalo do controle deslizante (deixe em branco para detectar automaticamente a partir dos dados)',

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
  pageConfigPaddingNone: 'Nenhum',
  pageConfigPaddingSmall: 'Pequeno (8px)',
  pageConfigPaddingMedium: 'Médio (16px)',
  pageConfigPaddingLarge: 'Grande (24px)',

  // AI insight panel
  insightTypeSummary: 'Resumo',
  insightTypeAnalysis: 'Análise',
  insightTypeForecast: 'Previsão',
  insightTypeAnomaly: 'Explicação de anomalia',
  insightTypeCorrelation: 'Análise de correlação',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Limpar filtro',
  filterWidgetSelectAllLabel: 'Selecionar tudo',
  filterWidgetClearAllLabel: 'Limpar tudo',
  filterWidgetAllLabel: 'Todos',
  filterWidgetNoOptionsLabel: 'Nenhuma opção encontrada',
  filterWidgetSelectedCount: (count) => `${count} selecionado${count === 1 ? '' : 's'}`,
  filterWidgetExcludeLabel: 'Excluir selecionados',
  filterWidgetExcludingLabel: '\u2298 Excluindo selecionados',
  filterWidgetDateFromLabel: 'De',
  filterWidgetDateToLabel: 'Até',
  filterWidgetNoFieldConfigured: 'Nenhum campo configurado. Selecione um campo no painel Compor.',

  // Date range bar
  dateRangePresetAriaLabel: 'Predefinição de intervalo de datas',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Limpar campo',
  dataSourceAddCalculatedField: 'Adicionar campo calculado…',

  // Widget filter row
  widgetFilterFieldHelperText: 'Campo a que este filtro se aplica',
  drawerPanelOpenAriaLabel: (title) => `Abrir painel ${title}`,
  drawerPanelCloseNamedAriaLabel: (title) => `Fechar painel ${title}`,
  sidebarPanelToggleAriaLabel: (isActive, label) =>
    isActive ? `Fechar painel ${label}` : `Abrir painel ${label}`,
  addWidgetGroupAriaLabel: (groupLabel) => `Widgets de ${groupLabel}`,
  addWidgetSelectAriaLabel: (label) => `Selecionar widget: ${label}`,
  formatPanelNoSubtitlePlaceholder: 'Sem subtítulo',

  // Widget filters panel
  widgetFiltersPanelNoSource: 'Este widget não tem fonte de dados.',
  widgetFiltersPanelDescription:
    'Condições permanentes aplicadas aos dados deste widget antes de qualquer filtro interativo.',
  widgetFiltersPanelNoFilters: 'Sem filtros, todos os dados são exibidos.',
  widgetFiltersPanelAddButton: 'Adicionar filtro',

  // Expression field preview
  expressionPreviewMeasureLabel: (count) =>
    `Pré-visualização (medida em ${count.toLocaleString('pt-BR')} linhas)`,
  expressionPreviewFirstRowsLabel: (count) =>
    `Pré-visualização (primeiras ${count.toLocaleString('pt-BR')} linhas)`,

  // Pivot widget
  pivotRowsColumnsLabel: (rowCount, colCount) => `${rowCount} linhas \u00d7 ${colCount} colunas`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} linha${count === 1 ? '' : 's'} não exibida${count === 1 ? '' : 's'}: aumente a altura do widget para ver todas`,

  // Color input
  colorInputClearAriaLabel: (label) => `Limpar ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'Novo',
  kpiTrendTargetTooltip: (value) => `Meta: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Período anterior: ${period}`,
  kpiTrendNoDateFilterHint: 'Adicione um filtro de data para mostrar a tendência.',
  kpiSparklineNoTimeFieldHint:
    'Adicione um filtro de data ou selecione um campo de tempo para mostrar o sparkline.',

  // Chart widget
  chartMixedRequiresFieldsHint: 'O gráfico misto requer 2 ou mais campos de medida.',
  chartDefaultSeriesLabel: 'Valor',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Use a aba Configuração para escolher um ${fieldLabel.toLowerCase()} e um campo de valor.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'Cabeçalho de linha / coluna',
  pivotBlankValueLabel: '(em branco)',
  pivotTotalLabel: 'Total',

  // Expression dialog
  exprDialogEditTitle: 'Editar campo calculado',
  exprDialogNewTitle: 'Novo campo calculado',

  // Expression field — measure checkbox
  exprMeasureLabel: 'Medida (agregação)',
  exprMeasureHelperText:
    'Computa um único valor sobre todo o conjunto de dados (ex.: receita total).',
  exprDimensionHelperText: 'Computa um valor por linha (ex.: preço \u00d7 quantidade).',

  // Chart color scheme options
  chartColorSchemePrimary: 'Primário (azul)',
  chartColorSchemeSuccess: 'Sucesso (verde)',
  chartColorSchemeWarning: 'Atenção (laranja)',
  chartColorSchemeError: 'Erro (vermelho)',

  // AI chat suggestions
  aiSuggestionBarChart: (numericLabel, catLabel) =>
    `Gráfico de barras: ${numericLabel} por ${catLabel}`,
  aiSuggestionKpi: (fieldLabel) => `KPI: total de ${fieldLabel}`,
  aiSuggestionTable: (sourceLabel) => `Tabela de ${sourceLabel}`,
  aiSuggestionChangeToLine: (widgetTitle) =>
    `Mudar \u201c${widgetTitle}\u201d para gráfico de linhas`,
  aiSuggestionAddSparkline: (widgetTitle) => `Adicionar sparkline ao \u201c${widgetTitle}\u201d`,
  aiSuggestionAddDateFilter: 'Adicionar filtro de data',
  aiSuggestionAddPage: 'Adicionar nova página',
  aiSuggestionSummarisePage: 'Resumir página',
  aiSuggestionWhatDataAvailable: 'Quais dados estão disponíveis?',
  chatNewConversationName: 'Nova conversa',
  chatSwitchConversationTooltip: 'Trocar conversa',
  chatVoiceInputStart: 'Iniciar entrada por voz',
  chatVoiceInputStop: 'Parar entrada por voz',
  chatVoiceInputNotSupported: 'Entrada por voz não é suportada neste navegador',
  chatMessageCopyTooltip: 'Copiar',
  chatMessageCopiedTooltip: 'Copiado!',
  chatMessageCopyAriaLabel: 'Copiar mensagem',
  chatMessageRetryTooltip: 'Tentar novamente',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Esta configuração de gráfico usa campos que não estão disponíveis na fonte do widget ou em uma fonte diretamente relacionada.',
  chartUnsupportedMixedCrossSource:
    'Esta configuração de gráfico mistura campos de fontes diferentes de uma forma que ainda não tem um grão de agregação seguro único.',
  chartUnsupportedScatterCrossSource:
    'Gráficos de dispersão ainda não suportam combinações de campos entre fontes.',
  chartUnsupportedDefault: 'Esta configuração de gráfico ainda não é suportada.',
  chartForecastSeriesLabel: 'Previsão',

  // Grid summary labels
  gridSummaryLabelSum: 'Total:',
  gridSummaryLabelAvg: 'Média:',
  gridSummaryLabelCount: 'Contagem:',
  gridSummaryLabelCountDistinct: 'Únicos:',
  gridSummaryLabelMin: 'Mín.:',
  gridSummaryLabelMax: 'Máx.:',

  // Auto-generated widget titles
  widgetAutoTitleChart: 'Gráfico',
  widgetAutoTitleKpi: 'KPI',
  widgetAutoTitleTable: 'Tabela',
  widgetAutoTitleFilter: 'Filtro',
  widgetAutoTitlePivot: 'Tabela dinâmica',
  widgetAutoTitleMap: 'Mapa',
  widgetAutoTitleDefault: 'Widget',
  widgetAutoTitleVs: 'vs',
  widgetAutoTitleBy: 'por',
  widgetAutoTitleSplitBy: 'dividido por',
  widgetAutoTitleByCountry: 'por país',
  widgetAutoTitleSourceSuffixChart: 'gráfico',
  widgetAutoTitleSourceSuffixKpi: 'KPI',
  widgetAutoTitleSourceSuffixPivot: 'dinâmico',
  widgetAutoTitleSourceSuffixMap: 'mapa',
  widgetAutoTitleFilterPrefix: 'Filtro',
  widgetAggPrefixSum: 'Total de',
  widgetAggPrefixAvg: 'Média de',
  widgetAggPrefixCount: 'Contagem de',
  widgetAggPrefixMin: 'Mín. de',
  widgetAggPrefixMax: 'Máx. de',
  widgetAggPrefixCountDistinct: 'Distintos de',
  widgetGroupByPrefixDay: 'Diário',
  widgetGroupByPrefixWeek: 'Semanal',
  widgetGroupByPrefixMonth: 'Mensal',
  widgetGroupByPrefixQuarter: 'Trimestral',
  widgetGroupByPrefixYear: 'Anual',
  widgetAutoTitleMoreFields: (count) => `+${count} mais`,

  // Date filter labels
  dateFilterLast: (amount, unit) => `Últimos ${amount} ${unit}`,
  dateFilterNext: (amount, unit) => `Próximos ${amount} ${unit}`,
  dateFilterFrom: (date) => `A partir de ${date}`,
  dateFilterUpTo: (label) => `Até ${label}`,
  dateFilterSince: (date) => `Desde ${date}`,
  dateFilterUntil: (date) => `Até ${date}`,
  dateFilterUnitYear: 'ano',
  dateFilterUnitYears: 'anos',
  dateFilterUnitMonth: 'mês',
  dateFilterUnitMonths: 'meses',
  dateFilterUnitWeek: 'semana',
  dateFilterUnitWeeks: 'semanas',
  dateFilterUnitDay: 'dia',
  dateFilterUnitDays: 'dias',
  dateFilterUnitHour: 'hora',
  dateFilterUnitHours: 'horas',
  dateFilterUnitMinute: 'minuto',
  dateFilterUnitMinutes: 'minutos',
  dateFilterUnitSecond: 'segundo',
  dateFilterUnitSeconds: 'segundos',

  // Widget delete confirmation dialog
  widgetDeleteConfirmTitle: 'Excluir widget?',
  widgetDeleteConfirmMessage: 'Este widget será removido permanentemente da página.',
  widgetDeleteConfirmOk: 'Excluir',
  widgetDeleteConfirmCancel: 'Cancelar',
};

export const ptBR: Localization = getStudioLocalization(ptBRLocaleText);

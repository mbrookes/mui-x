import type { StudioLocaleText } from '../internals/localeText';
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
  filterSearchClearAriaLabel: 'Limpar a pesquisa de filtros',
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
  widgetNoData: 'Sem dados',
  widgetLoadError: 'Falha ao carregar dados',
  mapGeographyLoadError: 'Falha ao carregar dados do mapa. Tente novamente.',
  widgetLoadingLabel: 'Carregando',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Abrir painel de filtros',
  quickFilterBarClearAll: 'Limpar todos os filtros',
  dateRangeBarFieldLabel: 'Intervalo de datas',

  // Widget card actions
  widgetEditTooltip: 'Editar widget',
  widgetExportCsvTooltip: 'Baixar como CSV',
  widgetExportPngTooltip: 'Baixar como PNG',
  widgetExportNoDataMessage:
    'Ainda não há dados disponíveis para exportar. Abra a grade para que ela possa carregar dados do servidor e tente exportar novamente.',
  widgetExportUnavailableMessage:
    'Este widget não tem nada para exportar. Termine de configurá-lo — uma tabela precisa de uma fonte de dados e uma tabela dinâmica precisa de linhas, colunas e valores — e tente exportar novamente.',
  widgetExpandTooltip: 'Expandir widget',
  widgetMoveToPageLabel: 'Mover para página',
  widgetDuplicateTooltip: 'Duplicar widget',
  widgetDeleteTooltip: 'Excluir widget',
  widgetAiAssistantTooltip: 'Assistente de IA',
  widgetAiInsightTooltip: 'Insight de IA',
  widgetAiRefreshTooltip: 'Atualizar conteúdo de IA',
  widgetInsightTypeSummary: 'Resumo',
  widgetInsightTypeAnalysis: 'Análise',
  widgetInsightTypeForecast: 'Previsão',
  widgetDetectAnomalyTooltip: 'Detectar anomalias',
  widgetHideAnomalyTooltip: 'Ocultar anomalias',
  widgetExplainAnomalyTooltip: 'Explicar anomalias',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Configurar',
  widgetEditDialogTabFilters: 'Filtros',
  widgetEditDialogTabFormat: 'Formatar',
  widgetEditDialogCloseAriaLabel: 'Fechar diálogo de edição',
  widgetUntitledLabel: (kindLabel) => `${kindLabel} sem título`,
  widgetEditDialogPreviewLabel: (kindLabel) => `Pré-visualização de ${kindLabel.toLowerCase()}`,

  // AI assistant
  aiAssistantOpenTooltip: 'Abrir assistente de IA',
  aiAssistantCloseTooltip: 'Fechar assistente de IA',
  aiAssistantPanelTitle: 'Assistente de IA',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Fechar configuração do widget',
  sidebarPanelsAriaLabel: 'Painéis laterais',
  drawerPanelError: 'Ocorreu um erro ao exibir este painel.',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Aumentar',
  numberFieldDecreaseAriaLabel: 'Diminuir',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Fechar gráfico expandido',
  widgetCardExportPngAriaLabel: 'Baixar gráfico expandido como PNG',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Descrever um widget',
  aiCreateWidgetPlaceholder:
    'ex.: Gráfico de barras mostrando receita por país, KPI de pedidos totais\u2026',
  aiCreateWidgetButton: 'Criar',
  aiCreateWidgetLoading: 'Criando\u2026',
  aiCreateWidgetError: 'Falha ao criar widget',
  aiCreateWidgetNetworkError: 'Erro de rede. Verifique sua conexão e tente novamente.',
  aiCreateWidgetRequestFailed: (status, detail) =>
    `Falha na solicitação de IA (${status})${detail ? `: ${detail}` : ''}.`,
  aiCreateWidgetInvalidResponse: 'Resposta inválida da IA.',
  aiTextWidgetGenerationError: 'Falha ao gerar conteúdo',

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
  textFormatSansSerifFont: 'Sem serifa',
  textFormatSerifFont: 'Serifa',
  textFormatMonospaceFont: 'Monoespaçada',
  textFormatDefaultSize: 'Padrão',
  textFormatFontSizeOption: (px) => `${px} px`,
  textFormatAlignmentLabel: 'Alinhamento',

  // Data drawer
  dataDrawerNoSources:
    'Nenhuma fonte de dados configurada. Adicione um widget ao painel para carregar dados de exemplo.',
  dataDrawerViewLineage: 'Ver linhagem de dados',
  dataDrawerLineageTitle: 'Linhagem de dados',
  dataDrawerLineageHelper:
    'Clique em um nó para visualizar seus dados. Clique em uma aresta para inspecionar os campos de chave de junção.',
  dataDrawerRowsLabel: (count) => `${count} ${count === 1 ? 'linha' : 'linhas'}`,
  dataDrawerFieldsLabel: (count) => `${count} ${count === 1 ? 'campo' : 'campos'}`,
  dataDrawerBackAriaLabel: 'Voltar ao grafo de linhagem',
  dataDrawerCloseAriaLabel: 'Fechar linhagem de dados',
  dataDrawerEditTooltip: 'Editar',
  dataDrawerDeleteTooltip: 'Excluir',
  dataDrawerAddCalculatedField: 'Adicionar campo calculado',
  dataDrawerNoData: (sourceLabel) => `Sem dados disponíveis para ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} ${count === 1 ? 'linha' : 'linhas'} a mais`,
  dataDrawerMoreColumns: (count) => `${count} ${count === 1 ? 'coluna' : 'colunas'} a mais`,
  dataDrawerViewSourceLink: 'Ver dados da fonte →',
  dataDrawerMorePreviewRows: (count) => `+${count} a mais`,
  dataDrawerRowsUnknown: 'contagem de linhas indisponível',
  dataDrawerDeleteFieldConfirmTitle: 'Excluir o campo calculado?',
  dataDrawerDeleteFieldConfirmMessage: (fieldLabel, referenceCount) =>
    `“${fieldLabel}” é usado em ${referenceCount} ${
      referenceCount === 1 ? 'lugar' : 'lugares'
    } (widgets, filtros ou campos calculados). Excluí-lo deixa ${
      referenceCount === 1 ? 'esse lugar' : 'esses lugares'
    } sem nenhum valor para exibir.`,
  saveRejectedMessage:
    'Não foi possível salvar esta alteração — ela pode ter sido removida ou modificada em outro lugar. Feche a caixa de diálogo e tente novamente.',
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
  filterSelectionCapHint: (cap) =>
    `Mostrando os primeiros ${cap} valores. Digite para restringir a lista.`,
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
  filterRankTopCount: (count) => `${count} maiores`,
  filterRankBottomCount: (count) => `${count} menores`,

  // Filter summary
  filterSummaryAnyValue: 'qualquer valor',
  filterSummaryIsOneOf: 'é um de:',
  filterSummaryIsNot: 'não é:',
  filterSummaryAndMore: (count) => `e mais ${count}`,
  filterSummaryFrom: (value) => `de ${value}`,
  filterSummaryUntil: (value) => `até ${value}`,

  // Filter operator labels (per field type)
  filterOperator_string_equals: 'É igual a',
  filterOperator_string_not_equals: 'Não é igual a',
  filterOperator_string_contains: 'Contém',
  filterOperator_string_does_not_contain: 'Não contém',
  filterOperator_string_starts_with: 'Começa com',
  filterOperator_string_not_starts_with: 'Não começa com',
  filterOperator_string_ends_with: 'Termina com',
  filterOperator_string_not_ends_with: 'Não termina com',
  filterOperator_string_is_empty: 'Está vazio',
  filterOperator_string_is_not_empty: 'Não está vazio',
  filterOperator_number_equals: '=',
  filterOperator_number_not_equals: '≠',
  filterOperator_number_greater_than: '>',
  filterOperator_number_greater_than_or_equal: '≥',
  filterOperator_number_less_than: '<',
  filterOperator_number_less_than_or_equal: '≤',
  filterOperator_number_between: 'Entre',
  filterOperator_number_is_empty: 'Está vazio',
  filterOperator_number_is_not_empty: 'Não está vazio',
  filterOperator_date_equals: 'Em',
  filterOperator_date_not_equals: 'Não em',
  filterOperator_date_less_than: 'Antes de',
  filterOperator_date_greater_than: 'Depois de',
  filterOperator_date_less_than_or_equal: 'Em ou antes de',
  filterOperator_date_greater_than_or_equal: 'Em ou depois de',
  filterOperator_date_between: 'Entre',
  filterOperator_date_is_empty: 'Está vazio',
  filterOperator_date_is_not_empty: 'Não está vazio',
  filterOperator_datetime_equals: 'Às',
  filterOperator_datetime_not_equals: 'Não às',
  filterOperator_datetime_greater_than: 'Depois de',
  filterOperator_datetime_less_than: 'Antes de',
  filterOperator_datetime_greater_than_or_equal: 'Às ou depois de',
  filterOperator_datetime_less_than_or_equal: 'Às ou antes de',
  filterOperator_datetime_between: 'Entre',
  filterOperator_datetime_is_empty: 'Está vazio',
  filterOperator_datetime_is_not_empty: 'Não está vazio',
  filterOperator_boolean_equals: 'É',
  filterOperator_boolean_not_equals: 'Não é',

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
  expressionBuilderSectionLabel: 'Expressão',

  // Expression builder: operator picker
  exprOpAdd: 'Somar (+)',
  exprOpSubtract: 'Subtrair (−)',
  exprOpMultiply: 'Multiplicar (×)',
  exprOpDivide: 'Dividir (÷)',
  exprOpModulo: 'Módulo (%)',
  exprOpNegate: 'Negar (−x)',
  exprOpEquals: 'Igual a (=)',
  exprOpNotEqual: 'Diferente de (≠)',
  exprOpLessThan: 'Menor que (<)',
  exprOpGreaterThan: 'Maior que (>)',
  exprOpLessThanOrEqual: 'Menor ou igual a (≤)',
  exprOpGreaterThanOrEqual: 'Maior ou igual a (≥)',
  exprOpAnd: 'E',
  exprOpOr: 'Ou',
  exprOpNot: 'Não',
  exprOpIsTrue: 'É verdadeiro',
  exprOpIsFalse: 'É falso',
  exprOpIsNull: 'É nulo',
  exprOpIsNotNull: 'Não é nulo',
  exprOpIf: 'Se / Então / Senão',
  exprOpIn: 'Em (valor é um destes)',
  exprOpDatediff: 'Diferença de datas',
  exprGroupArithmetic: 'Aritmética',
  exprGroupComparison: 'Comparação',
  exprGroupLogical: 'Lógica',
  exprGroupConditional: 'Condicional',
  exprGroupDate: 'Data',
  exprInputLabelUnit: 'Unidade (ex.: "dia", "mês", "ano")',
  exprInputLabelCondition: 'Condição',
  exprInputLabelThen: 'Então',
  exprInputLabelElse: 'Senão',
  exprInputLabelGeneric: (index) => `Entrada ${index}`,
  exprAddInputButton: 'Adicionar entrada',
  exprOutputTypeLabel: 'Tipo de saída:',
  exprRootNodeLabel: 'Expressão',
  exprLiteralValueAriaLabel: 'Valor literal',
  exprUnnamedFieldLabel: 'Sem nome',
  exprPreviewNullLabel: 'null',
  exprCalculatedFieldBadgeLabel: 'Campo calculado',

  // Expression validation errors
  exprErrorMissingId: 'O campo calculado precisa ter um identificador.',
  exprErrorMissingLabel: 'O campo calculado precisa ter um nome.',
  exprErrorMissingSourceId: 'O campo calculado precisa estar associado a uma fonte de dados.',
  exprErrorMaxDepth: (maxDepth) => `A expressão está aninhada em mais de ${maxDepth} níveis.`,
  exprErrorUnknownField: (fieldId) =>
    `O campo "${fieldId}" não foi encontrado nos campos da fonte nem nos campos calculados.`,
  exprErrorUnreachableField: (fieldId, fieldSourceId) =>
    `O campo "${fieldId}" pertence à fonte de dados "${fieldSourceId}", que não está relacionada à fonte de dados deste campo.`,
  exprErrorMalformedNode:
    'Nó de expressão inválido: era esperado um nó de operador (com um array `inputs`), um valor literal, uma referência de campo ou uma referência de campo de junção.',
  exprErrorInsufficientArity: (operator, required, actual) =>
    `O operador "${operator}" exige pelo menos ${required} entrada(s); foram recebidas ${actual}.`,
  exprErrorCircularDependency: (fieldId) =>
    `O campo calculado "${fieldId}" cria uma dependência circular.`,

  // Shared aggregation function labels
  aggFnSum: 'Soma',
  aggFnCount: 'Contagem',
  aggFnCountRows: 'Contagem (linhas)',
  aggFnCountValues: 'Contagem (valores)',
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
    'Campo para o eixo vertical (linha) — qualquer tipo de campo da fonte principal, ex.: categoria, desconto % ou hora do dia',
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
  chartSetupRemoveSplitByTooltip: 'Remova campos de medida extras para ativar dividir por',
  chartSetupInnerRingLabel: 'Categoria do anel interno',
  chartSetupSplitByLabel: 'Dividir por (campo de série)',
  chartSetupArcLabelsTitle: 'Rótulos de arco',
  chartSetupSplitByHelperText: 'Divide os dados em uma série separada por valor',
  chartSetupSplitByDisabledHelperText:
    'Não disponível quando vários campos de medida estão configurados',
  chartSetupInnerRingHelperText: 'Adiciona um anel interno concêntrico agrupado por este campo',
  chartSetupGaugeMinRevertedHelperText:
    'O mínimo deve ser um número menor que o máximo — sua entrada foi revertida.',
  chartSetupGaugeMaxRevertedHelperText:
    'O máximo deve ser um número maior que o mínimo — sua entrada foi revertida.',
  chartSetupRadiusRevertedHelperText: (min, max) =>
    `Informe um número de ${min} a ${max}, mantendo o raio mínimo abaixo do raio máximo — sua entrada foi revertida.`,
  chartSetupValueClampedHelperText: (clamped) =>
    `Fora do intervalo permitido — ajustado para ${clamped}.`,

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
  kpiSetupGaugeMaxLabel: 'Meta',
  kpiSetupTrendLabel: 'Tendência',
  kpiSetupDateRangeLabel: 'Intervalo de datas',
  kpiSetupDateRangeFieldLabel: 'Campo de data',
  kpiSetupCompPeriodLabel: 'Período de comparação',
  kpiSetupDateAggEarliest: 'Mais cedo',
  kpiSetupDateAggLatest: 'Mais tarde',
  kpiSetupFillAreaLabel: 'Preencher área',
  kpiSetupCumulativeLabel: 'Acumulado (total cumulativo)',
  kpiSetupAutoDateFilterPrefix: 'Usando filtro de data:',
  kpiSetupInvertColours: 'Inverter cores (menor é melhor)',
  kpiSetupFixedWindowLabel: 'Janela de tendência',
  kpiSetupFixedWindowNone: 'Do filtro de datas',
  kpiSetupFixedWindowMonth: 'Últimos 30 dias',
  kpiSetupFixedWindowQuarter: 'Últimos 90 dias',
  kpiSetupFixedWindowYear: 'Últimos 365 dias',

  // KPI widget
  kpiGranularityAutoLabel: 'Auto',

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
  gridSetupMeasuresSubheader: 'Medidas',
  gridSetupMeasureNotColumnHelper:
    'As medidas agregam todo o conjunto de dados, portanto não têm valor por linha e não podem ser colunas da tabela. Use-as em um KPI ou gráfico.',
  gridSetupCFValuePlaceholder: 'valor',

  // Map setup panel
  mapSetupMapTypeLabel: 'Tipo de mapa',
  mapSetupValueFieldLabel: 'Campo de valor (opcional para contagem)',
  mapSetupColourSchemeLabel: 'Esquema de cores',
  mapSetupLegendPositionLabel: 'Posição da legenda',
  mapSetupScaleFromZeroLabel: 'Escalar a partir do zero',
  mapSetupClickableLabel: 'Clicável (fonte de filtro)',
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
  mapSetupCountryFieldLabel: 'Campo de país',
  mapSetupCountryFieldHelperText:
    'Um campo contendo códigos ISO alfa-2, alfa-3 ou nomes completos de países.',
  mapSetupStateFieldLabel: 'Campo de estado',
  mapSetupStateFieldHelperText:
    'Um campo contendo nomes de estados dos EUA ou abreviações postais de 2 letras.',
  mapSetupUnreachableFieldWarning:
    'Este campo não vem da fonte do widget nem de uma fonte diretamente relacionada, portanto não pode ser resolvido e o mapa será exibido em branco.',

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
  filterSetupMinAboveMaxError:
    'Mín. deve ser menor que Máx. — caso contrário, o widget inverte os dois valores.',
  filterSetupStepNotPositiveError:
    'O passo deve ser maior que 0 — caso contrário, o widget o ignora.',
  filterSetupStepExceedsRangeError: 'O passo é maior que o intervalo entre Mín. e Máx.',

  // Text setup panel
  textSetupTitleLabel: 'Título',
  textSetupTitleHelper: 'Cabeçalho exibido no topo do widget',
  textSetupSubtitleLabel: 'Subtítulo',
  textSetupSubtitleHelper: 'Texto menor abaixo do cabeçalho',
  textSetupBodyLabel: 'Corpo',
  textSetupBodyHelper: 'Conteúdo principal do widget; suporta texto simples',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Limpar filtro',
  filterWidgetSelectAllLabel: 'Selecionar tudo',
  filterWidgetClearAllLabel: 'Limpar tudo',
  filterWidgetAllLabel: 'Todos',
  filterWidgetNoOptionsLabel: 'Nenhuma opção encontrada',
  filterWidgetNoSearchMatchesLabel: 'Nenhuma correspondência',
  filterRankConflictMessage:
    'É permitido apenas um filtro Top-N ou Bottom-N por página. Remova o existente primeiro.',
  filterWidgetSelectedCount: (count) => `${count} selecionado${count === 1 ? '' : 's'}`,
  filterWidgetExcludeLabel: 'Excluir selecionados',
  filterWidgetExcludingLabel: '\u2298 Excluindo selecionados',
  filterWidgetDateFromLabel: 'De',
  filterWidgetDateToLabel: 'Até',
  filterWidgetNoFieldConfigured: 'Nenhum campo configurado. Selecione um campo no painel Compor.',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Limpar campo',
  dataSourceAddCalculatedField: 'Adicionar campo calculado…',
  dataSourceFieldUnavailableOption: (fieldId) => `${fieldId} (indisponível)`,
  dataSourceFieldUnavailableHelperText: (fieldId) =>
    `“${fieldId}” não está mais disponível nos dados. Escolha outro campo.`,
  dataSourceFieldUnavailableGroupLabel: 'Indisponível',

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

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} linha${count === 1 ? '' : 's'} não exibida${count === 1 ? '' : 's'}: aumente a altura do widget para ver todas`,

  // Color input
  colorInputClearAriaLabel: (label) => `Limpar ${label.toLowerCase()}`,
  colorInputPickerAriaLabel: (label) => `Seletor de cor de ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'Novo',
  kpiTrendTargetTooltip: (value) => `Meta: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Período anterior: ${period}`,
  kpiTrendVsLabel: (period) => `vs. ${period}`,
  kpiTrendNoDateFilterHint: 'Adicione um filtro de data para mostrar a tendência.',
  kpiSparklineNoTimeFieldHint:
    'Adicione um filtro de data ou selecione um campo de tempo para mostrar o sparkline.',

  // Chart widget
  chartMixedRequiresFieldsHint: 'O gráfico misto requer 2 ou mais campos de medida.',
  chartDefaultSeriesLabel: 'Valor',
  chartEmptyCategoryLabel: '(vazio)',
  chartOtherBucketLabel: 'Outro',
  chartHeatmapRequiresFieldsHint:
    'O mapa de calor requer campos de eixo de colunas, eixo de linhas e valor.',
  chartFunnelRequiresFieldsHint: 'O gráfico de funil requer um campo de etapa e um campo de valor.',
  chartSankeyRequiresFieldsHint: 'O diagrama de Sankey requer campos de origem, destino e valor.',
  chartGanttRequiresFieldsHint:
    'O gráfico de Gantt requer um campo de rótulo, um campo de data de início e um de data de término.',
  chartGanttDurationLabel: 'Duração:',
  chartGanttDurationDays: (days) => `${days} d`,
  chartGanttDurationHours: (hours) => `${hours} h`,
  chartCrossFilterFilteredOutLabel: 'filtrado',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Use a aba Configuração para escolher um ${fieldLabel.toLowerCase()} e um campo de valor.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'Cabeçalho de linha / coluna',
  pivotBlankValueLabel: '(em branco)',
  pivotTotalLabel: 'Total',
  pivotRowsTruncatedNotice: (shown, total) =>
    `Mostrando as primeiras ${shown} de ${total} categorias de linhas.`,
  pivotColumnsTruncatedNotice: (shown, total) =>
    `Mostrando as primeiras ${shown} de ${total} categorias de colunas.`,

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
  aiSuggestionBarChartPrompt: (numericLabel, catLabel, sourceLabel) =>
    `Adicione um gráfico de barras mostrando ${numericLabel} por ${catLabel} a partir dos dados de ${sourceLabel}.`,
  aiSuggestionKpiPrompt: (fieldLabel, sourceLabel) =>
    `Adicione um cartão KPI mostrando o total de ${fieldLabel} de ${sourceLabel}.`,
  aiSuggestionTablePrompt: (sourceLabel) =>
    `Adicione uma tabela de dados mostrando registros de ${sourceLabel}.`,
  aiSuggestionChangeToLinePrompt: (widgetTitle) =>
    `Mude o widget "${widgetTitle}" para um gráfico de linhas.`,
  aiSuggestionAddSparklinePrompt: (widgetTitle) =>
    `Adicione uma sparkline ao widget KPI "${widgetTitle}".`,
  aiSuggestionAddDateFilterPrompt: 'Adicione um widget de filtro de intervalo de datas ao painel.',
  aiSuggestionAddPagePrompt: 'Crie uma nova página do painel.',
  aiSuggestionSummarisePagePrompt:
    'Dê-me um resumo executivo dos principais insights desta página — concentre-se nos dados, tendências e quaisquer anomalias em vez da estrutura da página.',
  aiSuggestionWhatDataAvailablePrompt:
    'Quais fontes de dados e campos estão disponíveis para construir este painel?',
  chatNewConversationName: 'Nova conversa',
  chatSwitchConversationTooltip: 'Trocar conversa',
  chatNoConversationsLabel: 'Nenhuma conversa ainda',
  aiInsightSummaryPrompt: (widgetTitle) =>
    `Dê-me um resumo geral do widget "${widgetTitle}" em 2 ou 3 frases — o que ele mostra e a conclusão mais importante. Seja breve, sem tópicos.`,
  aiInsightAnalysisPrompt: (widgetTitle) =>
    `Analise o widget "${widgetTitle}" — identifique as principais tendências, padrões e valores relevantes`,
  aiInsightForecastPrompt: (widgetTitle) =>
    `Faça uma previsão para o widget "${widgetTitle}" — que tendência você espera nos próximos períodos?`,
  aiInsightCorrelationPrompt: (widgetTitle) =>
    `Mostre uma análise de correlação para o widget "${widgetTitle}"`,
  aiAnomalyExplainPrivatePrompt: (widgetTitle, count) =>
    `Explique ${count === 1 ? 'a anomalia detectada' : `as ${count} anomalias detectadas`} no widget "${widgetTitle}". Os valores dos dados subjacentes estão ocultos (modo privado); raciocine sobre as causas prováveis em termos gerais.`,
  aiAnomalyExplainPrompt: (widgetTitle, details) =>
    `Explique as anomalias detectadas no widget "${widgetTitle}":\n${details}`,
  aiAnomalyDetailLine: (axisLabel, value, annotationLabel) =>
    `- Anomalia no ${axisLabel} em ${value}${annotationLabel ? ` (${annotationLabel})` : ''}`,
  aiAnomalyAxisX: 'eixo X',
  aiAnomalyAxisY: 'eixo Y',
  chatUserDisplayName: 'Você',
  chatComposerPlaceholder: 'Como posso ajudar?',
  chatEmptyStateTitle: 'Pergunte-me qualquer coisa sobre o seu painel',
  chatEmptyStateSubtitle: 'Posso adicionar widgets, analisar seus dados e muito mais',
  chatVoiceInputStart: 'Iniciar entrada por voz',
  chatVoiceInputStop: 'Parar entrada por voz',
  chatMessageCopyTooltip: 'Copiar',
  chatMessageCopiedTooltip: 'Copiado!',
  chatMessageCopyAriaLabel: 'Copiar mensagem',
  chatMessageRetryTooltip: 'Tentar novamente',
  chatReasoningThinkingLabel: 'Pensando…',
  chatReasoningSectionLabel: 'Raciocínio',
  chatComposerStopGeneratingLabel: 'Parar geração',
  chatComposerSendMessageLabel: 'Enviar mensagem',
  chatMessageTokenCount: (count) =>
    `${count.toLocaleString('pt-BR')} ${count === 1 ? 'token' : 'tokens'}`,
  chatMessageTurnCount: (count) => `${count} ${count === 1 ? 'turno' : 'turnos'}`,

  // AI chat tool-call card titles
  chatToolLabelGetDashboardState: 'Obter estado do painel',
  chatToolLabelListPages: 'Listar páginas',
  chatToolLabelSetDashboardTitle: 'Definir título do painel',
  chatToolLabelAddPage: 'Adicionar página',
  chatToolLabelRenamePage: 'Renomear página',
  chatToolLabelRemovePage: 'Remover página',
  chatToolLabelSetActivePage: 'Alternar página',
  chatToolLabelAddWidget: 'Adicionar widget',
  chatToolLabelUpdateWidget: 'Atualizar widget',
  chatToolLabelRemoveWidget: 'Remover widget',
  chatToolLabelSetWidgetLayout: 'Definir layout do widget',
  chatToolLabelSetWidgetWidth: 'Definir largura do widget',
  chatToolLabelSetWidgetForecast: 'Definir previsão do widget',
  chatToolLabelAddPageFilter: 'Adicionar filtro de página',
  chatToolLabelRemovePageFilter: 'Remover filtro de página',
  chatToolLabelAddWidgetFilter: 'Adicionar filtro de widget',
  chatToolLabelRemoveWidgetFilter: 'Remover filtro de widget',
  chatToolLabelSummarisePage: 'Resumir página',
  chatToolLabelApplyBulkUpdate: 'Aplicar atualização em massa',
  chatToolLabelRenameThread: 'Renomear conversa',
  chatToolLabelQueryDataSource: 'Consultar fonte de dados',
  chatApprovalWillRemoveWidgets: 'Excluirá estes widgets',
  chatApprovalWillRemovePages: 'Excluirá estas páginas',
  chatApprovalWillRemoveFilters: 'Excluirá estes filtros',
  chatApprovalWillOrphanWidgets: 'Deixará estes widgets sem página',
  chatApprovalUpdatedWidgetCount: 'Widgets atualizados',
  chatApprovalEffectsWithheld:
    'Resumo de impacto indisponível: era grande demais para ser exibido. Recuse esta solicitação a menos que saiba o que ela faz.',
  chatApprovalReasonWithheld:
    'O motivo pelo qual esta solicitação precisa de aprovação era grande demais para ser exibido. Recuse esta solicitação a menos que saiba o que ela faz.',
  chatApprovalInputWithheld:
    'Os detalhes desta solicitação eram grandes demais para serem exibidos, portanto nenhum argumento é listado. Recuse esta solicitação a menos que saiba o que ela faz.',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Esta configuração de gráfico usa campos que não estão disponíveis na fonte do widget ou em uma fonte diretamente relacionada.',
  chartUnsupportedMixedCrossSource:
    'Esta configuração de gráfico mistura campos de fontes diferentes de uma forma que ainda não tem um grão de agregação seguro único.',
  chartUnsupportedScatterCrossSource:
    'Gráficos de dispersão ainda não suportam combinações de campos entre fontes.',
  chartUnsupportedMeasure:
    'Um campo de medida não tem valor por linha, portanto só pode ser usado como valor de um gráfico — nunca como eixo de categorias, divisão, cor ou tamanho — e não pode ser usado de forma alguma em gráficos de dispersão ou de Gantt, que desenham uma marca por linha bruta.',
  chartUnsupportedDefault: 'Esta configuração de gráfico ainda não é suportada.',
  chartForecastSeriesLabel: 'Previsão',

  // Grid summary labels
  gridSummaryLabelSum: 'Total:',
  gridSummaryLabelAvg: 'Média:',
  gridSummaryLabelCount: 'Contagem:',
  gridSummaryLabelCountDistinct: 'Únicos:',
  gridSummaryLabelCountValues: 'Valores:',
  gridSummaryLabelMin: 'Mín.:',
  gridSummaryLabelMax: 'Máx.:',
  gridMutationError: 'Falha ao salvar as alterações',

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
  widgetAggPrefixCountValues: 'Contagem de valores de',
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

  // Canvas empty state
  canvasEmptyTitle: 'A tela está vazia',
  canvasEmptyEditModeHint: 'Use o painel Compor para adicionar widgets ou arraste-os para cá.',
  canvasEmptyViewModeHint: 'Mude para o modo de edição para adicionar widgets.',

  // Map widget legend
  mapLegendAriaLabel: (fieldLabel, min, max) =>
    `Escala de cores de ${fieldLabel} de ${min} a ${max}`,

  // Date range presets (calendar year / quarter)
  dateRangePresetThisCalendarYear: 'Este ano',
  dateRangePresetLastCalendarYear: 'Ano passado',
  dateRangePresetLast2CalendarYears: 'Últimos 2 anos',
  dateRangePresetThisQuarter: 'Este trimestre',
  dateRangePresetLastQuarter: 'Trimestre passado',
  dateRangePresetThisAndLastQuarter: 'Este e o trimestre passado',
  dateRangePresetCustom: 'Personalizado',
  dateRangePresetGroupRolling: 'Móvel',
  dateRangePresetGroupCalendarYear: 'Ano civil',
  dateRangePresetGroupQuarter: 'Trimestre',

  // Filters drawer (default view)
  filtersDefaultViewLabel: 'Visualização padrão',

  // Quick filter bar
  quickFilterBarEnableFilter: 'Ativar filtro',
  quickFilterBarDisableFilter: 'Desativar filtro',
  quickFilterBarRemoveFilter: 'Remover filtro',

  // Cross-filter mode bar
  crossFilterBarModeFilter: 'Filtro',
  crossFilterBarModeHighlight: 'Destacar',
  crossFilterBarModePerChart: 'Por gráfico',
  crossFilterBarAllPages: 'Todas as páginas',

  // Chart setup panel
  aggregationLockedHelperText:
    'Conta linhas — escolha um campo de valor para somar, calcular média etc.',

  // Funnel setup
  chartSetupFunnelLabelFormatLabel: 'Formato do rótulo',
  chartSetupFunnelLabelFormatValue: 'Valor',
  chartSetupFunnelLabelFormatPercent: '% do total',
  chartSetupFunnelLabelFormatConversion: 'Taxa de conversão',
  chartSetupFunnelLabelPlacementLabel: 'Posição do rótulo',
  chartSetupFunnelLabelPlacementInside: 'Interno',
  chartSetupFunnelLabelPlacementOutsideStart: 'Externo à esquerda',
  chartSetupFunnelLabelPlacementOutsideEnd: 'Externo à direita',
  chartSetupFunnelGapLabel: 'Espaçamento entre seções (px)',
  chartSetupFunnelShapeLabel: 'Forma',
  chartSetupFunnelShapeLinear: 'Linear',
  chartSetupFunnelShapeBump: 'Curva (bump)',
  chartSetupFunnelShapeStep: 'Degrau',
  chartSetupFunnelShapePyramid: 'Pirâmide',
  chartSetupFunnelStyleLabel: 'Estilo',
  chartSetupFunnelStyleFilled: 'Preenchido',
  chartSetupFunnelStyleOutlined: 'Contornado',

  // Sankey setup
  chartSetupSankeySourceLabel: 'Campo de origem (de)',
  chartSetupSankeySourceHelperText: 'Campo categórico para o nó inicial de cada fluxo',
  chartSetupSankeyTargetLabel: 'Campo de destino (para)',
  chartSetupSankeyTargetHelperText: 'Campo categórico para o nó final de cada fluxo',
  chartSetupSankeyValueHelperText: 'Campo numérico somado por link origem → destino',
  chartSetupSankeyLinkColorLabel: 'Cor do link',
  chartSetupSankeyLinkColorSource: 'Do nó de origem',
  chartSetupSankeyLinkColorTarget: 'Do nó de destino',
  chartSetupSankeyShowValuesLabel: 'Mostrar valores nos links',

  // Pie/donut & funnel category fields
  chartSetupXFieldPieDonutLabel: 'Categoria da fatia',
  chartSetupXFieldPieDonutHelperText: 'Cada valor exclusivo se torna uma fatia',
  chartSetupXFieldFunnelLabel: 'Campo de estágio',
  chartSetupXFieldFunnelHelperText: 'Campo categórico que define cada estágio do funil',
  chartSetupYMeasurePieDonutLabel: 'Valor da fatia',
  chartSetupFieldlessCountSplitByTooltip: 'Escolha um campo de medida para habilitar a divisão por',
  chartSetupSplitByFieldlessCountHelperText:
    'Não disponível para uma contagem sem campo — escolha primeiro um campo de medida',

  // KPI setup panel
  kpiSetupDateRangePresetLabel: 'Intervalo',

  // Map setup panel
  mapSetupValueFieldHelperText: 'Deixe vazio para contar linhas',
  mapSetupInteractionsTitle: 'Interações',
  mapSetupInteractionsDescription: 'Quando outros widgets são clicados, este mapa…',

  // Text setup panel
  textSetupPromptLabel: 'Prompt',
  textSetupPromptHelper:
    'Descreva o que a IA deve escrever — ela pode consultar as fontes de dados desta página',
  textSetupAiModeLabel: 'Modo IA',

  // Accessible names for otherwise-unlabeled form controls
  exprNodeKindAriaLabel: 'Tipo de entrada',
  exprFieldAriaLabel: 'Campo',
  exprAggregationAriaLabel: 'Agregação',
  exprLiteralTypeAriaLabel: 'Tipo literal',
  exprBooleanValueAriaLabel: 'Valor booleano',
  filterRankDirectionAriaLabel: 'Direção de classificação',
  filterRankCountLabel: 'Número de itens',
  filterSliderMinimumAriaLabel: (label) => `${label} mínimo`,
  filterSliderMaximumAriaLabel: (label) => `${label} máximo`,
  filterRelativeDateUnitAriaLabel: 'Unidade de tempo',
  filterRelativeDateDirectionAriaLabel: 'Direção',
  filterDateModeAriaLabel: 'Tipo de valor de data',
  formulaOperatorAriaLabel: 'Operador',
  chartAnnotationAxisAriaLabel: 'Eixo da linha de referência',
  gridConditionFieldAriaLabel: 'Campo da condição',
  gridConditionOperatorAriaLabel: 'Operador da condição',
  gridConditionStyleAriaLabel: 'Estilo da condição',
  gridConditionValueAriaLabel: 'Valor da condição',

  // KPI trend sentiment (screen-reader only)
  kpiTrendFavorableLabel: 'favorável',
  kpiTrendUnfavorableLabel: 'desfavorável',
  kpiTrendNoChangeLabel: 'sem alteração',

  // Canvas accessibility
  canvasResizeColumnsAriaLabel: 'Redimensionar colunas',
  canvasMoveWidgetUpAriaLabel: 'Mover widget para cima',
  canvasMoveWidgetDownAriaLabel: 'Mover widget para baixo',
  canvasMoveWidgetLeftAriaLabel: 'Mover widget para a esquerda',
  canvasMoveWidgetRightAriaLabel: 'Mover widget para a direita',
  gridColumnMoveUpAriaLabel: 'Mover coluna para cima',
  gridColumnMoveDownAriaLabel: 'Mover coluna para baixo',
  canvasRegionAriaLabel: 'Área do painel',
  sidebarPanelOpenedAnnouncement: (label) => `Painel ${label} aberto`,
  sidebarPanelClosedAnnouncement: 'Painel fechado',
  canvasResizeAnnouncement: (span, total) => `Coluna redimensionada para ${span} de ${total}`,
  canvasWidgetMovedAnnouncement: 'Widget movido',
  canvasWidgetAddedAnnouncement: 'Widget adicionado',

  // Chart / KPI / map text alternatives
  ganttChartAriaLabel: (itemCount, from, to, details) =>
    `Gráfico de Gantt com ${itemCount} ${itemCount === 1 ? 'item' : 'itens'} de ${from} até ${to}. ${details}.`,
  ganttItemAriaLabel: (label, from, to, duration) => `${label}: de ${from} até ${to} (${duration})`,
  sankeyLinkAriaLabel: (source, target, value) => `${source} para ${target}: ${value}`,
  sankeyChartAriaLabel: (nodeCount, linkCount, details) =>
    `Diagrama de fluxo Sankey com ${nodeCount} ${nodeCount === 1 ? 'nó' : 'nós'} e ${linkCount} ${linkCount === 1 ? 'link' : 'links'}. ${details}.`,
  mapRegionAriaLabel: (region, valueLabel, value) => `${region}: ${valueLabel} ${value}`,
  kpiGaugeAriaLabel: (value, max, percent) => `Medidor: ${value} de ${max} (${percent}%).`,
  kpiSparklineAriaLabel: (pointCount, trend, from, to) => {
    let trendText = 'estável';
    if (trend === 'up') {
      trendText = 'em alta';
    } else if (trend === 'down') {
      trendText = 'em baixa';
    }
    return `Sparkline com ${pointCount} pontos, ${trendText}, de ${from} até ${to}.`;
  },
  mapChartAriaLabel: (measure, regionCount, min, max) =>
    `Mapa coroplético${measure ? ` de ${measure}` : ''} com ${regionCount} ${regionCount === 1 ? 'região' : 'regiões'}, valores de ${min} a ${max}.`,
  lineageGraphAriaLabel: (sourceCount, relationshipCount) =>
    `Gráfico de relações de dados com ${sourceCount} ${sourceCount === 1 ? 'fonte' : 'fontes'} e ${relationshipCount} ${relationshipCount === 1 ? 'relação' : 'relações'}.`,
};

export const ptBR: Localization = getStudioLocalization(ptBRLocaleText);

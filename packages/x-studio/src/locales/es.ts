import type { StudioLocaleText } from '../internals/StudioUIConfigContext';
import { getStudioLocalization, type Localization } from './utils/getStudioLocalization';

/**
 * Spanish (es) locale text for Studio.
 *
 * @example
 * ```tsx
 * import { esLocaleText } from '@mui/x-studio';
 * <Studio localeText={esLocaleText} />
 * ```
 */
export const esLocaleText: Partial<StudioLocaleText> = {
  // Drawers
  dataDrawerTitle: 'Datos',
  composeDrawerTitle: 'Componer',
  filtersDrawerTitle: 'Filtros',

  // Date range presets
  dateRangePresetAllTime: 'Todo el período',
  dateRangePresetYTD: 'Año corriente',
  dateRangePresetThisMonth: 'Este mes',
  dateRangePresetLast3Months: 'Últimos 3 meses',
  dateRangePresetLast12Months: 'Últimos 12 meses',

  // Filters drawer
  filterSearchPlaceholder: 'Buscar filtros…',
  filtersSectionPageFiltersTitle: 'Filtros de página',
  filtersSectionNoFilters: 'No se aplicaron filtros.',
  filtersSectionNoMatchingFilters: 'No hay filtros coincidentes.',
  filtersAddFilterTooltip: 'Agregar filtro',
  filtersSavedViewsTitle: 'Vistas guardadas',
  filtersSaveViewTooltip: 'Guardar filtros de página como una vista con nombre',
  filtersSaveViewButton: 'Guardar',
  filtersSaveViewPlaceholder: 'Nombre de la vista',
  filtersDeleteViewTooltip: 'Eliminar vista',
  filtersNoSavedViews: 'No se guardaron vistas. Aplicar filtros y guardar aquí.',
  filtersAddDataSourceHint: 'Primero agregue una fuente de datos y widgets.',

  // Widget states
  widgetConfigureChartHint: 'Utilice la pestaña Configurar para configurar este gráfico.',
  widgetConfigureGaugeHint:
    'Utilice la pestaña Configurar para elegir el campo de valor del medidor.',
  widgetConfigurePivotHint: 'Utilice la pestaña Configurar para configurar la tabla dinámica.',
  widgetNoData: 'Sin datos',
  widgetLoadError: 'No se pudieron cargar los datos',
  mapGeographyLoadError: 'No se pudieron cargar los datos del mapa. Inténtelo de nuevo.',
  widgetLoadingLabel: 'Cargando',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Abrir panel de filtros',
  quickFilterBarClearAll: 'Borrar todos los filtros',
  dateRangeBarFieldLabel: 'Rango de fechas',

  // Widget card actions
  widgetEditTooltip: 'Editar widget',
  widgetExportCsvTooltip: 'Descargar como CSV',
  widgetExportPngTooltip: 'Descargar como PNG',
  widgetExportNoDataMessage:
    'Aún no hay datos disponibles para exportar. Abra la cuadrícula para que pueda cargar datos del servidor y vuelva a intentar la exportación.',
  widgetExportUnavailableMessage:
    'Este widget no tiene nada que exportar. Termina de configurarlo — una tabla necesita un origen de datos y una tabla dinámica necesita filas, columnas y valores — y vuelve a intentarlo.',
  widgetExpandTooltip: 'Expandir widget',
  widgetMoveToPageLabel: 'Mover a la página',
  widgetDuplicateTooltip: 'Duplicar widget',
  widgetDeleteTooltip: 'Eliminar widget',
  widgetAiAssistantTooltip: 'Asistente de IA',
  widgetAiInsightTooltip: 'Información de IA',
  widgetAiRefreshTooltip: 'Actualizar contenido de IA',
  widgetInsightTypeSummary: 'Resumen',
  widgetInsightTypeAnalysis: 'Análisis',
  widgetInsightTypeForecast: 'Pronóstico',
  widgetDetectAnomalyTooltip: 'Detectar anomalías',
  widgetHideAnomalyTooltip: 'Ocultar anomalías',
  widgetExplainAnomalyTooltip: 'Explicar anomalías',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Configurar',
  widgetEditDialogTabFilters: 'Filtros',
  widgetEditDialogTabFormat: 'Formato',
  widgetEditDialogCloseAriaLabel: 'Cerrar el cuadro de diálogo de edición',
  widgetUntitledLabel: (kindLabel) => `${kindLabel} sin título`,
  widgetEditDialogPreviewLabel: (kindLabel) => `Vista previa de ${kindLabel.toLowerCase()}`,

  // AI assistant
  aiAssistantOpenTooltip: 'Abrir asistente de IA',
  aiAssistantCloseTooltip: 'Cerrar asistente de IA',
  aiAssistantPanelTitle: 'Asistente de IA',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Cerrar configuración del widget',
  sidebarPanelsAriaLabel: 'Paneles laterales',
  drawerPanelError: 'Se produjo un error al mostrar este panel.',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Aumentar',
  numberFieldDecreaseAriaLabel: 'Disminuir',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Cerrar gráfico ampliado',
  widgetCardExportPngAriaLabel: 'Descargar gráfico ampliado como PNG',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Describir un widget',
  aiCreateWidgetPlaceholder:
    'Por ejemplo: gráfico de barras que muestra los ingresos por país, KPI de pedidos totales...',
  aiCreateWidgetButton: 'Crear',
  aiCreateWidgetLoading: 'Creando…',
  aiCreateWidgetError: 'No se pudo crear el widget',
  aiCreateWidgetNetworkError: 'Error de red. Comprueba tu conexión e inténtalo de nuevo.',
  aiCreateWidgetRequestFailed: (status, detail) =>
    `La solicitud de IA falló (${status})${detail ? `: ${detail}` : ''}.`,
  aiCreateWidgetInvalidResponse: 'Respuesta no válida de la IA.',
  aiTextWidgetGenerationError: 'No se pudo generar el contenido',

  // Widget type names
  widgetKindGrid: 'Tabla',
  widgetKindChart: 'Gráfico',
  widgetKindKpi: 'KPI',
  widgetKindText: 'Texto',
  widgetKindFilter: 'Filtro',
  widgetKindPivot: 'Tabla dinámica',
  widgetKindMap: 'Mapa',

  // Widget type descriptions
  widgetKindTextDescription: 'Título, subtítulo y cuerpo del texto.',
  widgetKindKpiDescription: 'Métrica única con agregación',
  widgetKindChartDescription: 'Visualice datos con un gráfico configurable',
  widgetKindGridDescription: 'Tabla de datos con ordenación y filtrado',
  widgetKindFilterDescription: 'Control de filtro interactivo para el modo de vista previa',
  widgetKindPivotDescription: 'Tabulación cruzada con dimensiones de filas y columnas.',
  widgetKindMapDescription: 'Mapa mundial de coropletas por país',
  composeCustomWidgetDescription: 'Widget personalizado',

  // Data type labels
  dataTypeString: 'Texto',
  dataTypeNumber: 'Número',
  dataTypeBoolean: 'Booleano',
  dataTypeDate: 'Fecha',
  dataTypeDatetime: 'Fecha y hora',

  // Compose drawer / widget picker
  composeChooseWidgetType: 'Elija un tipo de widget',
  composeNoDataSources:
    'No hay fuente de datos disponible. Sólo se pueden agregar widgets de texto.',
  composeOnThisPage: 'En esta página',
  composeAddWidgetLabel: (widgetTypeLabel) => `Agregar widget ${widgetTypeLabel}`,
  composeCloseAriaLabel: 'Cerrar',
  composeBackToWidgetTypesAriaLabel: 'Volver a tipos de widgets',
  composeCancel: 'Cancelar',

  // Format panel
  formatAutoTitle: 'Título generado automáticamente',
  formatResetTitle: 'Restablecer el título generado automáticamente',
  formatAutoSubtitle: 'Subtítulo generado automáticamente',
  formatResetSubtitle: 'Restablecer subtítulos generados automáticamente',
  formatPanelCompactNumbers: 'Números compactos',
  formatPanelWidgetTitleLabel: 'Título del widget',
  formatPanelWidgetTitleHelperText: 'Mostrado en el encabezado del widget',
  formatPanelSubtitleLabel: 'Subtítulo',
  formatPanelSubtitleHelperText: 'Línea opcional que se muestra debajo del título.',

  // Text format panel
  textFormatFontFamilyLabel: 'Familia de fuentes',
  textFormatFontSizeLabel: 'Tamaño de fuente',
  textFormatColorLabel: 'Color',
  textFormatColorPlaceholder: 'Estándar',
  textFormatAlignLeftAriaLabel: 'Alinear a la izquierda',
  textFormatAlignCenterAriaLabel: 'Centralizar',
  textFormatAlignRightAriaLabel: 'Alinear a la derecha',
  textFormatDefaultFont: 'Predeterminado (tema)',
  textFormatSansSerifFont: 'Sin serifa',
  textFormatSerifFont: 'Serifa',
  textFormatMonospaceFont: 'monoespaciado',
  textFormatDefaultSize: 'Estándar',
  textFormatFontSizeOption: (px) => `${px} px`,
  textFormatAlignmentLabel: 'Alineación',

  // Data drawer
  dataDrawerNoSources:
    'No hay fuentes de datos configuradas. Agregue un widget al panel para cargar datos de muestra.',
  dataDrawerViewLineage: 'Ver linaje de datos',
  dataDrawerLineageTitle: 'Linaje de datos',
  dataDrawerLineageHelper:
    'Haga clic en un nodo para ver sus datos. Haga clic en un borde para inspeccionar los campos clave de unión.',
  dataDrawerRowsLabel: (count) => `${count} ${count === 1 ? 'fila' : 'filas'}`,
  dataDrawerFieldsLabel: (count) => `${count} ${count === 1 ? 'campo' : 'campos'}`,
  dataDrawerBackAriaLabel: 'Volver al gráfico de linaje',
  dataDrawerCloseAriaLabel: 'Cerrar linaje de datos',
  dataDrawerEditTooltip: 'Editar',
  dataDrawerDeleteTooltip: 'Borrar',
  dataDrawerAddCalculatedField: 'Agregar campo calculado',
  dataDrawerNoData: (sourceLabel) => `No hay datos disponibles para ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} fila${count === 1 ? '' : 's'} más`,
  dataDrawerMoreColumns: (count) => `${count} columna${count === 1 ? '' : 's'} más`,
  dataDrawerViewSourceLink: 'Ver datos de origen →',
  dataDrawerMorePreviewRows: (count) => `+${count} más`,
  dataDrawerRowsUnknown: 'número de filas no disponible',
  dataDrawerDeleteFieldConfirmTitle: '¿Eliminar el campo calculado?',
  dataDrawerDeleteFieldConfirmMessage: (fieldLabel, referenceCount) =>
    `«${fieldLabel}» se usa en ${referenceCount} ${
      referenceCount === 1 ? 'lugar' : 'lugares'
    } (widgets, filtros o campos calculados). Al eliminarlo, ${
      referenceCount === 1 ? 'ese lugar se quedará' : 'esos lugares se quedarán'
    } sin ningún valor que mostrar.`,
  saveRejectedMessage:
    'No se pudo guardar este cambio: es posible que se haya eliminado o modificado en otro lugar. Cierra el diálogo e inténtalo de nuevo.',
  lineageTypePrefix: (type) => `Tipo: ${type}`,
  lineageJoinDetail: (srcSource, srcField, tgtSource, tgtField) =>
    `Unión: ${srcSource}.${srcField} = ${tgtSource}.${tgtField}`,
  lineageViaDetail: (via) => `Vía: ${via}`,
  lineagePreviewAriaLabel: (label) => `Vista previa de ${label}`,
  lineageNoRelationships: 'No hay relación definida entre fuentes',

  // Relationship management
  relationshipEditTooltip: 'Editar',
  relationshipRemoveTooltip: 'Eliminar',
  relationshipCancel: 'Cancelar',
  relationshipTypeManyToOne: 'muchos a uno',
  relationshipTypeOneToOne: 'Cara a cara',
  relationshipTypeManyToMany: 'muchos a muchos',
  relationshipTypeLabel: 'Tipo',
  relationshipJoinFieldLabel: 'Campo de unión',
  relationshipJunctionTableLabel: 'Tabla de unión (puente)',
  relationshipJunctionSourceLabel: 'Fuente de unión',
  relationshipJunctionSourceFkLabel: '→ FK de origen',
  relationshipJunctionTargetFkLabel: '→ Destino FK',
  relationshipAddTitle: 'Agregar relación',
  relationshipEditTitle: 'Editar relación',
  relationshipSourceManyLabel: 'Lado de muchos',
  relationshipSourceLabel: 'Origen',
  relationshipTargetOneLabel: 'Lado uno',
  relationshipTargetLabel: 'Destino',
  relationshipUpdate: 'Actualizar',
  relationshipAdd: 'para agregar',
  relationshipSectionTitle: 'Relaciones',
  relationshipAddButton: 'para agregar',
  relationshipNone: 'No hay relaciones configuradas.',
  relationshipVia: (junctionLabel) => `vía ${junctionLabel}`,

  // Filter conditions & values
  filterConditionAnd: 'Y',
  filterConditionOr: 'O',
  filterOperatorLabel: 'Operador',
  filterRemoveSecondCondition: 'Eliminar la segunda condición',
  filterAbsoluteDate: 'fecha absoluta',
  filterRelativeDate: 'fecha relativa',
  filterBooleanTrue: 'VERDADERO',
  filterBooleanFalse: 'FALSO',
  filterRemoveAriaLabel: 'Quitar filtro',
  filterInteractiveSectionTitle: 'Filtros interactivos',
  filterCrossSectionTitle: 'Filtros cruzados',
  filterClearFilter: 'Limpiar filtro',
  filterClearInteractiveAriaLabel: 'Borrar filtro interactivo',
  filterClearAllCrossFilters: 'Limpiar todos los filtros cruzados',
  filterRemoveCrossFilter: 'Quitar filtro cruzado',
  filterSearchValues: 'Valores de búsqueda…',
  filterSelectField: 'Seleccione un campo...',
  filterValueLabel: 'Valor',
  filterValueHelper: 'Valor a comparar',
  filterValueAmountLabel: 'Valor',
  filterSelectParent: 'Seleccione el filtro principal...',
  filterFieldLabel: 'Campo',
  filterRankByLabel: 'Ordenar por',
  filterSelectionNoValues: 'No se encontraron valores.',
  filterSelectionAll: 'Todos',
  filterSelectionSelectedCount: (count) => `${count} seleccionado${count === 1 ? '' : 's'}`,
  filterSelectionCapHint: (cap) =>
    `Mostrando los primeros ${cap} valores. Escriba para acotar la lista.`,
  filterSectionNoInteractiveFilters:
    'No hay filtros interactivos activos. Utilice widgets de filtro en pantalla para configurar filtros.',
  filterSectionNoCrossFilters:
    'No hay filtro cruzado activo. Haga clic en los elementos del gráfico o seleccione filas de la tabla para crear filtros cruzados.',
  filterSectionSelectedCount: (count) => `${count} seleccionado${count === 1 ? '' : 's'}`,
  filterSectionValueDisplay: (fieldLabel, value) => `${fieldLabel} = ${value}`,
  filterSectionSourcePrefix: (widgetTitle) => `De: ${widgetTitle}`,
  filterBodyAddCondition: 'Agregar condición',
  filterBodyNarrowOptions: 'Opciones limitadas basadas en:',
  filterModeFilter: 'Filtrar',
  filterModeSelect: 'Seleccionar',
  filterModeRank: 'Clasificar',
  filterRelativeUnitSeconds: 'segundos',
  filterRelativeUnitMinutes: 'minutos',
  filterRelativeUnitHours: 'horas',
  filterRelativeUnitDays: 'días',
  filterRelativeUnitWeeks: 'semanas',
  filterRelativeUnitMonths: 'meses',
  filterRelativeUnitYears: 'años',
  filterDatePreset7Days: '7 dias',
  filterDatePreset30Days: '30 dias',
  filterDatePreset3Months: '3 meses',
  filterDatePreset12Months: '12 meses',
  filterDatePreset1Year: '1 año',
  filterRelativeDateAgo: 'atrás',
  filterRelativeDateFromNow: 'a partir de ahora',
  filterDateLabel: 'Fecha',
  filterRankAggSumLabel: 'Suma de todas las series',
  filterRankAggAvgLabel: 'Promedio de todas las series.',
  filterRankAggMaxLabel: 'Máximo de todas las series.',
  filterRankAggMinLabel: 'Mínimo de todas las series.',
  filterRankTop: 'Más grande',
  filterRankBottom: 'Menores',
  filterRankTopCount: (count) => `${count} mayores`,
  filterRankBottomCount: (count) => `${count} menores`,

  // Filter summary
  filterSummaryAnyValue: 'cualquier valor',
  filterSummaryIsOneOf: 'es uno de:',
  filterSummaryIsNot: 'no es:',
  filterSummaryAndMore: (count) => `y ${count} más`,
  filterSummaryFrom: (value) => `desde ${value}`,
  filterSummaryUntil: (value) => `hasta ${value}`,

  // Filter operator labels (per field type)
  filterOperator_string_equals: 'Es igual a',
  filterOperator_string_not_equals: 'No es igual a',
  filterOperator_string_contains: 'Contiene',
  filterOperator_string_does_not_contain: 'No contiene',
  filterOperator_string_starts_with: 'Empieza por',
  filterOperator_string_not_starts_with: 'No empieza por',
  filterOperator_string_ends_with: 'Termina en',
  filterOperator_string_not_ends_with: 'No termina en',
  filterOperator_string_is_empty: 'Está vacío',
  filterOperator_string_is_not_empty: 'No está vacío',
  filterOperator_number_equals: '=',
  filterOperator_number_not_equals: '≠',
  filterOperator_number_greater_than: '>',
  filterOperator_number_greater_than_or_equal: '≥',
  filterOperator_number_less_than: '<',
  filterOperator_number_less_than_or_equal: '≤',
  filterOperator_number_between: 'Entre',
  filterOperator_number_is_empty: 'Está vacío',
  filterOperator_number_is_not_empty: 'No está vacío',
  filterOperator_date_equals: 'El',
  filterOperator_date_not_equals: 'No el',
  filterOperator_date_less_than: 'Antes de',
  filterOperator_date_greater_than: 'Después de',
  filterOperator_date_less_than_or_equal: 'El o antes de',
  filterOperator_date_greater_than_or_equal: 'El o después de',
  filterOperator_date_between: 'Entre',
  filterOperator_date_is_empty: 'Está vacío',
  filterOperator_date_is_not_empty: 'No está vacío',
  filterOperator_datetime_equals: 'A las',
  filterOperator_datetime_not_equals: 'No a las',
  filterOperator_datetime_greater_than: 'Después de',
  filterOperator_datetime_less_than: 'Antes de',
  filterOperator_datetime_greater_than_or_equal: 'A las o después de',
  filterOperator_datetime_less_than_or_equal: 'A las o antes de',
  filterOperator_datetime_between: 'Entre',
  filterOperator_datetime_is_empty: 'Está vacío',
  filterOperator_datetime_is_not_empty: 'No está vacío',
  filterOperator_boolean_equals: 'Es',
  filterOperator_boolean_not_equals: 'No es',

  // Expression field dialog
  exprNodeTypeField: 'Campo',
  exprNodeTypeLiteral: 'Literal',
  exprNodeTypeFunction: 'Función',
  exprDataTypeNumber: 'Número',
  exprDataTypeText: 'Texto',
  exprDataTypeBoolean: 'Booleano',
  exprBooleanTrue: 'Verdadero',
  exprBooleanFalse: 'Falso',
  exprExpandTooltip: 'Expandir',
  exprCollapseTooltip: 'Contraer',
  exprRemoveInputTooltip: 'Eliminar entrada',
  exprCancel: 'Cancelar',
  exprSave: 'Guardar',
  exprAddField: 'Agregar campo',
  expressionNameLabel: 'Nombre',
  expressionNameHelperText: 'Se utiliza como etiqueta de campo en selectores y columnas de tabla.',
  expressionNamePlaceholder: 'por ejemplo: beneficio, ingresos por unidad',
  expressionDescriptionLabel: 'Descripción',
  expressionDescriptionHelperText:
    'Opcional. Se muestra como información sobre herramientas en los selectores de campos.',
  expressionDescriptionPlaceholder: 'Opcional: describe lo que calcula este campo',
  expressionPrecisionLabel: 'Precisión',
  expressionPrecisionHelperText:
    'Lugares decimales (0–10) utilizados para dar formato a este campo calculado',
  expressionBuilderSectionLabel: 'Expresión',

  // Expression builder: operator picker
  exprOpAdd: 'Sumar (+)',
  exprOpSubtract: 'Restar (−)',
  exprOpMultiply: 'Multiplicar (×)',
  exprOpDivide: 'Dividir (÷)',
  exprOpModulo: 'Módulo (%)',
  exprOpNegate: 'Negar (−x)',
  exprOpEquals: 'Igual a (=)',
  exprOpNotEqual: 'Distinto de (≠)',
  exprOpLessThan: 'Menor que (<)',
  exprOpGreaterThan: 'Mayor que (>)',
  exprOpLessThanOrEqual: 'Menor o igual que (≤)',
  exprOpGreaterThanOrEqual: 'Mayor o igual que (≥)',
  exprOpAnd: 'Y',
  exprOpOr: 'O',
  exprOpNot: 'No',
  exprOpIsTrue: 'Es verdadero',
  exprOpIsFalse: 'Es falso',
  exprOpIsNull: 'Es nulo',
  exprOpIsNotNull: 'No es nulo',
  exprOpIf: 'Si / Entonces / Si no',
  exprOpIn: 'En (el valor es uno de)',
  exprOpDatediff: 'Diferencia de fechas',
  exprGroupArithmetic: 'Aritmética',
  exprGroupComparison: 'Comparación',
  exprGroupLogical: 'Lógica',
  exprGroupConditional: 'Condicional',
  exprGroupDate: 'Fecha',
  exprInputLabelUnit: 'Unidad (por ejemplo "día", "mes", "año")',
  exprInputLabelCondition: 'Condición',
  exprInputLabelThen: 'Entonces',
  exprInputLabelElse: 'Si no',
  exprInputLabelGeneric: (index) => `Entrada ${index}`,
  exprAddInputButton: 'Agregar entrada',
  exprOutputTypeLabel: 'Tipo de salida:',
  exprRootNodeLabel: 'Expresión',
  exprLiteralValueAriaLabel: 'Valor literal',
  exprUnnamedFieldLabel: 'Sin nombre',
  exprPreviewNullLabel: 'null',
  exprCalculatedFieldBadgeLabel: 'Campo calculado',

  // Expression validation errors
  exprErrorMissingId: 'El campo calculado debe tener un identificador.',
  exprErrorMissingLabel: 'El campo calculado debe tener un nombre.',
  exprErrorMissingSourceId: 'El campo calculado debe estar asociado a una fuente de datos.',
  exprErrorMaxDepth: (maxDepth) => `La expresión está anidada más de ${maxDepth} niveles.`,
  exprErrorUnknownField: (fieldId) =>
    `No se encontró el campo «${fieldId}» ni en los campos de la fuente ni en los campos calculados.`,
  exprErrorUnreachableField: (fieldId, fieldSourceId) =>
    `El campo «${fieldId}» pertenece a la fuente de datos «${fieldSourceId}», que no está relacionada con la fuente de datos de este campo.`,
  exprErrorMalformedNode:
    'Nodo de expresión no válido: se esperaba un nodo de operador (con un array `inputs`), un valor literal, una referencia a un campo o una referencia a un campo de unión.',
  exprErrorInsufficientArity: (operator, required, actual) =>
    `El operador «${operator}» requiere al menos ${required} entrada(s); se recibieron ${actual}.`,
  exprErrorCircularDependency: (fieldId) =>
    `El campo calculado «${fieldId}» crea una dependencia circular.`,

  // Shared aggregation function labels
  aggFnSum: 'Suma',
  aggFnCount: 'Contar',
  aggFnCountRows: 'Contar (filas)',
  aggFnCountValues: 'Recuento (valores)',
  aggFnAverage: 'Promedio',
  aggFnMin: 'Mín.',
  aggFnMax: 'Máx.',

  // Shared time granularity labels
  timeGranNone: 'Ninguno (valores brutos)',
  timeGranDay: 'Día',
  timeGranWeek: 'Semana',
  timeGranMonth: 'Mes',
  timeGranQuarter: 'Trimestre',
  timeGranYear: 'Año',

  // Shared sort direction labels
  sortAscendingAriaLabel: 'Creciente',
  sortDescendingAriaLabel: 'Descendente',
  crossFilterModeHighlight: 'Destacar',
  crossFilterModeFilter: 'Filtrar',
  crossFilterModeNone: 'Ninguno',

  // Chart setup panel
  chartTypePickerLabel: 'Tipo de gráfico',
  chartTypeBarGrouped: 'Barra (agrupada)',
  chartTypeBarStacked: 'Barra (apilada)',
  chartTypeBar100: 'Barra (100%)',
  chartTypeBarHorizontal: 'Barra (horizontal)',
  chartTypeBarStackedHorizontal: 'Barra (apilada, horizontal)',
  chartTypeBar100Horizontal: 'Barra (100%, horizontal)',
  chartTypeLine: 'Línea',
  chartTypeArea: 'Área',
  chartTypeAreaStacked: 'Área (apilada)',
  chartTypeArea100: 'Área (100%)',
  chartTypeScatter: 'Dispersión',
  chartTypeMixed: 'Mixto (barra + línea)',
  chartTypeHeatmap: 'Mapa de calor',
  chartTypeFunnel: 'Embudo',
  chartTypeGantt: 'Gantt / Cronología',
  chartTypeSankey: 'Sankey',
  chartTypePie: 'Circular',
  chartTypeDonut: 'Anillo',
  chartTypeGauge: 'Medidor',
  chartSetupValueFieldLabel: 'Campo de valor',
  chartSetupValueFieldHelperText: 'Campo numérico para agregar',
  chartSetupAggregationLabel: 'Agregación',
  chartSetupMinLabel: 'Mín.',
  chartSetupMaxLabel: 'Máx.',
  chartSetupGroupByLabel: 'Agrupar por',
  chartSetupSortByLabel: 'Ordenar por',
  chartSetupSortCategory: 'Categoría',
  chartSetupSortValue: 'Valor',
  chartSetupSortNatural: 'Natural',
  chartSetupSortNone: 'Ninguno',
  chartSetupSortPercent: 'Porcentaje',
  chartSetupSortDirectionAriaLabel: 'Dirección de pedido',
  chartSetupAnnotationsTitle: 'Notas',
  chartSetupInteractionsTitle: 'Interacciones',
  chartSetupInteractionsDescription: 'Cuando se hace clic en otros widgets, este gráfico...',
  chartSetupAddSeries: 'Agregar serie',
  chartSetupNoMoreFields: 'No más campos para agregar',
  chartSetupRemoveSeries: 'Quitar serie',
  chartSetupAddReferenceLine: 'Agregar línea de referencia',
  chartSetupRemoveAnnotation: 'Eliminar anotación',
  chartSetupNoReferenceLines: 'Sin líneas de referencia. Haga clic en + para agregar uno.',
  chartSetupDualYAxis: 'Eje Y dual (serie de líneas en el eje derecho)',
  chartSetupReferenceLineValueLabel: 'Valor',
  chartSetupReferenceLineLabelLabel: 'Etiqueta',
  chartSetupYFieldLabel: 'Campo Y (numérico)',
  chartSetupYFieldHelperText: 'Campo numérico trazado en el eje vertical.',
  chartSetupColorByLabel: 'Color por (opcional)',
  chartSetupColorByHelperText: 'Divide puntos en series por categoría codificada por colores',
  chartSetupSizeByLabel: 'Tamaño por (opcional)',
  chartSetupSizeByHelperText:
    'Campo numérico que controla el radio de la burbuja (produce un gráfico de burbujas)',
  chartSetupMinRadiusLabel: 'Radio mínimo',
  chartSetupMaxRadiusLabel: 'Radio máximo',
  chartSetupFunnelValueHelperText:
    'Campo numérico resumido por etapa: las etapas están ordenadas por valor (el más grande primero)',
  chartSetupHeatmapRowAxisLabel: 'Campo de eje de línea',
  chartSetupHeatmapRowAxisHelperText:
    'Campo para el eje vertical (línea) — cualquier tipo de campo de la fuente principal, p.e. categoría, descuento % u hora del día',
  chartSetupHeatmapValueLabel: 'Campo de valor/color',
  chartSetupHeatmapValueHelperText:
    'Campo numérico sumado por celda para determinar la intensidad del color',
  chartSetupHeatmapColourSchemeLabel: 'esquema de color',
  chartSetupHeatmapSortByLabel: 'Ordenar por',
  chartSetupHeatmapSortXAxis: 'Eje de columnas (X)',
  chartSetupHeatmapSortYAxis: 'Eje de filas (Y)',
  chartSetupArcLabelLabel: 'Etiqueta de arco',
  chartSetupMinAngleLabel: 'Ángulo mínimo (°)',
  chartSetupMinAngleHelperText:
    'Los cortes más pequeños que este ángulo (grados) no mostrarán una etiqueta',
  chartSetupGanttLabelFieldLabel: 'Campo de etiqueta',
  chartSetupGanttLabelFieldHelperText:
    'Campo mostrado como una etiqueta de línea en el eje Y (por ejemplo, nombre de tarea o pedido)',
  chartSetupGanttStartDateLabel: 'Campo de fecha de inicio',
  chartSetupGanttStartDateHelperText: 'Campo de fecha/hora para el inicio de cada barra',
  chartSetupGanttEndDateLabel: 'Campo de fecha de finalización',
  chartSetupGanttEndDateHelperText: 'Campo de fecha/hora para el final de cada barra',
  chartSetupGanttColourByLabel: 'Color por (opcional)',
  chartSetupGanttColourByHelperText:
    'Campo categórico utilizado para colorear las barras (por ejemplo, estado o categoría)',
  chartSetupXFieldNumericLabel: 'Campo X (numérico)',
  chartSetupXFieldCategoryVertLabel: 'Campo Y/categoría',
  chartSetupXFieldCategoryHorizLabel: 'Campo X/categoría',
  chartSetupXFieldHorizontalHelperText: 'Trazado en el eje horizontal.',
  chartSetupXFieldGroupVertHelperText: 'Agrupa datos a lo largo del eje vertical.',
  chartSetupXFieldGroupHorizHelperText: 'Agrupa datos a lo largo del eje horizontal.',
  chartSetupYMeasureFieldsLabel: 'Campos Y/medida',
  chartSetupXMeasureFieldsLabel: 'X/campos de medida',
  chartSetupYMeasureFieldLabel: 'Campo/medida Y',
  chartSetupXMeasureFieldLabel: 'Campo X/medida',
  chartSetupNoDataAlert:
    'No hay ningún campo de datos disponible para la configuración del gráfico.',
  chartSetupSeriesLabel: (index) => `Serie ${index + 1}`,
  chartSetupSeriesNumericHorizHelperText: 'Campo numérico trazado a lo largo del eje horizontal',
  chartSetupSeriesNumericSumHelperText: 'Campo numérico sumado o promediado por categoría',
  chartSetupMixedSeriesBar: 'Bar',
  chartSetupMixedSeriesLine: 'Línea',
  chartSetupRemoveSplitByTooltip:
    'Elimine campos de medidas adicionales para habilitar la división por',
  chartSetupInnerRingLabel: 'Categoría de anillo interior',
  chartSetupSplitByLabel: 'Dividir por (campo de serie)',
  chartSetupArcLabelsTitle: 'Etiquetas de arco',
  chartSetupSplitByHelperText: 'Divide los datos en una serie separada por valor',
  chartSetupSplitByDisabledHelperText: 'No disponible cuando se configuran varios campos de medida',
  chartSetupInnerRingHelperText: 'Agrega un anillo interior concéntrico agrupado por este campo.',
  chartSetupGaugeMinRevertedHelperText:
    'El mínimo debe ser un número menor que el máximo: se revirtió tu entrada.',
  chartSetupGaugeMaxRevertedHelperText:
    'El máximo debe ser un número mayor que el mínimo: se revirtió tu entrada.',
  chartSetupRadiusRevertedHelperText: (min, max) =>
    `Introduce un número entre ${min} y ${max}, manteniendo el radio mínimo por debajo del máximo: se revirtió tu entrada.`,
  chartSetupValueClampedHelperText: (clamped) =>
    `Fuera del intervalo permitido: se ajustó a ${clamped}.`,

  // KPI setup panel
  kpiSetupChartLine: 'Línea',
  kpiSetupChartBar: 'Bar',
  kpiSetupChartGauge: 'Medidor',
  kpiSetupCompPrevPeriod: 'Periodo anterior (duración equivalente)',
  kpiSetupCompPrevCalendarPeriod: 'Periodo calendario anterior',
  kpiSetupCompSameLastYear: 'Mismo periodo el año pasado',
  kpiSetupInteractionsTitle: 'Interacciones',
  kpiSetupInteractionsDescription: 'Cuando se hace clic en otros widgets, este KPI...',
  kpiSetupTimeFieldLabel: 'Campo de tiempo',
  kpiSetupGranularityLabel: 'Granularidad',
  kpiSetupPlotTypeLabel: 'Tipo de gráfico',
  kpiSetupValueFieldLabel: 'Campo de valor',
  kpiSetupValueFieldHelperText: 'Campo para agregar',
  kpiSetupSparklineLabel: 'minigráfico',
  kpiSetupGaugeMaxLabel: 'Meta',
  kpiSetupTrendLabel: 'Tendencia',
  kpiSetupDateRangeLabel: 'Rango de fechas',
  kpiSetupDateRangeFieldLabel: 'Campo de fecha',
  kpiSetupCompPeriodLabel: 'Periodo de comparación',
  kpiSetupDateAggEarliest: 'Más temprano',
  kpiSetupDateAggLatest: 'Más tarde',
  kpiSetupFillAreaLabel: 'Rellenar área',
  kpiSetupCumulativeLabel: 'Acumulado (total acumulado)',
  kpiSetupAutoDateFilterPrefix: 'Usando filtro de fecha:',
  kpiSetupInvertColours: 'Invertir colores (cuanto más pequeño, mejor)',
  kpiSetupFixedWindowLabel: 'Ventana de tendencia',
  kpiSetupFixedWindowNone: 'Del filtro de fechas',
  kpiSetupFixedWindowMonth: 'Últimos 30 días',
  kpiSetupFixedWindowQuarter: 'Últimos 90 días',
  kpiSetupFixedWindowYear: 'Últimos 365 días',

  // KPI widget
  kpiGranularityAutoLabel: 'Ser',

  // Grid setup panel
  gridSetupDataSourceLabel: 'fuente de datos',
  gridSetupDataSourcePlaceholder: 'Seleccione una fuente de datos...',
  gridSetupAllColumnsAdded: 'Se han agregado todas las columnas disponibles.',
  gridSetupCrossFilterFieldLabel: 'Campo de filtro cruzado',
  gridSetupCrossFilterFieldHelper:
    'Campo aplicado a otros widgets cuando se selecciona una fila; El valor predeterminado es la primera columna visible.',
  gridSetupGroupByLabel: 'Agrupar por',
  gridSetupGroupByHelper:
    'Contraer filas en grupos: establezca la agregación por columna a continuación',
  gridSetupDefaultSortLabel: 'Orden predeterminado',
  gridSetupHeightLabel: 'Altura (píxeles)',
  gridSetupConditionalFormattingTitle: 'Formato condicional',
  gridSetupConditionalCustom: 'Costumbre',
  gridSetupRemoveRuleAriaLabel: 'Eliminar regla',
  gridSetupInteractionsTitle: 'Interacciones',
  gridSetupInteractionsDescription: 'Cuando se hace clic en otros widgets, esta tabla...',
  gridSetupChooseSourceHelper: 'Elija una fuente de datos para configurar las columnas',
  gridSetupNoSourceAlert:
    'Seleccione una fuente de datos arriba para configurar las columnas y los ajustes de esta tabla.',
  gridSetupColumnsTitle: 'columnas',
  gridSetupColumnOptionsAriaLabel: (label) => `Opciones de ${label}`,
  gridSetupColumnGroupLabel: '(grupo)',
  gridSetupColumnRemove: 'Eliminar',
  gridSetupColumnAggNone: 'Ninguno',
  gridSetupColumnAggUnique: 'Soltero',
  gridSetupColumnAggSummaryTooltip: 'Establecer resumen/eliminar',
  gridSetupColumnAggLabel: (isGroupBy, aggLabel) =>
    `${isGroupBy ? 'Agregación' : 'Resumen'}: ${aggLabel}`,
  gridSetupColumnSetAggTooltip: 'Definir agregación',
  gridSetupAddColumn: 'Agregar columna',
  gridSetupCalculatedColumn: 'Columna calculada...',
  gridSetupAddRule: 'Agregar regla',
  gridSetupCFContains: 'contiene',
  gridSetupCFIsEmpty: 'esta vacio',
  gridSetupCFNotEmpty: 'no esta vacio',
  gridSetupCFStyleRed: 'Rojo',
  gridSetupCFStyleGreen: 'Verde',
  gridSetupCFStyleYellow: 'Amarillo',
  gridSetupCFStyleBlue: 'Azul',
  gridSetupCFStyleBold: 'Atrevido',
  gridSetupMeasuresSubheader: 'Medidas',
  gridSetupMeasureNotColumnHelper:
    'Las medidas agregan todo el conjunto de datos, por lo que no tienen un valor por fila y no pueden ser columnas de la tabla. Úselas en un KPI o en un gráfico.',
  gridSetupCFValuePlaceholder: 'valor',

  // Map setup panel
  mapSetupMapTypeLabel: 'Tipo de mapa',
  mapSetupValueFieldLabel: 'Campo de valor (opcional para contar)',
  mapSetupColourSchemeLabel: 'esquema de color',
  mapSetupLegendPositionLabel: 'Posición del título',
  mapSetupScaleFromZeroLabel: 'Escalar desde cero',
  mapSetupClickableLabel: 'Se puede hacer clic (fuente de filtro)',
  mapSetupColorBlues: 'Azul',
  mapSetupColorReds: 'rojos',
  mapSetupColorGreens: 'Verduras',
  mapSetupColorOranges: 'naranjas',
  mapSetupColorPurples: 'morados',
  mapSetupLegendBottom: 'Abajo',
  mapSetupLegendTop: 'Más alto',
  mapSetupLegendLeft: 'Izquierda',
  mapSetupLegendRight: 'Bien',
  mapSetupLegendHidden: 'Ninguna',
  mapSetupLegendAlignLabel: 'Alineación de leyenda',
  mapSetupLegendAlignStart: 'Arriba',
  mapSetupLegendAlignCenter: 'Centro',
  mapSetupLegendAlignEnd: 'Abajo',
  mapFormatLegendAlignLeft: 'Izquierda',
  mapFormatLegendAlignRight: 'Derecha',
  mapSetupRegionFieldLabel: 'Campo de región',
  mapSetupRegionFieldHelperText:
    'Un campo que contiene identificadores de región correspondientes a ID de recursos geográficos.',
  mapSetupCountryFieldLabel: 'Campo de país',
  mapSetupCountryFieldHelperText:
    'Un campo que contiene códigos ISO alfa-2, alfa-3 o nombres completos de países.',
  mapSetupStateFieldLabel: 'Campo de estado',
  mapSetupStateFieldHelperText:
    'Un campo que contiene nombres de estados de EE. UU. o abreviaturas postales de 2 letras.',
  mapSetupUnreachableFieldWarning:
    'Este campo no proviene de la fuente del widget ni de una fuente directamente relacionada, por lo que no se puede resolver y el mapa se mostrará en blanco.',

  // Pivot setup panel
  pivotSetupDescription:
    'Cree una tabla cruzada eligiendo un campo de fila, un campo de columna y una medida de valor.',
  pivotSetupRowFieldLabel: 'Campo de línea',
  pivotSetupRowFieldHelper: 'Campo categórico mostrado como grupos de líneas a la izquierda',
  pivotSetupColFieldLabel: 'Campo de columna',
  pivotSetupColFieldHelper: 'Campo categórico distribuido en encabezados de columna',
  pivotSetupValueFieldLabel: 'Campo de valor',
  pivotSetupValueFieldHelper: 'Campo numérico agregado en cada celda',
  pivotSetupShowTotals: 'Mostrar totales fila y columna',
  pivotSetupAggregationLabel: 'Agregación',

  // Inline formula bar
  inlineFormulaBarAddTooltip: 'Agregar campo de fórmula calculada',
  inlineFormulaBarCloseAriaLabel: 'Cerrar barra de fórmulas',
  inlineFormulaBarLabelLabel: 'Etiqueta',
  inlineFormulaBarAutoHelperText:
    'Generado automáticamente a partir de la fórmula: edítelo para personalizarlo',
  inlineFormulaBarCancelButton: 'Cancelar',
  inlineFormulaBarAddButton: 'para agregar',
  inlineFormulaBarFieldOperandLabel: 'Campo',
  inlineFormulaBarNumberOperandLabel: 'Número',
  inlineFormulaBarOperandTypeAriaLabel: (label) => `tipo de ${label}`,
  inlineFormulaBarButtonLabel: 'Fórmula',
  inlineFormulaBarOperandALabel: 'EL',
  inlineFormulaBarOperandBLabel: 'B',

  // Field detail view
  fieldDetailRowSourceId: 'ID de fuente',
  fieldDetailRowName: 'Nombre',
  fieldDetailRowDescription: 'Descripción',
  fieldDetailRowDataType: 'tipo de datos',
  fieldDetailRowCalculationType: 'Tipo de cálculo',
  fieldDetailRowNoCalculation: 'Sin cálculo',
  fieldDetailRowFormat: 'Formato',
  fieldDetailNumberFormatLabel: 'formato numérico',
  fieldDetailNumberFormatDefault: 'Estándar',
  fieldDetailFormatInteger: 'Entero',
  fieldDetailFormatDecimal: 'Decimal',
  fieldDetailFormatPercent: 'Porcentaje',
  fieldDetailFormatCurrency: 'Acuñar',

  // Filters drawer
  filtersDrawerRenameViewTooltip: 'Cambiar nombre de vista',
  filtersSectionWidgetTitle: (title) => `Widget: ${title}`,
  filtersRenameViewAriaLabel: 'Cambiar el nombre de la vista guardada',
  filtersRenameViewButtonAriaLabel: (name) => `Cambiar nombre de la vista "${name}"`,
  filtersDeleteViewAriaLabel: (name) => `Eliminar la vista "${name}"`,

  // Filter setup panel
  filterSetupControlTypeLabel: 'Tipo de control',
  filterSetupMultiSelect: 'Selección múltiple',
  filterSetupMultiSelectDescription:
    'Menú desplegable con casillas de verificación para valores categóricos',
  filterSetupToggleChips: 'Alternar fichas',
  filterSetupToggleChipsDescription: 'Botones de chip en línea para valores categóricos',
  filterSetupDateRange: 'Rango de fechas',
  filterSetupDateRangeDescription: 'Selectores de fecha de inicio y finalización.',
  filterSetupSlider: 'control deslizante',
  filterSetupSliderDescription: 'Control deslizante de rango para campos numéricos o de fecha',
  filterSetupMinLabel: 'Mín.',
  filterSetupMaxLabel: 'Máx.',
  filterSetupStepLabel: 'Paso',
  filterSetupSelectFieldAlert: 'Seleccione un campo para configurar el control de filtro.',
  filterSetupSliderRangeHelperText:
    'Rango del control deslizante (deje en blanco para detectar automáticamente a partir de los datos)',
  filterSetupMinAboveMaxError:
    'Mín. debe ser menor que Máx. — de lo contrario, el widget los intercambia.',
  filterSetupStepNotPositiveError:
    'El paso debe ser mayor que 0 — de lo contrario, el widget lo ignora.',
  filterSetupStepExceedsRangeError: 'El paso es mayor que el rango entre Mín. y Máx.',

  // Text setup panel
  textSetupTitleLabel: 'Título',
  textSetupTitleHelper: 'Encabezado mostrado en la parte superior del widget',
  textSetupSubtitleLabel: 'Subtítulo',
  textSetupSubtitleHelper: 'Texto más pequeño debajo del encabezado',
  textSetupBodyLabel: 'Cuerpo',
  textSetupBodyHelper: 'Contenido principal del widget; soporta texto plano',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Limpiar filtro',
  filterWidgetSelectAllLabel: 'Seleccionar todo',
  filterWidgetClearAllLabel: 'Borrar todo',
  filterWidgetAllLabel: 'Todo',
  filterWidgetNoOptionsLabel: 'No se encontraron opciones',
  filterWidgetNoSearchMatchesLabel: 'Sin coincidencias',
  filterRankConflictMessage:
    'Solo se permite un filtro Top-N o Bottom-N por página. Elimina primero el existente.',
  filterWidgetSelectedCount: (count) => `${count} seleccionado${count === 1 ? '' : 's'}`,
  filterWidgetExcludeLabel: 'Eliminar seleccionado',
  filterWidgetExcludingLabel: '⊘ Eliminando seleccionado',
  filterWidgetDateFromLabel: 'De',
  filterWidgetDateToLabel: 'Hasta',
  filterWidgetNoFieldConfigured:
    'No hay campos configurados. Seleccione un campo en el panel Redactar.',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Borrar campo',
  dataSourceAddCalculatedField: 'Agregar campo calculado…',
  dataSourceFieldUnavailableOption: (fieldId) => `${fieldId} (no disponible)`,
  dataSourceFieldUnavailableHelperText: (fieldId) =>
    `«${fieldId}» ya no está disponible en los datos. Elija otro campo.`,
  dataSourceFieldUnavailableGroupLabel: 'No disponible',

  // Widget filter row
  widgetFilterFieldHelperText: 'Campo al que se aplica este filtro',
  drawerPanelOpenAriaLabel: (title) => `Abrir panel ${title}`,
  drawerPanelCloseNamedAriaLabel: (title) => `Cerrar panel ${title}`,
  sidebarPanelToggleAriaLabel: (isActive, label) =>
    isActive ? `Cerrar panel ${label}` : `Abrir panel ${label}`,
  addWidgetGroupAriaLabel: (groupLabel) => `Widgets de ${groupLabel}`,
  addWidgetSelectAriaLabel: (label) => `Seleccionar widget: ${label}`,
  formatPanelNoSubtitlePlaceholder: 'Sin subtítulos',

  // Widget filters panel
  widgetFiltersPanelNoSource: 'Este widget no tiene fuente de datos.',
  widgetFiltersPanelDescription:
    'Condiciones permanentes aplicadas a los datos de este widget antes de cualquier filtro interactivo.',
  widgetFiltersPanelNoFilters: 'Sin filtros, se muestran todos los datos.',
  widgetFiltersPanelAddButton: 'Agregar filtro',

  // Expression field preview
  expressionPreviewMeasureLabel: (count) =>
    `Vista previa (medida en ${count.toLocaleString('es')} filas)`,
  expressionPreviewFirstRowsLabel: (count) =>
    `Vista previa (primeras ${count.toLocaleString('es')} filas)`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} fila${count === 1 ? '' : 's'} no mostrada${count === 1 ? '' : 's'}: aumenta la altura del widget para verlas todas`,

  // Color input
  colorInputClearAriaLabel: (label) => `Borrar ${label.toLowerCase()}`,
  colorInputPickerAriaLabel: (label) => `Selector de color de ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'Nuevo',
  kpiTrendTargetTooltip: (value) => `Objetivo: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Período anterior: ${period}`,
  kpiTrendVsLabel: (period) => `vs. ${period}`,
  kpiTrendNoDateFilterHint: 'Agregue un filtro de fecha para mostrar la tendencia.',
  kpiSparklineNoTimeFieldHint:
    'Agregue un filtro de fecha o seleccione un campo de hora para mostrar el minigráfico.',

  // Chart widget
  chartMixedRequiresFieldsHint: 'El gráfico mixto requiere 2 o más campos de medida.',
  chartDefaultSeriesLabel: 'Valor',
  chartEmptyCategoryLabel: '(vacío)',
  chartOtherBucketLabel: 'Otro',
  chartHeatmapRequiresFieldsHint:
    'El mapa de calor requiere campos de eje de columnas, eje de filas y valor.',
  chartFunnelRequiresFieldsHint:
    'El gráfico de embudo requiere un campo de etapa y un campo de valor.',
  chartSankeyRequiresFieldsHint:
    'El diagrama de Sankey requiere campos de origen, destino y valor.',
  chartGanttRequiresFieldsHint:
    'El diagrama de Gantt requiere un campo de etiqueta, un campo de fecha de inicio y uno de fecha de fin.',
  chartGanttDurationLabel: 'Duración:',
  chartGanttDurationDays: (days) => `${days} d`,
  chartGanttDurationHours: (hours) => `${hours} h`,
  chartCrossFilterFilteredOutLabel: 'filtrado',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Usa la pestaña Configurar para elegir un ${fieldLabel.toLowerCase()} y un campo de valor.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'Encabezado de fila/columna',
  pivotBlankValueLabel: '(blanco)',
  pivotTotalLabel: 'Total',

  // Expression dialog
  exprDialogEditTitle: 'Editar campo calculado',
  exprDialogNewTitle: 'Nuevo campo calculado',

  // Expression field — measure checkbox
  exprMeasureLabel: 'Medida (agregación)',
  exprMeasureHelperText:
    'Calcula un valor único sobre todo el conjunto de datos (por ejemplo, ingresos totales).',
  exprDimensionHelperText: 'Calcule un valor por línea (por ejemplo: precio × cantidad).',

  // Chart color scheme options
  chartColorSchemePrimary: 'Primario (azul)',
  chartColorSchemeSuccess: 'Éxito (verde)',
  chartColorSchemeWarning: 'Atención (naranja)',
  chartColorSchemeError: 'Error (rojo)',

  // AI chat suggestions
  aiSuggestionBarChart: (numericLabel, catLabel) =>
    `Gráfico de barras: ${numericLabel} por ${catLabel}`,
  aiSuggestionKpi: (fieldLabel) => `KPI: total de ${fieldLabel}`,
  aiSuggestionTable: (sourceLabel) => `Tabla de ${sourceLabel}`,
  aiSuggestionChangeToLine: (widgetTitle) => `Cambiar «${widgetTitle}» a gráfico de líneas`,
  aiSuggestionAddSparkline: (widgetTitle) => `Agregar sparkline a «${widgetTitle}»`,
  aiSuggestionAddDateFilter: 'Agregar filtro de fecha',
  aiSuggestionAddPage: 'Agregar nueva página',
  aiSuggestionSummarisePage: 'Resumir la página',
  aiSuggestionWhatDataAvailable: '¿Qué datos están disponibles?',
  aiSuggestionBarChartPrompt: (numericLabel, catLabel, sourceLabel) =>
    `Agrega un gráfico de barras que muestre ${numericLabel} por ${catLabel} a partir de los datos de ${sourceLabel}.`,
  aiSuggestionKpiPrompt: (fieldLabel, sourceLabel) =>
    `Agrega una tarjeta KPI que muestre el total de ${fieldLabel} de ${sourceLabel}.`,
  aiSuggestionTablePrompt: (sourceLabel) =>
    `Agrega una tabla de datos que muestre los registros de ${sourceLabel}.`,
  aiSuggestionChangeToLinePrompt: (widgetTitle) =>
    `Cambia el widget «${widgetTitle}» a un gráfico de líneas.`,
  aiSuggestionAddSparklinePrompt: (widgetTitle) =>
    `Agrega una sparkline al widget KPI «${widgetTitle}».`,
  aiSuggestionAddDateFilterPrompt: 'Agrega un widget de filtro de rango de fechas al panel.',
  aiSuggestionAddPagePrompt: 'Crea una nueva página del panel.',
  aiSuggestionSummarisePagePrompt:
    'Dame un resumen ejecutivo de los principales hallazgos de esta página — céntrate en los datos, las tendencias y cualquier anomalía en lugar de en la estructura de la página.',
  aiSuggestionWhatDataAvailablePrompt:
    '¿Qué fuentes de datos y campos están disponibles para construir este panel?',
  chatNewConversationName: 'Nueva conversación',
  chatSwitchConversationTooltip: 'Cambiar conversación',
  chatNoConversationsLabel: 'Aún no hay conversaciones',
  aiInsightSummaryPrompt: (widgetTitle) =>
    `Dame un resumen general del widget «${widgetTitle}» en 2 o 3 frases — qué muestra y la conclusión más importante. Sé breve, sin viñetas.`,
  aiInsightAnalysisPrompt: (widgetTitle) =>
    `Analiza el widget «${widgetTitle}» — identifica las tendencias clave, los patrones y los valores destacados`,
  aiInsightForecastPrompt: (widgetTitle) =>
    `Haz una previsión del widget «${widgetTitle}» — ¿qué tendencia esperas en los próximos periodos?`,
  aiInsightCorrelationPrompt: (widgetTitle) =>
    `Muestra un análisis de correlación para el widget «${widgetTitle}»`,
  aiAnomalyExplainPrivatePrompt: (widgetTitle, count) =>
    `Explica ${count === 1 ? 'la anomalía detectada' : `las ${count} anomalías detectadas`} en el widget «${widgetTitle}». Los valores de los datos subyacentes están ocultos (modo privado); razona sobre las causas probables en términos generales.`,
  aiAnomalyExplainPrompt: (widgetTitle, details) =>
    `Explica las anomalías detectadas en el widget «${widgetTitle}»:\n${details}`,
  aiAnomalyDetailLine: (axisLabel, value, annotationLabel) =>
    `- Anomalía del ${axisLabel} en ${value}${annotationLabel ? ` (${annotationLabel})` : ''}`,
  aiAnomalyAxisX: 'eje X',
  aiAnomalyAxisY: 'eje Y',
  chatUserDisplayName: 'Usted',
  chatComposerPlaceholder: '¿Cómo puedo ayudar?',
  chatEmptyStateTitle: 'Pregúnteme lo que quiera sobre su panel',
  chatEmptyStateSubtitle: 'Puedo añadir widgets, analizar sus datos y más',
  chatVoiceInputStart: 'Iniciar entrada de voz',
  chatVoiceInputStop: 'Detener la entrada de voz',
  chatMessageCopyTooltip: 'Copiar',
  chatMessageCopiedTooltip: '\u00a1Copiado!',
  chatMessageCopyAriaLabel: 'Copiar mensaje',
  chatMessageRetryTooltip: 'Reintentar',
  chatReasoningThinkingLabel: 'Pensando…',
  chatReasoningSectionLabel: 'Razonamiento',
  chatComposerStopGeneratingLabel: 'Detener generación',
  chatComposerSendMessageLabel: 'Enviar mensaje',
  chatMessageTokenCount: (count) =>
    `${count.toLocaleString('es')} ${count === 1 ? 'token' : 'tokens'}`,
  chatMessageTurnCount: (count) => `${count} ${count === 1 ? 'turno' : 'turnos'}`,

  // AI chat tool-call card titles
  chatToolLabelGetDashboardState: 'Obtener estado del panel',
  chatToolLabelListPages: 'Listar páginas',
  chatToolLabelSetDashboardTitle: 'Establecer título del panel',
  chatToolLabelAddPage: 'Añadir página',
  chatToolLabelRenamePage: 'Renombrar página',
  chatToolLabelRemovePage: 'Eliminar página',
  chatToolLabelSetActivePage: 'Cambiar de página',
  chatToolLabelAddWidget: 'Añadir widget',
  chatToolLabelUpdateWidget: 'Actualizar widget',
  chatToolLabelRemoveWidget: 'Eliminar widget',
  chatToolLabelSetWidgetLayout: 'Establecer diseño del widget',
  chatToolLabelSetWidgetWidth: 'Establecer ancho del widget',
  chatToolLabelSetWidgetForecast: 'Establecer previsión del widget',
  chatToolLabelAddPageFilter: 'Añadir filtro de página',
  chatToolLabelRemovePageFilter: 'Eliminar filtro de página',
  chatToolLabelAddWidgetFilter: 'Añadir filtro de widget',
  chatToolLabelRemoveWidgetFilter: 'Eliminar filtro de widget',
  chatToolLabelSummarisePage: 'Resumir página',
  chatToolLabelApplyBulkUpdate: 'Aplicar actualización masiva',
  chatToolLabelRenameThread: 'Renombrar conversación',
  chatToolLabelQueryDataSource: 'Consultar fuente de datos',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Esta configuración de gráfico utiliza campos que no están disponibles en la fuente del widget o en una fuente directamente relacionada.',
  chartUnsupportedMixedCrossSource:
    'Esta configuración de gráfico mezcla campos de diferentes fuentes de una manera que aún no tiene un único grano de agregación seguro.',
  chartUnsupportedScatterCrossSource:
    'Los diagramas de dispersión aún no admiten combinaciones de campos entre fuentes.',
  chartUnsupportedMeasure:
    'Un campo de medida no tiene valor por fila, por lo que solo puede usarse como valor de un gráfico —nunca como eje de categorías, división, color o tamaño— y no puede usarse en absoluto en gráficos de dispersión ni de Gantt, que dibujan una marca por cada fila sin agregar.',
  chartUnsupportedDefault: 'Esta configuración de gráfico aún no es compatible.',
  chartForecastSeriesLabel: 'Pronóstico',

  // Grid summary labels
  gridSummaryLabelSum: 'Total:',
  gridSummaryLabelAvg: 'Promedio:',
  gridSummaryLabelCount: 'Recuento:',
  gridSummaryLabelCountDistinct: 'Único:',
  gridSummaryLabelCountValues: 'Valores:',
  gridSummaryLabelMin: 'Mín.:',
  gridSummaryLabelMax: 'Máximo:',
  gridMutationError: 'Error al guardar los cambios',

  // Auto-generated widget titles
  widgetAutoTitleChart: 'Gráfico',
  widgetAutoTitleKpi: 'KPI',
  widgetAutoTitleTable: 'Tabla',
  widgetAutoTitleFilter: 'Filtrar',
  widgetAutoTitlePivot: 'mesa pivote',
  widgetAutoTitleMap: 'Mapa',
  widgetAutoTitleDefault: 'widget',
  widgetAutoTitleVs: 'vs',
  widgetAutoTitleBy: 'poner',
  widgetAutoTitleSplitBy: 'dividido por',
  widgetAutoTitleByCountry: 'por pais',
  widgetAutoTitleSourceSuffixChart: 'gráfico',
  widgetAutoTitleSourceSuffixKpi: 'KPI',
  widgetAutoTitleSourceSuffixPivot: 'dinámica',
  widgetAutoTitleSourceSuffixMap: 'mapa',
  widgetAutoTitleFilterPrefix: 'Filtrar',
  widgetAggPrefixSum: 'Total de',
  widgetAggPrefixAvg: 'Promedio de',
  widgetAggPrefixCount: 'recuento de',
  widgetAggPrefixMin: 'Mín.',
  widgetAggPrefixMax: 'Máx.',
  widgetAggPrefixCountDistinct: 'Distinto de',
  widgetAggPrefixCountValues: 'Recuento de valores de',
  widgetGroupByPrefixDay: 'A diario',
  widgetGroupByPrefixWeek: 'Semanalmente',
  widgetGroupByPrefixMonth: 'Mensual',
  widgetGroupByPrefixQuarter: 'Trimestral',
  widgetGroupByPrefixYear: 'Anual',
  widgetAutoTitleMoreFields: (count) => `+${count} más`,

  // Date filter labels
  dateFilterLast: (amount, unit) => `Últimos ${amount} ${unit}`,
  dateFilterNext: (amount, unit) => `Próximos ${amount} ${unit}`,
  dateFilterFrom: (date) => `Desde ${date}`,
  dateFilterUpTo: (label) => `Hasta ${label}`,
  dateFilterSince: (date) => `Desde ${date}`,
  dateFilterUntil: (date) => `Hasta ${date}`,
  dateFilterUnitYear: 'año',
  dateFilterUnitYears: 'años',
  dateFilterUnitMonth: 'mes',
  dateFilterUnitMonths: 'meses',
  dateFilterUnitWeek: 'semana',
  dateFilterUnitWeeks: 'semanas',
  dateFilterUnitDay: 'día',
  dateFilterUnitDays: 'días',
  dateFilterUnitHour: 'tiempo',
  dateFilterUnitHours: 'horas',
  dateFilterUnitMinute: 'minuto',
  dateFilterUnitMinutes: 'minutos',
  dateFilterUnitSecond: 'segundo',
  dateFilterUnitSeconds: 'segundos',

  // Widget delete confirmation dialog
  widgetDeleteConfirmTitle: '\u00bfEliminar widget?',
  widgetDeleteConfirmMessage: 'Este widget se eliminará permanentemente de la página.',
  widgetDeleteConfirmOk: 'Eliminar',
  widgetDeleteConfirmCancel: 'Cancelar',

  // Canvas empty state
  canvasEmptyTitle: 'El lienzo está vacío',
  canvasEmptyEditModeHint: 'Use el panel Componer para añadir widgets o arrástrelos aquí.',
  canvasEmptyViewModeHint: 'Cambie al modo de edición para añadir widgets.',

  // Map widget legend
  mapLegendAriaLabel: (fieldLabel, min, max) =>
    `Escala de colores de ${fieldLabel} de ${min} a ${max}`,

  // Date range presets (calendar year / quarter)
  dateRangePresetThisCalendarYear: 'Este año',
  dateRangePresetLastCalendarYear: 'Año pasado',
  dateRangePresetLast2CalendarYears: 'Últimos 2 años',
  dateRangePresetThisQuarter: 'Este trimestre',
  dateRangePresetLastQuarter: 'Trimestre pasado',
  dateRangePresetThisAndLastQuarter: 'Este trimestre y el anterior',
  dateRangePresetCustom: 'Personalizado',
  dateRangePresetGroupRolling: 'Móvil',
  dateRangePresetGroupCalendarYear: 'Año calendario',
  dateRangePresetGroupQuarter: 'Trimestre',

  // Filters drawer (default view)
  filtersDefaultViewLabel: 'Vista predeterminada',

  // Quick filter bar
  quickFilterBarEnableFilter: 'Activar filtro',
  quickFilterBarDisableFilter: 'Desactivar filtro',
  quickFilterBarRemoveFilter: 'Eliminar filtro',

  // Cross-filter mode bar
  crossFilterBarModeFilter: 'Filtro',
  crossFilterBarModeHighlight: 'Resaltar',
  crossFilterBarModePerChart: 'Por gráfico',
  crossFilterBarAllPages: 'Todas las páginas',

  // Chart setup panel
  aggregationLockedHelperText: 'Cuenta filas — elija un campo de valor para sumar, promediar, etc.',

  // Funnel setup
  chartSetupFunnelLabelFormatLabel: 'Formato de etiqueta',
  chartSetupFunnelLabelFormatValue: 'Valor',
  chartSetupFunnelLabelFormatPercent: '% del total',
  chartSetupFunnelLabelFormatConversion: 'Tasa de conversión',
  chartSetupFunnelLabelPlacementLabel: 'Posición de la etiqueta',
  chartSetupFunnelLabelPlacementInside: 'Interior',
  chartSetupFunnelLabelPlacementOutsideStart: 'Exterior izquierda',
  chartSetupFunnelLabelPlacementOutsideEnd: 'Exterior derecha',
  chartSetupFunnelGapLabel: 'Espaciado entre secciones (px)',
  chartSetupFunnelShapeLabel: 'Forma',
  chartSetupFunnelShapeLinear: 'Lineal',
  chartSetupFunnelShapeBump: 'Curva (bump)',
  chartSetupFunnelShapeStep: 'Escalón',
  chartSetupFunnelShapePyramid: 'Pirámide',
  chartSetupFunnelStyleLabel: 'Estilo',
  chartSetupFunnelStyleFilled: 'Relleno',
  chartSetupFunnelStyleOutlined: 'Contorno',

  // Sankey setup
  chartSetupSankeySourceLabel: 'Campo de origen (desde)',
  chartSetupSankeySourceHelperText: 'Campo categórico para el nodo de inicio de cada flujo',
  chartSetupSankeyTargetLabel: 'Campo de destino (hacia)',
  chartSetupSankeyTargetHelperText: 'Campo categórico para el nodo final de cada flujo',
  chartSetupSankeyValueHelperText: 'Campo numérico sumado por enlace origen → destino',
  chartSetupSankeyLinkColorLabel: 'Color del enlace',
  chartSetupSankeyLinkColorSource: 'Desde el nodo de origen',
  chartSetupSankeyLinkColorTarget: 'Desde el nodo de destino',
  chartSetupSankeyShowValuesLabel: 'Mostrar valores en los enlaces',

  // Pie/donut & funnel category fields
  chartSetupXFieldPieDonutLabel: 'Categoría de porción',
  chartSetupXFieldPieDonutHelperText: 'Cada valor único se convierte en una porción',
  chartSetupXFieldFunnelLabel: 'Campo de etapa',
  chartSetupXFieldFunnelHelperText: 'Campo categórico que define cada etapa del embudo',
  chartSetupYMeasurePieDonutLabel: 'Valor de la porción',
  chartSetupFieldlessCountSplitByTooltip: 'Elija un campo de medida para habilitar la división por',
  chartSetupSplitByFieldlessCountHelperText:
    'No disponible para un conteo sin campo — elija primero un campo de medida',

  // KPI setup panel
  kpiSetupDateRangePresetLabel: 'Rango',

  // Map setup panel
  mapSetupValueFieldHelperText: 'Deje vacío para contar filas',
  mapSetupInteractionsTitle: 'Interacciones',
  mapSetupInteractionsDescription: 'Cuando se hace clic en otros widgets, este mapa…',

  // Text setup panel
  textSetupPromptLabel: 'Instrucción',
  textSetupPromptHelper:
    'Describa lo que la IA debe escribir — puede consultar las fuentes de datos de esta página',
  textSetupAiModeLabel: 'Modo IA',

  // Accessible names for otherwise-unlabeled form controls
  exprNodeKindAriaLabel: 'Tipo de entrada',
  exprFieldAriaLabel: 'Campo',
  exprAggregationAriaLabel: 'Agregación',
  exprLiteralTypeAriaLabel: 'Tipo literal',
  exprBooleanValueAriaLabel: 'Valor booleano',
  filterRankDirectionAriaLabel: 'Dirección de clasificación',
  filterRankCountLabel: 'Número de elementos',
  filterSliderMinimumAriaLabel: (label) => `${label} mínimo`,
  filterSliderMaximumAriaLabel: (label) => `${label} máximo`,
  filterRelativeDateUnitAriaLabel: 'Unidad de tiempo',
  filterRelativeDateDirectionAriaLabel: 'Dirección',
  filterDateModeAriaLabel: 'Tipo de valor de fecha',
  formulaOperatorAriaLabel: 'Operador',
  chartAnnotationAxisAriaLabel: 'Eje de la línea de referencia',
  gridConditionFieldAriaLabel: 'Campo de condición',
  gridConditionOperatorAriaLabel: 'Operador de condición',
  gridConditionStyleAriaLabel: 'Estilo de condición',
  gridConditionValueAriaLabel: 'Valor de condición',

  // KPI trend sentiment (screen-reader only)
  kpiTrendFavorableLabel: 'favorable',
  kpiTrendUnfavorableLabel: 'desfavorable',
  kpiTrendNoChangeLabel: 'sin cambios',

  // Canvas accessibility
  canvasResizeColumnsAriaLabel: 'Cambiar tamaño de columnas',
  canvasMoveWidgetUpAriaLabel: 'Mover widget hacia arriba',
  canvasMoveWidgetDownAriaLabel: 'Mover widget hacia abajo',
  canvasMoveWidgetLeftAriaLabel: 'Mover widget hacia la izquierda',
  canvasMoveWidgetRightAriaLabel: 'Mover widget hacia la derecha',
  gridColumnMoveUpAriaLabel: 'Mover columna hacia arriba',
  gridColumnMoveDownAriaLabel: 'Mover columna hacia abajo',
  canvasRegionAriaLabel: 'Área del panel',
  sidebarPanelOpenedAnnouncement: (label) => `Panel ${label} abierto`,
  sidebarPanelClosedAnnouncement: 'Panel cerrado',
  canvasResizeAnnouncement: (span, total) => `Columna redimensionada a ${span} de ${total}`,
  canvasWidgetMovedAnnouncement: 'Widget movido',
  canvasWidgetAddedAnnouncement: 'Widget añadido',

  // Chart / KPI / map text alternatives
  ganttChartAriaLabel: (itemCount, from, to, details) =>
    `Diagrama de Gantt con ${itemCount} ${itemCount === 1 ? 'elemento' : 'elementos'} desde ${from} hasta ${to}. ${details}.`,
  ganttItemAriaLabel: (label, from, to, duration) => `${label}: de ${from} a ${to} (${duration})`,
  sankeyLinkAriaLabel: (source, target, value) => `${source} a ${target}: ${value}`,
  sankeyChartAriaLabel: (nodeCount, linkCount, details) =>
    `Diagrama de flujo Sankey con ${nodeCount} ${nodeCount === 1 ? 'nodo' : 'nodos'} y ${linkCount} ${linkCount === 1 ? 'enlace' : 'enlaces'}. ${details}.`,
  mapRegionAriaLabel: (region, valueLabel, value) => `${region}: ${valueLabel} ${value}`,
  kpiGaugeAriaLabel: (value, max, percent) => `Medidor: ${value} de ${max} (${percent} %).`,
  kpiSparklineAriaLabel: (pointCount, trend, from, to) => {
    let trendText = 'estable';
    if (trend === 'up') {
      trendText = 'en aumento';
    } else if (trend === 'down') {
      trendText = 'en descenso';
    }
    return `Sparkline con ${pointCount} puntos, ${trendText}, desde ${from} hasta ${to}.`;
  },
  mapChartAriaLabel: (measure, regionCount, min, max) =>
    `Mapa coroplético${measure ? ` de ${measure}` : ''} con ${regionCount} ${regionCount === 1 ? 'región' : 'regiones'}, valores de ${min} a ${max}.`,
  lineageGraphAriaLabel: (sourceCount, relationshipCount) =>
    `Gráfico de relaciones de datos con ${sourceCount} ${sourceCount === 1 ? 'fuente' : 'fuentes'} y ${relationshipCount} ${relationshipCount === 1 ? 'relación' : 'relaciones'}.`,
};

export const es: Localization = getStudioLocalization(esLocaleText);

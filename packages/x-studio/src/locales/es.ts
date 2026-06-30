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
  widgetConfigureMapHint:
    'Utilice la pestaña Configurar para elegir el campo de país y el campo de valor.',
  widgetNoData: 'Sin datos',
  widgetLoadError: 'No se pudieron cargar los datos',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Abrir panel de filtros',
  quickFilterBarCloseFilters: 'Cerrar panel de filtros',
  quickFilterBarClearAll: 'Borrar todos los filtros',
  quickFilterBarFiltered: 'Filtrado',
  dateRangeBarFieldLabel: 'Rango de fechas',

  // Widget card actions
  widgetEditTooltip: 'Editar widget',
  widgetExportCsvTooltip: 'Descargar como CSV',
  widgetExportPngTooltip: 'Descargar como PNG',
  widgetExpandTooltip: 'Expandir gráfico',
  widgetMoveToPageLabel: 'Mover a la página',
  widgetDuplicateTooltip: 'Duplicar widget',
  widgetDeleteTooltip: 'Eliminar widget',
  widgetAiAssistantTooltip: 'Asistente de IA',
  widgetAiInsightTooltip: 'Información de IA',
  widgetDetectAnomalyTooltip: 'Detectar anomalías',
  widgetHideAnomalyTooltip: 'Ocultar anomalías',
  widgetExplainAnomalyTooltip: 'Explicar anomalías',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Configurar',
  widgetEditDialogTabFilters: 'Filtros',
  widgetEditDialogTabFormat: 'Formato',
  widgetEditDialogCloseAriaLabel: 'Cerrar el cuadro de diálogo de edición',
  widgetUntitledLabel: (kindLabel) => `${kindLabel} sin título`,

  // AI assistant
  aiAssistantOpenTooltip: 'Abrir asistente de IA',
  aiAssistantCloseTooltip: 'Cerrar asistente de IA',
  aiCloseTooltip: 'Cerrar',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Cerrar configuración del widget',
  sidebarPanelsAriaLabel: 'Paneles laterales',

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
  composeDrawerTabSetup: 'Configurar',
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
  textFormatAlignmentLabel: 'Alineación',

  // Data drawer
  dataDrawerNoSources:
    'No hay fuentes de datos configuradas. Agregue un widget al panel para cargar datos de muestra.',
  dataDrawerViewLineage: 'Ver linaje de datos',
  dataDrawerLineageTitle: 'Linaje de datos',
  dataDrawerLineageHelper:
    'Haga clic en un nodo para ver sus datos. Haga clic en un borde para inspeccionar los campos clave de unión.',
  dataDrawerRowsLabel: 'pauta',
  dataDrawerFieldsLabel: 'campos',
  dataDrawerBackAriaLabel: 'Volver al gráfico de linaje',
  dataDrawerCloseAriaLabel: 'Cerrar linaje de datos',
  dataDrawerEditTooltip: 'Editar',
  dataDrawerDeleteTooltip: 'Borrar',
  dataDrawerViewSourceTooltip: 'Ver datos de origen',
  dataDrawerAddCalculatedField: 'Agregar campo calculado',
  dataDrawerNoData: (sourceLabel) => `No hay datos disponibles para ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} fila${count === 1 ? '' : 's'} más`,
  dataDrawerMoreColumns: (count) => `${count} columna${count === 1 ? '' : 's'} más`,
  dataDrawerViewSourceLink: 'Ver datos de origen →',
  dataDrawerMorePreviewRows: (count) => `+${count} más`,
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

  // Shared aggregation function labels
  aggFnSum: 'Suma',
  aggFnCount: 'Contar',
  aggFnCountRows: 'Contar (filas)',
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
  chartSetupCalculatedField: 'Campo calculado…',
  chartSetupCategoryFieldLabel: 'Campo de categoría',
  chartSetupRemoveSplitByTooltip:
    'Elimine campos de medidas adicionales para habilitar la división por',
  chartSetupInnerRingLabel: 'Categoría de anillo interior',
  chartSetupSplitByLabel: 'Dividir por (campo de serie)',
  chartSetupArcLabelsTitle: 'Etiquetas de arco',
  chartSetupSplitByHelperText: 'Divide los datos en una serie separada por valor',
  chartSetupSplitByDisabledHelperText: 'No disponible cuando se configuran varios campos de medida',
  chartSetupInnerRingHelperText: 'Agrega un anillo interior concéntrico agrupado por este campo.',

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
  kpiSetupCalculatedField: 'Campo calculado…',
  kpiSetupInvertColours: 'Invertir colores (cuanto más pequeño, mejor)',
  kpiSetupFixedWindowLabel: 'Trend window',
  kpiSetupFixedWindowNone: 'From date filter',
  kpiSetupFixedWindowMonth: 'Last 30 days',
  kpiSetupFixedWindowQuarter: 'Last 90 days',
  kpiSetupFixedWindowYear: 'Last 365 days',

  // KPI widget
  kpiGrandTotalTooltip:
    'Total general: los widgets de filtro activo no se aplican a este KPI. Activa el modo Filtro cruzado en la configuración de KPI para respetarlos.',
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

  // Map setup panel
  mapSetupMapTypeLabel: 'Tipo de mapa',
  mapSetupValueFieldLabel: 'Campo de valor (opcional para contar)',
  mapSetupColourSchemeLabel: 'esquema de color',
  mapSetupLegendPositionLabel: 'Posición del título',
  mapSetupScaleFromZeroLabel: 'Escalar desde cero',
  mapSetupClickableLabel: 'Se puede hacer clic (fuente de filtro)',
  mapSetupCrossFilterLabel: 'Responder a filtros cruzados',
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

  // Text setup panel
  textSetupTitleLabel: 'Título',
  textSetupTitleHelper: 'Encabezado mostrado en la parte superior del widget',
  textSetupSubtitleLabel: 'Subtítulo',
  textSetupSubtitleHelper: 'Texto más pequeño debajo del encabezado',
  textSetupBodyLabel: 'Cuerpo',
  textSetupBodyHelper: 'Contenido principal del widget; soporta texto plano',

  // Page config panel
  pageConfigPageSectionTitle: 'Página',
  pageConfigCardsSectionTitle: 'Tarjetas',
  pageConfigBackgroundColourLabel: 'Color de fondo',
  pageConfigBackgroundColourPlaceholder: 'por ejemplo: #f5f5f5',
  pageConfigCardBackgroundLabel: 'Fondo de la tarjeta',
  pageConfigCardBackgroundPlaceholder: 'por ejemplo: #ffffff',
  pageConfigPaddingLabel: 'Relleno',
  pageConfigCornerRadiusLabel: 'Radio de esquina (px)',
  pageConfigCardBorderLabel: 'Borde de la tarjeta',
  pageConfigBorderColourLabel: 'Color del borde',
  pageConfigBorderColourPlaceholder: 'por ejemplo: #e0e0e0',
  pageConfigBorderWidthLabel: 'Ancho del borde (px)',
  pageConfigPaddingNone: 'Ninguno',
  pageConfigPaddingSmall: 'Pequeño (8px)',
  pageConfigPaddingMedium: 'Medio (16 píxeles)',
  pageConfigPaddingLarge: 'Grande (24px)',

  // AI insight panel
  insightTypeSummary: 'Resumen',
  insightTypeAnalysis: 'Análisis',
  insightTypeForecast: 'Pronóstico',
  insightTypeAnomaly: 'Explicación de anomalía',
  insightTypeCorrelation: 'Análisis de correlación',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Limpiar filtro',
  filterWidgetSelectAllLabel: 'Seleccionar todo',
  filterWidgetClearAllLabel: 'Borrar todo',
  filterWidgetAllLabel: 'Todo',
  filterWidgetNoOptionsLabel: 'No se encontraron opciones',
  filterWidgetSelectedCount: (count) => `${count} seleccionado${count === 1 ? '' : 's'}`,
  filterWidgetExcludeLabel: 'Eliminar seleccionado',
  filterWidgetExcludingLabel: '⊘ Eliminando seleccionado',
  filterWidgetDateFromLabel: 'De',
  filterWidgetDateToLabel: 'Hasta',
  filterWidgetNoFieldConfigured:
    'No hay campos configurados. Seleccione un campo en el panel Redactar.',

  // Date range bar
  dateRangePresetAriaLabel: 'Rango de fechas preestablecido',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Borrar campo',
  dataSourceAddCalculatedField: 'Agregar campo calculado…',

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

  // Pivot widget
  pivotRowsColumnsLabel: (rowCount, colCount) => `${rowCount} filas × ${colCount} columnas`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} fila${count === 1 ? '' : 's'} no mostrada${count === 1 ? '' : 's'}: aumenta la altura del widget para verlas todas`,

  // Color input
  colorInputClearAriaLabel: (label) => `Borrar ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'Nuevo',
  kpiTrendTargetTooltip: (value) => `Objetivo: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Período anterior: ${period}`,
  kpiTrendNoDateFilterHint: 'Agregue un filtro de fecha para mostrar la tendencia.',
  kpiSparklineNoTimeFieldHint:
    'Agregue un filtro de fecha o seleccione un campo de hora para mostrar el minigráfico.',

  // Chart widget
  chartMixedRequiresFieldsHint: 'El gráfico mixto requiere 2 o más campos de medida.',
  chartDefaultSeriesLabel: 'Valor',

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
  chatNewConversationName: 'Nueva conversación',
  chatSwitchConversationTooltip: 'Cambiar conversación',
  chatVoiceInputStart: 'Iniciar entrada de voz',
  chatVoiceInputStop: 'Detener la entrada de voz',
  chatVoiceInputNotSupported: 'La entrada de voz no es compatible con este navegador',
  chatMessageCopyTooltip: 'Copiar',
  chatMessageCopiedTooltip: '\u00a1Copiado!',
  chatMessageCopyAriaLabel: 'Copiar mensaje',
  chatMessageRetryTooltip: 'Reintentar',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Esta configuración de gráfico utiliza campos que no están disponibles en la fuente del widget o en una fuente directamente relacionada.',
  chartUnsupportedMixedCrossSource:
    'Esta configuración de gráfico mezcla campos de diferentes fuentes de una manera que aún no tiene un único grano de agregación seguro.',
  chartUnsupportedScatterCrossSource:
    'Los diagramas de dispersión aún no admiten combinaciones de campos entre fuentes.',
  chartUnsupportedDefault: 'Esta configuración de gráfico aún no es compatible.',
  chartForecastSeriesLabel: 'Pronóstico',

  // Grid summary labels
  gridSummaryLabelSum: 'Total:',
  gridSummaryLabelAvg: 'Promedio:',
  gridSummaryLabelCount: 'Contar:',
  gridSummaryLabelCountDistinct: 'Único:',
  gridSummaryLabelMin: 'Mín.:',
  gridSummaryLabelMax: 'Máximo:',

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
};

export const es: Localization = getStudioLocalization(esLocaleText);

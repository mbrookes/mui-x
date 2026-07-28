import type { StudioLocaleText } from '../internals/StudioUIConfigContext';
import { getStudioLocalization, type Localization } from './utils/getStudioLocalization';

/**
 * German (de) locale text for Studio.
 *
 * @example
 * ```tsx
 * import { deLocaleText } from '@mui/x-studio';
 * <Studio localeText={deLocaleText} />
 * ```
 */
export const deLocaleText: Partial<StudioLocaleText> = {
  // Drawers
  dataDrawerTitle: 'Daten',
  composeDrawerTitle: 'Erstellen',
  filtersDrawerTitle: 'Filter',

  // Date range presets
  dateRangePresetAllTime: 'Gesamter Zeitraum',
  dateRangePresetYTD: 'Aktuelles Jahr',
  dateRangePresetThisMonth: 'Diesen Monat',
  dateRangePresetLast3Months: 'Letzte 3 Monate',
  dateRangePresetLast12Months: 'Letzte 12 Monate',

  // Filters drawer
  filterSearchPlaceholder: 'Filter suchen…',
  filtersSectionPageFiltersTitle: 'Seitenfilter',
  filtersSectionNoFilters: 'Keine Filter angewendet.',
  filtersSectionNoMatchingFilters: 'Keine passenden Filter.',
  filtersAddFilterTooltip: 'Filter hinzufügen',
  filtersSavedViewsTitle: 'Gespeicherte Ansichten',
  filtersSaveViewTooltip: 'Seitenfilter als benannte Ansicht speichern',
  filtersSaveViewButton: 'Speichern',
  filtersSaveViewPlaceholder: 'Ansichtsname',
  filtersDeleteViewTooltip: 'Ansicht löschen',
  filtersNoSavedViews: 'Keine Ansichten gespeichert. Filter anwenden und hier speichern.',
  filtersAddDataSourceHint: 'Fügen Sie zunächst eine Datenquelle und Widgets hinzu.',

  // Widget states
  widgetConfigureChartHint:
    'Verwenden Sie die Registerkarte „Konfigurieren“, um dieses Diagramm zu konfigurieren.',
  widgetConfigureGaugeHint:
    'Verwenden Sie die Registerkarte „Konfigurieren“, um das Zählerwertfeld auszuwählen.',
  widgetConfigurePivotHint:
    'Verwenden Sie die Registerkarte „Konfigurieren“, um die Pivot-Tabelle zu konfigurieren.',
  widgetNoData: 'Keine Daten',
  widgetLoadError: 'Daten konnten nicht geladen werden',
  mapGeographyLoadError: 'Kartendaten konnten nicht geladen werden. Bitte versuchen Sie es erneut.',
  widgetLoadingLabel: 'Wird geladen',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Filterbereich öffnen',
  quickFilterBarClearAll: 'Alle Filter löschen',
  dateRangeBarFieldLabel: 'Datumsbereich',

  // Widget card actions
  widgetEditTooltip: 'Widget bearbeiten',
  widgetExportCsvTooltip: 'Download als CSV',
  widgetExportPngTooltip: 'Download als PNG',
  widgetExportNoDataMessage:
    'Es sind noch keine Daten zum Exportieren verfügbar. Öffnen Sie das Raster, damit es Daten vom Server laden kann, und versuchen Sie den Export erneut.',
  widgetExportUnavailableMessage:
    'Dieses Widget kann nichts exportieren. Schließen Sie die Konfiguration ab – eine Tabelle benötigt eine Datenquelle, eine Pivot-Tabelle Zeilen, Spalten und Werte – und versuchen Sie es dann erneut.',
  widgetExpandTooltip: 'Widget erweitern',
  widgetMoveToPageLabel: 'Auf Seite verschieben',
  widgetDuplicateTooltip: 'Widget duplizieren',
  widgetDeleteTooltip: 'Widget löschen',
  widgetAiAssistantTooltip: 'KI-Assistent',
  widgetAiInsightTooltip: 'KI-Einblick',
  widgetAiRefreshTooltip: 'KI-Inhalt aktualisieren',
  widgetInsightTypeSummary: 'Zusammenfassung',
  widgetInsightTypeAnalysis: 'Analyse',
  widgetInsightTypeForecast: 'Prognose',
  widgetDetectAnomalyTooltip: 'Anomalien erkennen',
  widgetHideAnomalyTooltip: 'Anomalien verbergen',
  widgetExplainAnomalyTooltip: 'Erklären Sie Anomalien',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Konfigurieren',
  widgetEditDialogTabFilters: 'Filter',
  widgetEditDialogTabFormat: 'Format',
  widgetEditDialogCloseAriaLabel: 'Bearbeitungsdialog schließen',
  widgetUntitledLabel: (kindLabel) => `${kindLabel} ohne Titel`,
  widgetEditDialogPreviewLabel: (kindLabel) => `${kindLabel}-Vorschau`,

  // AI assistant
  aiAssistantOpenTooltip: 'KI-Assistent öffnen',
  aiAssistantCloseTooltip: 'KI-Assistent schließen',
  aiAssistantPanelTitle: 'KI-Assistent',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Widget-Konfiguration schließen',
  sidebarPanelsAriaLabel: 'Seitenleistenbereiche',
  drawerPanelError: 'Beim Anzeigen dieses Bereichs ist ein Fehler aufgetreten.',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Erhöhen',
  numberFieldDecreaseAriaLabel: 'Verringern',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Erweitertes Diagramm schließen',
  widgetCardExportPngAriaLabel: 'Laden Sie das erweiterte Diagramm als PNG herunter',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Beschreiben Sie ein Widget',
  aiCreateWidgetPlaceholder: 'z. B.: Balkendiagramm mit Umsatz nach Land, Gesamtauftrags-KPI …',
  aiCreateWidgetButton: 'Erstellen',
  aiCreateWidgetLoading: 'Erstellen…',
  aiCreateWidgetError: 'Widget konnte nicht erstellt werden',
  aiCreateWidgetNetworkError:
    'Netzwerkfehler. Überprüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
  aiCreateWidgetRequestFailed: (status, detail) =>
    `KI-Anfrage fehlgeschlagen (${status})${detail ? `: ${detail}` : ''}.`,
  aiCreateWidgetInvalidResponse: 'Ungültige Antwort der KI.',
  aiTextWidgetGenerationError: 'Inhalt konnte nicht generiert werden',

  // Widget type names
  widgetKindGrid: 'Tabelle',
  widgetKindChart: 'Diagramm',
  widgetKindKpi: 'KPI',
  widgetKindText: 'Text',
  widgetKindFilter: 'Filter',
  widgetKindPivot: 'Pivot-Tabelle',
  widgetKindMap: 'Karte',

  // Widget type descriptions
  widgetKindTextDescription: 'Titel, Untertitel und Fließtext',
  widgetKindKpiDescription: 'Einzelne Metrik mit Aggregation',
  widgetKindChartDescription: 'Visualisieren Sie Daten mit einem konfigurierbaren Diagramm',
  widgetKindGridDescription: 'Datenraster mit Sortierung und Filterung',
  widgetKindFilterDescription: 'Interaktive Filtersteuerung für den Vorschaumodus',
  widgetKindPivotDescription: 'Kreuztabelle mit Zeilen- und Spaltendimensionen',
  widgetKindMapDescription: 'Weltkarte der Choroplethen nach Ländern',
  composeCustomWidgetDescription: 'Benutzerdefiniertes Widget',

  // Data type labels
  dataTypeString: 'Text',
  dataTypeNumber: 'Nummer',
  dataTypeBoolean: 'Boolescher Wert',
  dataTypeDate: 'Datum',
  dataTypeDatetime: 'Datum und Uhrzeit',

  // Compose drawer / widget picker
  composeChooseWidgetType: 'Wählen Sie einen Widget-Typ',
  composeNoDataSources:
    'Keine Datenquelle verfügbar. Es können nur Text-Widgets hinzugefügt werden.',
  composeOnThisPage: 'Auf dieser Seite',
  composeAddWidgetLabel: (widgetTypeLabel) => `Widget ${widgetTypeLabel} hinzufügen`,
  composeCloseAriaLabel: 'Schließen',
  composeBackToWidgetTypesAriaLabel: 'Zurück zu den Widget-Typen',
  composeCancel: 'Stornieren',

  // Format panel
  formatAutoTitle: 'Automatisch generierter Titel',
  formatResetTitle: 'Auf automatisch generierten Titel zurücksetzen',
  formatAutoSubtitle: 'Automatisch generierter Untertitel',
  formatResetSubtitle: 'Zurücksetzen auf automatisch generierte Untertitel',
  formatPanelCompactNumbers: 'Kompakte Zahlen',
  formatPanelWidgetTitleLabel: 'Widget-Titel',
  formatPanelWidgetTitleHelperText: 'Wird im Widget-Header angezeigt',
  formatPanelSubtitleLabel: 'Untertitel',
  formatPanelSubtitleHelperText: 'Optionale Zeile, die unter dem Titel angezeigt wird',

  // Text format panel
  textFormatFontFamilyLabel: 'Schriftfamilie',
  textFormatFontSizeLabel: 'Schriftgröße',
  textFormatColorLabel: 'Farbe',
  textFormatColorPlaceholder: 'Standard',
  textFormatAlignLeftAriaLabel: 'Links ausrichten',
  textFormatAlignCenterAriaLabel: 'Zentralisieren',
  textFormatAlignRightAriaLabel: 'Richtig ausrichten',
  textFormatDefaultFont: 'Standard (Thema)',
  textFormatSansSerifFont: 'Serifenlos',
  textFormatSerifFont: 'Serife',
  textFormatMonospaceFont: 'Monospaced',
  textFormatDefaultSize: 'Standard',
  textFormatFontSizeOption: (px) => `${px} px`,
  textFormatAlignmentLabel: 'Ausrichtung',

  // Data drawer
  dataDrawerNoSources:
    'Keine Datenquellen konfiguriert. Fügen Sie dem Dashboard ein Widget hinzu, um Beispieldaten zu laden.',
  dataDrawerViewLineage: 'Datenherkunft anzeigen',
  dataDrawerLineageTitle: 'Datenherkunft',
  dataDrawerLineageHelper:
    'Klicken Sie auf einen Knoten, um dessen Daten anzuzeigen. Klicken Sie auf eine Kante, um die Join-Schlüsselfelder zu überprüfen.',
  dataDrawerRowsLabel: (count) => `${count} ${count === 1 ? 'Zeile' : 'Zeilen'}`,
  dataDrawerFieldsLabel: (count) => `${count} ${count === 1 ? 'Feld' : 'Felder'}`,
  dataDrawerBackAriaLabel: 'Zurück zum Abstammungsdiagramm',
  dataDrawerCloseAriaLabel: 'Schließen Sie die Datenherkunft',
  dataDrawerEditTooltip: 'Bearbeiten',
  dataDrawerDeleteTooltip: 'Löschen',
  dataDrawerAddCalculatedField: 'Berechnetes Feld hinzufügen',
  dataDrawerNoData: (sourceLabel) => `Keine Daten für ${sourceLabel} verfügbar.`,
  dataDrawerMoreRows: (count) => `${count} weitere Zeile${count === 1 ? '' : 'n'}`,
  dataDrawerMoreColumns: (count) => `${count} weitere Spalte${count === 1 ? '' : 'n'}`,
  dataDrawerViewSourceLink: 'Quelldaten anzeigen →',
  dataDrawerMorePreviewRows: (count) => `+${count} weitere`,
  dataDrawerRowsUnknown: 'Zeilenanzahl nicht verfügbar',
  dataDrawerDeleteFieldConfirmTitle: 'Berechnetes Feld löschen?',
  dataDrawerDeleteFieldConfirmMessage: (fieldLabel, referenceCount) =>
    `„${fieldLabel}“ wird an ${referenceCount} ${
      referenceCount === 1 ? 'Stelle' : 'Stellen'
    } verwendet (Widgets, Filter oder berechnete Felder). Beim Löschen ${
      referenceCount === 1 ? 'bleibt diese Stelle' : 'bleiben diese Stellen'
    } ohne anzuzeigenden Wert.`,
  saveRejectedMessage:
    'Diese Änderung konnte nicht gespeichert werden — sie wurde möglicherweise an anderer Stelle entfernt oder geändert. Schließen Sie den Dialog und versuchen Sie es erneut.',
  lineageTypePrefix: (type) => `Typ: ${type}`,
  lineageJoinDetail: (srcSource, srcField, tgtSource, tgtField) =>
    `Verknüpfung: ${srcSource}.${srcField} = ${tgtSource}.${tgtField}`,
  lineageViaDetail: (via) => `Über: ${via}`,
  lineagePreviewAriaLabel: (label) => `${label} in der Vorschau anzeigen`,
  lineageNoRelationships: 'Keine definierte Beziehung zwischen Quellen',

  // Relationship management
  relationshipEditTooltip: 'Bearbeiten',
  relationshipRemoveTooltip: 'Entfernen',
  relationshipCancel: 'Stornieren',
  relationshipTypeManyToOne: 'Viele-zu-eins',
  relationshipTypeOneToOne: 'Eins zu eins',
  relationshipTypeManyToMany: 'Viele-zu-viele',
  relationshipTypeLabel: 'Typ',
  relationshipJoinFieldLabel: 'Kreuzungsfeld',
  relationshipJunctionTableLabel: 'Verknüpfungstabelle (Brücke)',
  relationshipJunctionSourceLabel: 'Verbindungsquelle',
  relationshipJunctionSourceFkLabel: '→ FK des Ursprungs',
  relationshipJunctionTargetFkLabel: '→ Ziel FK',
  relationshipAddTitle: 'Beziehung hinzufügen',
  relationshipEditTitle: 'Beziehung bearbeiten',
  relationshipSourceManyLabel: 'N-Seite',
  relationshipSourceLabel: 'Herkunft',
  relationshipTargetOneLabel: 'Seite eins',
  relationshipTargetLabel: 'Ziel',
  relationshipUpdate: 'Aktualisieren',
  relationshipAdd: 'Zum Hinzufügen',
  relationshipSectionTitle: 'Beziehungen',
  relationshipAddButton: 'Zum Hinzufügen',
  relationshipNone: 'Keine Beziehungen konfiguriert.',
  relationshipVia: (junctionLabel) => `über ${junctionLabel}`,

  // Filter conditions & values
  filterConditionAnd: 'UND',
  filterConditionOr: 'ODER',
  filterOperatorLabel: 'Operator',
  filterRemoveSecondCondition: 'Zweite Bedingung entfernen',
  filterAbsoluteDate: 'Absolutes Datum',
  filterRelativeDate: 'Relatives Datum',
  filterBooleanTrue: 'WAHR',
  filterBooleanFalse: 'FALSCH',
  filterRemoveAriaLabel: 'Filter entfernen',
  filterInteractiveSectionTitle: 'Interaktive Filter',
  filterCrossSectionTitle: 'Kreuzfilter',
  filterClearFilter: 'Filter reinigen',
  filterClearInteractiveAriaLabel: 'Interaktiven Filter löschen',
  filterClearAllCrossFilters: 'Löschen Sie alle Kreuzfilter',
  filterRemoveCrossFilter: 'Kreuzfilter entfernen',
  filterSearchValues: 'Werte suchen…',
  filterSelectField: 'Wählen Sie ein Feld aus…',
  filterValueLabel: 'Wert',
  filterValueHelper: 'Wert zum Vergleichen',
  filterValueAmountLabel: 'Wert',
  filterSelectParent: 'Wählen Sie den übergeordneten Filter aus…',
  filterFieldLabel: 'Feld',
  filterRankByLabel: 'Sortieren nach',
  filterSelectionNoValues: 'Keine Werte gefunden.',
  filterSelectionAll: 'Alle',
  filterSelectionSelectedCount: (count) => `${count} ausgewählt`,
  filterSelectionCapHint: (cap) =>
    `Die ersten ${cap} Werte werden angezeigt. Tippen Sie, um die Liste einzugrenzen.`,
  filterSectionNoInteractiveFilters:
    'Keine aktiven interaktiven Filter. Verwenden Sie Filter-Widgets auf dem Bildschirm, um Filter festzulegen.',
  filterSectionNoCrossFilters:
    'Kein Kreuzfilter aktiv. Klicken Sie auf Diagrammelemente oder wählen Sie Tabellenzeilen aus, um Kreuzfilter zu erstellen.',
  filterSectionSelectedCount: (count) => `${count} ausgewählt`,
  filterSectionValueDisplay: (fieldLabel, value) => `${fieldLabel} = ${value}`,
  filterSectionSourcePrefix: (widgetTitle) => `Von: ${widgetTitle}`,
  filterBodyAddCondition: 'Bedingung hinzufügen',
  filterBodyNarrowOptions: 'Eingeschränkte Optionen basierend auf:',
  filterModeFilter: 'Filter',
  filterModeSelect: 'Wählen',
  filterModeRank: 'Sortieren',
  filterRelativeUnitSeconds: 'Sekunden',
  filterRelativeUnitMinutes: 'Minuten',
  filterRelativeUnitHours: 'Std.',
  filterRelativeUnitDays: 'Tage',
  filterRelativeUnitWeeks: 'Wochen',
  filterRelativeUnitMonths: 'Monate',
  filterRelativeUnitYears: 'Jahre',
  filterDatePreset7Days: '7 Tage',
  filterDatePreset30Days: '30 Tage',
  filterDatePreset3Months: '3 Monate',
  filterDatePreset12Months: '12 Monate',
  filterDatePreset1Year: '1 Jahr',
  filterRelativeDateAgo: 'vor',
  filterRelativeDateFromNow: 'ab jetzt',
  filterDateLabel: 'Datum',
  filterRankAggSumLabel: 'Summe aller Serien',
  filterRankAggAvgLabel: 'Durchschnitt aller Serien',
  filterRankAggMaxLabel: 'Maximum aller Serien',
  filterRankAggMinLabel: 'Minimum aller Serien',
  filterRankTop: 'Größte',
  filterRankBottom: 'Kleinste',
  filterRankTopCount: (count) => `Größte ${count}`,
  filterRankBottomCount: (count) => `Kleinste ${count}`,

  // Filter summary
  filterSummaryAnyValue: 'beliebiger Wert',
  filterSummaryIsOneOf: 'ist eines von:',
  filterSummaryIsNot: 'ist nicht:',
  filterSummaryAndMore: (count) => `und ${count} weitere`,
  filterSummaryFrom: (value) => `ab ${value}`,
  filterSummaryUntil: (value) => `bis ${value}`,

  // Filter operator labels (per field type)
  filterOperator_string_equals: 'Ist gleich',
  filterOperator_string_not_equals: 'Ist nicht gleich',
  filterOperator_string_contains: 'Enthält',
  filterOperator_string_does_not_contain: 'Enthält nicht',
  filterOperator_string_starts_with: 'Beginnt mit',
  filterOperator_string_not_starts_with: 'Beginnt nicht mit',
  filterOperator_string_ends_with: 'Endet mit',
  filterOperator_string_not_ends_with: 'Endet nicht mit',
  filterOperator_string_is_empty: 'Ist leer',
  filterOperator_string_is_not_empty: 'Ist nicht leer',
  filterOperator_number_equals: '=',
  filterOperator_number_not_equals: '≠',
  filterOperator_number_greater_than: '>',
  filterOperator_number_greater_than_or_equal: '≥',
  filterOperator_number_less_than: '<',
  filterOperator_number_less_than_or_equal: '≤',
  filterOperator_number_between: 'Zwischen',
  filterOperator_number_is_empty: 'Ist leer',
  filterOperator_number_is_not_empty: 'Ist nicht leer',
  filterOperator_date_equals: 'Am',
  filterOperator_date_not_equals: 'Nicht am',
  filterOperator_date_less_than: 'Vor',
  filterOperator_date_greater_than: 'Nach',
  filterOperator_date_less_than_or_equal: 'Am oder vor',
  filterOperator_date_greater_than_or_equal: 'Am oder nach',
  filterOperator_date_between: 'Zwischen',
  filterOperator_date_is_empty: 'Ist leer',
  filterOperator_date_is_not_empty: 'Ist nicht leer',
  filterOperator_datetime_equals: 'Um',
  filterOperator_datetime_not_equals: 'Nicht um',
  filterOperator_datetime_greater_than: 'Nach',
  filterOperator_datetime_less_than: 'Vor',
  filterOperator_datetime_greater_than_or_equal: 'Um oder nach',
  filterOperator_datetime_less_than_or_equal: 'Um oder vor',
  filterOperator_datetime_between: 'Zwischen',
  filterOperator_datetime_is_empty: 'Ist leer',
  filterOperator_datetime_is_not_empty: 'Ist nicht leer',
  filterOperator_boolean_equals: 'Ist',
  filterOperator_boolean_not_equals: 'Ist nicht',

  // Expression field dialog
  exprNodeTypeField: 'Feld',
  exprNodeTypeLiteral: 'Wörtlich',
  exprNodeTypeFunction: 'Funktion',
  exprDataTypeNumber: 'Zahl',
  exprDataTypeText: 'Text',
  exprDataTypeBoolean: 'Boolescher Wert',
  exprBooleanTrue: 'WAHR',
  exprBooleanFalse: 'FALSCH',
  exprExpandTooltip: 'Expandieren',
  exprCollapseTooltip: 'Reduzieren',
  exprRemoveInputTooltip: 'Eintrag entfernen',
  exprCancel: 'Stornieren',
  exprSave: 'Speichern',
  exprAddField: 'Feld hinzufügen',
  expressionNameLabel: 'Name',
  expressionNameHelperText: 'Wird als Feldbezeichnung in Selektoren und Tabellenspalten verwendet',
  expressionNamePlaceholder: 'z.B.: Gewinn, Umsatz pro Einheit',
  expressionDescriptionLabel: 'Beschreibung',
  expressionDescriptionHelperText: 'Optional. Wird als Tooltip in Feldauswahlen angezeigt',
  expressionDescriptionPlaceholder: 'Optional: Beschreiben Sie, was dieses Feld berechnet',
  expressionPrecisionLabel: 'Präzision',
  expressionPrecisionHelperText:
    'Dezimalstellen (0–10), die bei der Formatierung dieses berechneten Felds verwendet werden',
  expressionBuilderSectionLabel: 'Ausdruck',

  // Expression builder: operator picker
  exprOpAdd: 'Addieren (+)',
  exprOpSubtract: 'Subtrahieren (−)',
  exprOpMultiply: 'Multiplizieren (×)',
  exprOpDivide: 'Dividieren (÷)',
  exprOpModulo: 'Modulo (%)',
  exprOpNegate: 'Negieren (−x)',
  exprOpEquals: 'Gleich (=)',
  exprOpNotEqual: 'Ungleich (≠)',
  exprOpLessThan: 'Kleiner als (<)',
  exprOpGreaterThan: 'Größer als (>)',
  exprOpLessThanOrEqual: 'Kleiner oder gleich (≤)',
  exprOpGreaterThanOrEqual: 'Größer oder gleich (≥)',
  exprOpAnd: 'Und',
  exprOpOr: 'Oder',
  exprOpNot: 'Nicht',
  exprOpIsTrue: 'Ist wahr',
  exprOpIsFalse: 'Ist falsch',
  exprOpIsNull: 'Ist null',
  exprOpIsNotNull: 'Ist nicht null',
  exprOpIf: 'Wenn / Dann / Sonst',
  exprOpIn: 'In (Wert ist einer von)',
  exprOpDatediff: 'Datumsdifferenz',
  exprGroupArithmetic: 'Arithmetik',
  exprGroupComparison: 'Vergleich',
  exprGroupLogical: 'Logisch',
  exprGroupConditional: 'Bedingung',
  exprGroupDate: 'Datum',
  exprInputLabelUnit: 'Einheit (z.B. "Tag", "Monat", "Jahr")',
  exprInputLabelCondition: 'Bedingung',
  exprInputLabelThen: 'Dann',
  exprInputLabelElse: 'Sonst',
  exprInputLabelGeneric: (index) => `Eingabe ${index}`,
  exprAddInputButton: 'Eingabe hinzufügen',
  exprOutputTypeLabel: 'Ausgabetyp:',
  exprRootNodeLabel: 'Ausdruck',
  exprLiteralValueAriaLabel: 'Literalwert',
  exprUnnamedFieldLabel: 'Unbenannt',
  exprPreviewNullLabel: 'null',
  exprCalculatedFieldBadgeLabel: 'Berechnetes Feld',

  // Expression validation errors
  exprErrorMissingId: 'Das berechnete Feld muss eine ID haben.',
  exprErrorMissingLabel: 'Das berechnete Feld muss einen Namen haben.',
  exprErrorMissingSourceId: 'Das berechnete Feld muss einer Datenquelle zugeordnet sein.',
  exprErrorMaxDepth: (maxDepth) =>
    `Der Ausdruck ist mehr als ${maxDepth} Ebenen tief verschachtelt.`,
  exprErrorUnknownField: (fieldId) =>
    `Das Feld „${fieldId}“ wurde weder in den Quellfeldern noch in den berechneten Feldern gefunden.`,
  exprErrorUnreachableField: (fieldId, fieldSourceId) =>
    `Das Feld „${fieldId}“ gehört zur Datenquelle „${fieldSourceId}“, die nicht mit der Datenquelle dieses Feldes verknüpft ist.`,
  exprErrorMalformedNode:
    'Ungültiger Ausdrucksknoten: Erwartet wird ein Operatorknoten (mit einem `inputs`-Array), ein Literalwert, eine Feldreferenz oder eine Join-Feldreferenz.',
  exprErrorInsufficientArity: (operator, required, actual) =>
    `Der Operator „${operator}“ benötigt mindestens ${required} Eingabe(n), erhalten: ${actual}.`,
  exprErrorCircularDependency: (fieldId) =>
    `Das berechnete Feld „${fieldId}“ erzeugt eine zirkuläre Abhängigkeit.`,

  // Shared aggregation function labels
  aggFnSum: 'Summe',
  aggFnCount: 'Zählen',
  aggFnCountRows: 'Anzahl (Zeilen)',
  aggFnAverage: 'Durchschnitt',
  aggFnMin: 'Min.',
  aggFnMax: 'Max.',

  // Shared time granularity labels
  timeGranNone: 'Keine (Rohwerte)',
  timeGranDay: 'Tag',
  timeGranWeek: 'Woche',
  timeGranMonth: 'Monat',
  timeGranQuarter: 'Quartal',
  timeGranYear: 'Jahr',

  // Shared sort direction labels
  sortAscendingAriaLabel: 'Aufsteigend',
  sortDescendingAriaLabel: 'Absteigend',
  crossFilterModeHighlight: 'Hervorheben',
  crossFilterModeFilter: 'Filter',
  crossFilterModeNone: 'Keine',

  // Chart setup panel
  chartTypePickerLabel: 'Diagrammtyp',
  chartTypeBarGrouped: 'Balken (gruppiert)',
  chartTypeBarStacked: 'Balken (gestapelt)',
  chartTypeBar100: 'Balken (100 %)',
  chartTypeBarHorizontal: 'Balken (horizontal)',
  chartTypeBarStackedHorizontal: 'Balken (gestapelt, horizontal)',
  chartTypeBar100Horizontal: 'Balken (100 %, horizontal)',
  chartTypeLine: 'Linie',
  chartTypeArea: 'Fläche',
  chartTypeAreaStacked: 'Fläche (gestapelt)',
  chartTypeArea100: 'Fläche (100 %)',
  chartTypeScatter: 'Streudiagramm',
  chartTypeMixed: 'Gemischt (Balken + Linie)',
  chartTypeHeatmap: 'Heatmap',
  chartTypeFunnel: 'Trichter',
  chartTypeGantt: 'Gantt / Zeitleiste',
  chartTypeSankey: 'Sankey',
  chartTypePie: 'Kreis',
  chartTypeDonut: 'Ring',
  chartTypeGauge: 'Messgerät',
  chartSetupValueFieldLabel: 'Wertfeld',
  chartSetupValueFieldHelperText: 'Numerisches Feld zum Aggregieren',
  chartSetupAggregationLabel: 'Aggregation',
  chartSetupMinLabel: 'Min.',
  chartSetupMaxLabel: 'Max.',
  chartSetupGroupByLabel: 'Gruppieren nach',
  chartSetupSortByLabel: 'Sortieren nach',
  chartSetupSortCategory: 'Kategorie',
  chartSetupSortValue: 'Wert',
  chartSetupSortNatural: 'Natürlich',
  chartSetupSortNone: 'Keiner',
  chartSetupSortPercent: 'Prozentsatz',
  chartSetupSortDirectionAriaLabel: 'Bestellrichtung',
  chartSetupAnnotationsTitle: 'Notizen',
  chartSetupInteractionsTitle: 'Interaktionen',
  chartSetupInteractionsDescription: 'Wenn auf andere Widgets geklickt wird, wird dieses Diagramm…',
  chartSetupAddSeries: 'Serie hinzufügen',
  chartSetupNoMoreFields: 'Es müssen keine weiteren Felder hinzugefügt werden',
  chartSetupRemoveSeries: 'Serie entfernen',
  chartSetupAddReferenceLine: 'Referenzlinie hinzufügen',
  chartSetupRemoveAnnotation: 'Anmerkung entfernen',
  chartSetupNoReferenceLines: 'Keine Referenzlinien. Klicken Sie auf +, um eines hinzuzufügen.',
  chartSetupDualYAxis: 'Duale Y-Achse (Linienreihe auf der rechten Achse)',
  chartSetupReferenceLineValueLabel: 'Wert',
  chartSetupReferenceLineLabelLabel: 'Etikett',
  chartSetupYFieldLabel: 'Feld Y (numerisch)',
  chartSetupYFieldHelperText: 'Auf der vertikalen Achse aufgetragenes numerisches Feld',
  chartSetupColorByLabel: 'Malen nach (optional)',
  chartSetupColorByHelperText: 'Unterteilt Punkte nach farbcodierter Kategorie in Serien',
  chartSetupSizeByLabel: 'Größe nach (optional)',
  chartSetupSizeByHelperText:
    'Numerisches Feld, das den Radius der Blase steuert (erstellt ein Blasendiagramm)',
  chartSetupMinRadiusLabel: 'Mindestradius',
  chartSetupMaxRadiusLabel: 'Maximaler Radius',
  chartSetupFunnelValueHelperText:
    'Nach Stufe summiertes numerisches Feld – Stufen werden nach Wert geordnet (größter zuerst)',
  chartSetupHeatmapRowAxisLabel: 'Linienachsenfeld',
  chartSetupHeatmapRowAxisHelperText:
    'Feld für die vertikale Achse (Linie) — beliebiger Feldtyp aus der Primärquelle, z.B. Kategorie, Rabatt % oder Uhrzeit',
  chartSetupHeatmapValueLabel: 'Wert-/Farbfeld',
  chartSetupHeatmapValueHelperText:
    'Numerisches Feld, das pro Zelle summiert wird, um die Farbintensität zu bestimmen',
  chartSetupHeatmapColourSchemeLabel: 'Farbschema',
  chartSetupHeatmapSortByLabel: 'Sortieren nach',
  chartSetupHeatmapSortXAxis: 'Spaltenachse (X)',
  chartSetupHeatmapSortYAxis: 'Zeilenachse (Y)',
  chartSetupArcLabelLabel: 'Bogenetikett',
  chartSetupMinAngleLabel: 'Mindestwinkel (°)',
  chartSetupMinAngleHelperText:
    'Für Schnitte, die kleiner als dieser Winkel (Grad) sind, wird keine Beschriftung angezeigt',
  chartSetupGanttLabelFieldLabel: 'Beschriftungsfeld',
  chartSetupGanttLabelFieldHelperText:
    'Feld, das als Zeilenbeschriftung auf der Y-Achse angezeigt wird (z. B. Aufgaben- oder Auftragsname)',
  chartSetupGanttStartDateLabel: 'Feld „Startdatum“.',
  chartSetupGanttStartDateHelperText: 'Datums-/Uhrzeitfeld für den Beginn jedes Takts',
  chartSetupGanttEndDateLabel: 'Feld „Enddatum“.',
  chartSetupGanttEndDateHelperText: 'Datums-/Uhrzeitfeld für das Ende jedes Balkens',
  chartSetupGanttColourByLabel: 'Malen nach (optional)',
  chartSetupGanttColourByHelperText:
    'Kategorisches Feld zum Färben der Balken (z. B. Status oder Kategorie)',
  chartSetupXFieldNumericLabel: 'Feld X (numerisch)',
  chartSetupXFieldCategoryVertLabel: 'Feld Y/Kategorie',
  chartSetupXFieldCategoryHorizLabel: 'Feld X/Kategorie',
  chartSetupXFieldHorizontalHelperText: 'Auf der horizontalen Achse aufgetragen',
  chartSetupXFieldGroupVertHelperText: 'Gruppiert Daten entlang der vertikalen Achse',
  chartSetupXFieldGroupHorizHelperText: 'Gruppiert Daten entlang der horizontalen Achse',
  chartSetupYMeasureFieldsLabel: 'Y/Maßfelder',
  chartSetupXMeasureFieldsLabel: 'X/Maßfelder',
  chartSetupYMeasureFieldLabel: 'Y-Feld/Kennzahl',
  chartSetupXMeasureFieldLabel: 'Feld X/Maß',
  chartSetupNoDataAlert: 'Für die Diagrammkonfiguration ist kein Datenfeld verfügbar.',
  chartSetupSeriesLabel: (index) => `Serie ${index + 1}`,
  chartSetupSeriesNumericHorizHelperText:
    'Numerisches Feld, aufgetragen entlang der horizontalen Achse',
  chartSetupSeriesNumericSumHelperText: 'Numerisches Feld, summiert oder gemittelt nach Kategorie',
  chartSetupMixedSeriesBar: 'Bar',
  chartSetupMixedSeriesLine: 'Linie',
  chartSetupRemoveSplitByTooltip:
    'Entfernen Sie zusätzliche Maßfelder, um die Division durch zu ermöglichen',
  chartSetupInnerRingLabel: 'Kategorie „Innenring“.',
  chartSetupSplitByLabel: 'Teilen durch (Reihenfeld)',
  chartSetupArcLabelsTitle: 'Bogenbeschriftungen',
  chartSetupSplitByHelperText: 'Teilt Daten in eine nach Wert getrennte Reihe auf',
  chartSetupSplitByDisabledHelperText:
    'Nicht verfügbar, wenn mehrere Kennzahlenfelder konfiguriert sind',
  chartSetupInnerRingHelperText:
    'Fügt einen konzentrischen Innenring hinzu, der nach diesem Feld gruppiert ist',
  chartSetupGaugeMinRevertedHelperText:
    'Min muss eine Zahl unter Max sein — Ihre Eingabe wurde zurückgesetzt.',
  chartSetupGaugeMaxRevertedHelperText:
    'Max muss eine Zahl über Min sein — Ihre Eingabe wurde zurückgesetzt.',
  chartSetupRadiusRevertedHelperText: (min, max) =>
    `Geben Sie eine Zahl von ${min} bis ${max} ein, wobei Min-Radius unter Max-Radius bleibt — Ihre Eingabe wurde zurückgesetzt.`,
  chartSetupValueClampedHelperText: (clamped) =>
    `Außerhalb des zulässigen Bereichs — auf ${clamped} angepasst.`,

  // KPI setup panel
  kpiSetupChartLine: 'Linie',
  kpiSetupChartBar: 'Bar',
  kpiSetupChartGauge: 'Messgerät',
  kpiSetupCompPrevPeriod: 'Vorheriger Zeitraum (entsprechende Dauer)',
  kpiSetupCompPrevCalendarPeriod: 'Vorheriger Kalenderzeitraum',
  kpiSetupCompSameLastYear: 'Gleicher Zeitraum letztes Jahr',
  kpiSetupInteractionsTitle: 'Interaktionen',
  kpiSetupInteractionsDescription: 'Wenn auf andere Widgets geklickt wird, wird dieser KPI…',
  kpiSetupTimeFieldLabel: 'Zeitfeld',
  kpiSetupGranularityLabel: 'Granularität',
  kpiSetupPlotTypeLabel: 'Diagrammtyp',
  kpiSetupValueFieldLabel: 'Wertfeld',
  kpiSetupValueFieldHelperText: 'Feld zum Hinzufügen',
  kpiSetupSparklineLabel: 'Sparkline',
  kpiSetupGaugeMaxLabel: 'Ziel',
  kpiSetupTrendLabel: 'Trend',
  kpiSetupDateRangeLabel: 'Datumsbereich',
  kpiSetupDateRangeFieldLabel: 'Datumsfeld',
  kpiSetupCompPeriodLabel: 'Vergleichszeitraum',
  kpiSetupDateAggEarliest: 'Früher',
  kpiSetupDateAggLatest: 'Später',
  kpiSetupFillAreaLabel: 'Bereich füllen',
  kpiSetupCumulativeLabel: 'Kumulativ (kumulierte Summe)',
  kpiSetupAutoDateFilterPrefix: 'Datumsfilter verwenden:',
  kpiSetupInvertColours: 'Farben invertieren (kleiner ist besser)',
  kpiSetupFixedWindowLabel: 'Trendzeitraum',
  kpiSetupFixedWindowNone: 'Aus Datumsfilter',
  kpiSetupFixedWindowMonth: 'Letzte 30 Tage',
  kpiSetupFixedWindowQuarter: 'Letzte 90 Tage',
  kpiSetupFixedWindowYear: 'Letzte 365 Tage',

  // KPI widget
  kpiGranularityAutoLabel: 'Selbst',

  // Grid setup panel
  gridSetupDataSourceLabel: 'Datenquelle',
  gridSetupDataSourcePlaceholder: 'Wählen Sie eine Datenquelle aus…',
  gridSetupAllColumnsAdded: 'Alle verfügbaren Spalten wurden hinzugefügt',
  gridSetupCrossFilterFieldLabel: 'Kreuzfilterfeld',
  gridSetupCrossFilterFieldHelper:
    'Feld, das auf andere Widgets angewendet wird, wenn eine Zeile ausgewählt wird; Standard ist die erste sichtbare Spalte',
  gridSetupGroupByLabel: 'Gruppieren nach',
  gridSetupGroupByHelper:
    'Reduzieren Sie Zeilen in Gruppen – legen Sie unten die Aggregation nach Spalte fest',
  gridSetupDefaultSortLabel: 'Standardbestellung',
  gridSetupHeightLabel: 'Höhe (px)',
  gridSetupConditionalFormattingTitle: 'Bedingte Formatierung',
  gridSetupConditionalCustom: 'Brauch',
  gridSetupRemoveRuleAriaLabel: 'Regel entfernen',
  gridSetupInteractionsTitle: 'Interaktionen',
  gridSetupInteractionsDescription: 'Wenn auf andere Widgets geklickt wird, wird diese Tabelle…',
  gridSetupChooseSourceHelper: 'Wählen Sie eine Datenquelle aus, um die Spalten zu konfigurieren',
  gridSetupNoSourceAlert:
    'Wählen Sie oben eine Datenquelle aus, um die Spalten und Einstellungen für diese Tabelle zu konfigurieren.',
  gridSetupColumnsTitle: 'Spalten',
  gridSetupColumnOptionsAriaLabel: (label) => `Optionen für ${label}`,
  gridSetupColumnGroupLabel: '(Gruppe)',
  gridSetupColumnRemove: 'Entfernen',
  gridSetupColumnAggNone: 'Keiner',
  gridSetupColumnAggUnique: 'Einzel',
  gridSetupColumnAggSummaryTooltip: 'Zusammenfassung festlegen/entfernen',
  gridSetupColumnAggLabel: (isGroupBy, aggLabel) =>
    `${isGroupBy ? 'Aggregation' : 'Zusammenfassung'}: ${aggLabel}`,
  gridSetupColumnSetAggTooltip: 'Aggregation definieren',
  gridSetupAddColumn: 'Spalte hinzufügen',
  gridSetupCalculatedColumn: 'Berechnete Spalte…',
  gridSetupAddRule: 'Regel hinzufügen',
  gridSetupCFContains: 'enthält',
  gridSetupCFIsEmpty: 'ist leer',
  gridSetupCFNotEmpty: 'ist nicht leer',
  gridSetupCFStyleRed: 'Rot',
  gridSetupCFStyleGreen: 'Grün',
  gridSetupCFStyleYellow: 'Gelb',
  gridSetupCFStyleBlue: 'Blau',
  gridSetupCFStyleBold: 'Deutlich',
  gridSetupMeasuresSubheader: 'Kennzahlen',
  gridSetupMeasureNotColumnHelper:
    'Kennzahlen aggregieren den gesamten Datensatz, haben also keinen Wert pro Zeile und können keine Tabellenspalten sein. Verwenden Sie sie in einem KPI oder Diagramm.',
  gridSetupCFValuePlaceholder: 'Wert',

  // Map setup panel
  mapSetupMapTypeLabel: 'Kartentyp',
  mapSetupValueFieldLabel: 'Wertfeld (optional zum Zählen)',
  mapSetupColourSchemeLabel: 'Farbschema',
  mapSetupLegendPositionLabel: 'Position der Beschriftung',
  mapSetupScaleFromZeroLabel: 'Skalieren Sie von Grund auf',
  mapSetupClickableLabel: 'Anklickbar (Filterschriftart)',
  mapSetupColorBlues: 'Blau',
  mapSetupColorReds: 'Rote',
  mapSetupColorGreens: 'Grüne',
  mapSetupColorOranges: 'Orangen',
  mapSetupColorPurples: 'Lila',
  mapSetupLegendBottom: 'Unten',
  mapSetupLegendTop: 'Höher',
  mapSetupLegendLeft: 'Links',
  mapSetupLegendRight: 'Rechts',
  mapSetupLegendHidden: 'Keine',
  mapSetupLegendAlignLabel: 'Legenden-Ausrichtung',
  mapSetupLegendAlignStart: 'Oben',
  mapSetupLegendAlignCenter: 'Mitte',
  mapSetupLegendAlignEnd: 'Unten',
  mapFormatLegendAlignLeft: 'Links',
  mapFormatLegendAlignRight: 'Rechts',
  mapSetupRegionFieldLabel: 'Regionsfeld',
  mapSetupRegionFieldHelperText:
    'Ein Feld, das Regionskennungen enthält, die geografischen Ressourcen-IDs entsprechen.',
  mapSetupCountryFieldLabel: 'Länderfeld',
  mapSetupCountryFieldHelperText:
    'Ein Feld mit ISO-Alpha-2-Codes, Alpha-3-Codes oder vollständigen Ländernamen.',
  mapSetupStateFieldLabel: 'Bundesstaatsfeld',
  mapSetupStateFieldHelperText:
    'Ein Feld mit US-Bundesstaatsnamen oder zweibuchstabigen Postkürzeln.',
  mapSetupUnreachableFieldWarning:
    'Dieses Feld stammt nicht aus der Widget-Quelle oder einer direkt verknüpften Quelle und kann daher nicht aufgelöst werden. Die Karte wird leer angezeigt.',

  // Pivot setup panel
  pivotSetupDescription:
    'Erstellen Sie eine Kreuztabelle, indem Sie ein Zeilenfeld, ein Spaltenfeld und ein Wertmaß auswählen.',
  pivotSetupRowFieldLabel: 'Linienfeld',
  pivotSetupRowFieldHelper: 'Kategorisches Feld, das links als Zeilengruppen angezeigt wird',
  pivotSetupColFieldLabel: 'Spaltenfeld',
  pivotSetupColFieldHelper: 'Kategoriales Feld, verteilt auf Spaltenüberschriften',
  pivotSetupValueFieldLabel: 'Wertfeld',
  pivotSetupValueFieldHelper: 'Aggregiertes numerisches Feld in jeder Zelle',
  pivotSetupShowTotals: 'Summenzeile und -spalte anzeigen',
  pivotSetupAggregationLabel: 'Aggregation',

  // Inline formula bar
  inlineFormulaBarAddTooltip: 'Berechnetes Formelfeld hinzufügen',
  inlineFormulaBarCloseAriaLabel: 'Formelleiste schließen',
  inlineFormulaBarLabelLabel: 'Etikett',
  inlineFormulaBarAutoHelperText: 'Automatisch aus der Formel generiert – zum Anpassen bearbeiten',
  inlineFormulaBarCancelButton: 'Stornieren',
  inlineFormulaBarAddButton: 'Zum Hinzufügen',
  inlineFormulaBarFieldOperandLabel: 'Feld',
  inlineFormulaBarNumberOperandLabel: 'Nummer',
  inlineFormulaBarOperandTypeAriaLabel: (label) => `Typ für ${label}`,
  inlineFormulaBarButtonLabel: 'Formel',
  inlineFormulaBarOperandALabel: 'DER',
  inlineFormulaBarOperandBLabel: 'B',

  // Field detail view
  fieldDetailRowSourceId: 'Quell-ID',
  fieldDetailRowName: 'Name',
  fieldDetailRowDescription: 'Beschreibung',
  fieldDetailRowDataType: 'Datentyp',
  fieldDetailRowCalculationType: 'Art der Berechnung',
  fieldDetailRowNoCalculation: 'Keine Berechnung',
  fieldDetailRowFormat: 'Format',
  fieldDetailNumberFormatLabel: 'Numerisches Format',
  fieldDetailNumberFormatDefault: 'Standard',
  fieldDetailFormatInteger: 'Ganz',
  fieldDetailFormatDecimal: 'Dezimal',
  fieldDetailFormatPercent: 'Prozentsatz',
  fieldDetailFormatCurrency: 'Münze',

  // Filters drawer
  filtersDrawerRenameViewTooltip: 'Ansicht umbenennen',
  filtersSectionWidgetTitle: (title) => `Widget: ${title}`,
  filtersRenameViewAriaLabel: 'Gespeicherte Ansicht umbenennen',
  filtersRenameViewButtonAriaLabel: (name) => `Ansicht "${name}" umbenennen`,
  filtersDeleteViewAriaLabel: (name) => `Ansicht "${name}" löschen`,

  // Filter setup panel
  filterSetupControlTypeLabel: 'Kontrolltyp',
  filterSetupMultiSelect: 'Mehrfachauswahl',
  filterSetupMultiSelectDescription: 'Dropdown-Menü mit Kontrollkästchen für kategoriale Werte',
  filterSetupToggleChips: 'Chips umschalten',
  filterSetupToggleChipsDescription: 'Inline-Chipknöpfe für kategoriale Werte',
  filterSetupDateRange: 'Datumsbereich',
  filterSetupDateRangeDescription: 'Auswahlmöglichkeiten für Start- und Enddatum',
  filterSetupSlider: 'Schieberegler',
  filterSetupSliderDescription: 'Bereichsschieberegler für numerische oder Datumsfelder',
  filterSetupMinLabel: 'Min.',
  filterSetupMaxLabel: 'Max.',
  filterSetupStepLabel: 'Schritt',
  filterSetupSelectFieldAlert: 'Wählen Sie ein Feld aus, um die Filtersteuerung zu konfigurieren.',
  filterSetupSliderRangeHelperText:
    'Schiebereglerbereich (leer lassen, um die Daten automatisch zu erkennen)',
  filterSetupMinAboveMaxError:
    'Min. muss unter Max. liegen — sonst vertauscht das Widget die beiden Werte.',
  filterSetupStepNotPositiveError:
    'Der Schritt muss größer als 0 sein — sonst ignoriert ihn das Widget.',
  filterSetupStepExceedsRangeError: 'Der Schritt ist größer als der Bereich von Min. bis Max.',

  // Text setup panel
  textSetupTitleLabel: 'Titel',
  textSetupTitleHelper: 'Kopfzeile wird oben im Widget angezeigt',
  textSetupSubtitleLabel: 'Untertitel',
  textSetupSubtitleHelper: 'Kleinerer Text unter der Überschrift',
  textSetupBodyLabel: 'Körper',
  textSetupBodyHelper: 'Hauptinhalt des Widgets; unterstützt Klartext',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Filter reinigen',
  filterWidgetSelectAllLabel: 'Alles auswählen',
  filterWidgetClearAllLabel: 'Alles löschen',
  filterWidgetAllLabel: 'Alle',
  filterWidgetNoOptionsLabel: 'Keine Optionen gefunden',
  filterWidgetNoSearchMatchesLabel: 'Keine Treffer',
  filterRankConflictMessage:
    'Pro Seite ist nur ein Top-N- oder Bottom-N-Filter zulässig. Entfernen Sie zuerst den vorhandenen.',
  filterWidgetSelectedCount: (count) => `${count} ausgewählt`,
  filterWidgetExcludeLabel: 'Ausgewählte löschen',
  filterWidgetExcludingLabel: '⊘ Ausgewählte löschen',
  filterWidgetDateFromLabel: 'Von',
  filterWidgetDateToLabel: 'Bis',
  filterWidgetNoFieldConfigured:
    'Keine Felder konfiguriert. Wählen Sie im Bedienfeld „Verfassen“ ein Feld aus.',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Leeres Feld',
  dataSourceAddCalculatedField: 'Berechnetes Feld hinzufügen…',
  dataSourceFieldUnavailableOption: (fieldId) => `${fieldId} (nicht verfügbar)`,
  dataSourceFieldUnavailableHelperText: (fieldId) =>
    `„${fieldId}“ ist in den Daten nicht mehr verfügbar. Wählen Sie ein anderes Feld aus.`,
  dataSourceFieldUnavailableGroupLabel: 'Nicht verfügbar',

  // Widget filter row
  widgetFilterFieldHelperText: 'Feld, auf das dieser Filter angewendet wird',
  drawerPanelOpenAriaLabel: (title) => `Panel ${title} öffnen`,
  drawerPanelCloseNamedAriaLabel: (title) => `Panel ${title} schließen`,
  sidebarPanelToggleAriaLabel: (isActive, label) =>
    isActive ? `Panel ${label} schließen` : `Panel ${label} öffnen`,
  addWidgetGroupAriaLabel: (groupLabel) => `Widgets für ${groupLabel}`,
  addWidgetSelectAriaLabel: (label) => `Widget auswählen: ${label}`,
  formatPanelNoSubtitlePlaceholder: 'Kein Untertitel',

  // Widget filters panel
  widgetFiltersPanelNoSource: 'Dieses Widget hat keine Datenquelle.',
  widgetFiltersPanelDescription:
    'Permanente Bedingungen, die vor allen interaktiven Filtern auf die Daten dieses Widgets angewendet werden.',
  widgetFiltersPanelNoFilters: 'Ohne Filter werden alle Daten angezeigt.',
  widgetFiltersPanelAddButton: 'Filter hinzufügen',

  // Expression field preview
  expressionPreviewMeasureLabel: (count) =>
    `Vorschau (Messwert auf ${count.toLocaleString('de')} Zeilen)`,
  expressionPreviewFirstRowsLabel: (count) =>
    `Vorschau (erste ${count.toLocaleString('de')} Zeilen)`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} Zeile${count === 1 ? '' : 'n'} werden nicht angezeigt: Erhöhen Sie die Widget-Höhe, um alle zu sehen`,

  // Color input
  colorInputClearAriaLabel: (label) => `${label.toLowerCase()} löschen`,
  colorInputPickerAriaLabel: (label) => `${label}-Farbwähler`,

  // KPI widget
  kpiTrendNewLabel: 'Neu',
  kpiTrendTargetTooltip: (value) => `Ziel: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Vorheriger Zeitraum: ${period}`,
  kpiTrendVsLabel: (period) => `vs. ${period}`,
  kpiTrendNoDateFilterHint: 'Fügen Sie einen Datumsfilter hinzu, um den Trend anzuzeigen.',
  kpiSparklineNoTimeFieldHint:
    'Fügen Sie einen Datumsfilter hinzu oder wählen Sie ein Zeitfeld aus, um die Sparkline anzuzeigen.',

  // Chart widget
  chartMixedRequiresFieldsHint:
    'Für ein gemischtes Diagramm sind zwei oder mehr Kennzahlfelder erforderlich.',
  chartDefaultSeriesLabel: 'Wert',
  chartEmptyCategoryLabel: '(leer)',
  chartOtherBucketLabel: 'Sonstige',
  chartHeatmapRequiresFieldsHint:
    'Die Heatmap erfordert Felder für Spaltenachse, Zeilenachse und Wert.',
  chartFunnelRequiresFieldsHint: 'Das Trichterdiagramm erfordert ein Phasenfeld und ein Wertfeld.',
  chartSankeyRequiresFieldsHint: 'Das Sankey-Diagramm erfordert Quell-, Ziel- und Wertfelder.',
  chartGanttRequiresFieldsHint:
    'Das Gantt-Diagramm erfordert ein Beschriftungsfeld sowie Felder für Start- und Enddatum.',
  chartGanttDurationLabel: 'Dauer:',
  chartGanttDurationDays: (days) => `${days} T`,
  chartGanttDurationHours: (hours) => `${hours} Std.`,
  chartCrossFilterFilteredOutLabel: 'gefiltert',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Verwenden Sie die Registerkarte Konfiguration, um ein ${fieldLabel.toLowerCase()} und ein Wertefeld auszuwählen.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'Zeilen-/Spaltenüberschrift',
  pivotBlankValueLabel: '(leer)',
  pivotTotalLabel: 'Gesamt',

  // Expression dialog
  exprDialogEditTitle: 'Berechnetes Feld bearbeiten',
  exprDialogNewTitle: 'Neues berechnetes Feld',

  // Expression field — measure checkbox
  exprMeasureLabel: 'Maß (Aggregation)',
  exprMeasureHelperText:
    'Berechnet einen einzelnen Wert über den gesamten Datensatz (z. B. Gesamtumsatz).',
  exprDimensionHelperText: 'Berechnen Sie einen Wert pro Zeile (z. B.: Preis × Menge).',

  // Chart color scheme options
  chartColorSchemePrimary: 'Primär (blau)',
  chartColorSchemeSuccess: 'Erfolg (grün)',
  chartColorSchemeWarning: 'Achtung (orange)',
  chartColorSchemeError: 'Fehler (rot)',

  // AI chat suggestions
  aiSuggestionBarChart: (numericLabel, catLabel) =>
    `Balkendiagramm: ${numericLabel} nach ${catLabel}`,
  aiSuggestionKpi: (fieldLabel) => `KPI: Gesamtwert von ${fieldLabel}`,
  aiSuggestionTable: (sourceLabel) => `Tabelle für ${sourceLabel}`,
  aiSuggestionChangeToLine: (widgetTitle) => `„${widgetTitle}“ in ein Liniendiagramm ändern`,
  aiSuggestionAddSparkline: (widgetTitle) => `Sparkline zu „${widgetTitle}“ hinzufügen`,
  aiSuggestionAddDateFilter: 'Datumsfilter hinzufügen',
  aiSuggestionAddPage: 'Neue Seite hinzufügen',
  aiSuggestionSummarisePage: 'Seite zusammenfassen',
  aiSuggestionWhatDataAvailable: 'Welche Daten sind verfügbar?',
  aiSuggestionBarChartPrompt: (numericLabel, catLabel, sourceLabel) =>
    `Füge ein Balkendiagramm hinzu, das ${numericLabel} nach ${catLabel} aus den Daten von ${sourceLabel} zeigt.`,
  aiSuggestionKpiPrompt: (fieldLabel, sourceLabel) =>
    `Füge eine KPI-Karte hinzu, die den Gesamtwert von ${fieldLabel} aus ${sourceLabel} zeigt.`,
  aiSuggestionTablePrompt: (sourceLabel) =>
    `Füge eine Datentabelle hinzu, die Datensätze aus ${sourceLabel} zeigt.`,
  aiSuggestionChangeToLinePrompt: (widgetTitle) =>
    `Ändere das Widget „${widgetTitle}“ in ein Liniendiagramm.`,
  aiSuggestionAddSparklinePrompt: (widgetTitle) =>
    `Füge dem KPI-Widget „${widgetTitle}“ eine Sparkline hinzu.`,
  aiSuggestionAddDateFilterPrompt: 'Füge dem Dashboard ein Datumsbereichsfilter-Widget hinzu.',
  aiSuggestionAddPagePrompt: 'Erstelle eine neue Dashboard-Seite.',
  aiSuggestionSummarisePagePrompt:
    'Gib mir eine Management-Zusammenfassung der wichtigsten Erkenntnisse dieser Seite — konzentriere dich auf die Daten, Trends und Auffälligkeiten statt auf die Seitenstruktur.',
  aiSuggestionWhatDataAvailablePrompt:
    'Welche Datenquellen und Felder stehen zum Erstellen dieses Dashboards zur Verfügung?',
  chatNewConversationName: 'Neues Gespräch',
  chatSwitchConversationTooltip: 'Unterhaltung wechseln',
  chatNoConversationsLabel: 'Noch keine Gespräche',
  aiInsightSummaryPrompt: (widgetTitle) =>
    `Gib mir eine übergeordnete Zusammenfassung des Widgets „${widgetTitle}“ in 2–3 Sätzen — was es zeigt und die wichtigste Erkenntnis. Fasse dich kurz, keine Aufzählungspunkte.`,
  aiInsightAnalysisPrompt: (widgetTitle) =>
    `Analysiere das Widget „${widgetTitle}“ — nenne die wichtigsten Trends, Muster und auffälligen Werte`,
  aiInsightForecastPrompt: (widgetTitle) =>
    `Erstelle eine Prognose für das Widget „${widgetTitle}“ — welchen Trend erwartest du in den nächsten Perioden?`,
  aiInsightCorrelationPrompt: (widgetTitle) =>
    `Zeige eine Korrelationsanalyse für das Widget „${widgetTitle}“`,
  aiAnomalyExplainPrivatePrompt: (widgetTitle, count) =>
    `Erkläre ${count === 1 ? 'die Auffälligkeit' : `die ${count} Auffälligkeiten`}, die im Widget „${widgetTitle}“ erkannt ${count === 1 ? 'wurde' : 'wurden'}. Die zugrunde liegenden Datenwerte werden zurückgehalten (privater Modus); überlege dir mögliche Ursachen in allgemeiner Form.`,
  aiAnomalyExplainPrompt: (widgetTitle, details) =>
    `Erkläre die im Widget „${widgetTitle}“ erkannten Auffälligkeiten:\n${details}`,
  aiAnomalyDetailLine: (axisLabel, value, annotationLabel) =>
    `- Auffälligkeit auf der ${axisLabel} bei ${value}${annotationLabel ? ` (${annotationLabel})` : ''}`,
  aiAnomalyAxisX: 'X-Achse',
  aiAnomalyAxisY: 'Y-Achse',
  chatUserDisplayName: 'Sie',
  chatComposerPlaceholder: 'Wie kann ich helfen?',
  chatEmptyStateTitle: 'Fragen Sie mich alles zu Ihrem Dashboard',
  chatEmptyStateSubtitle: 'Ich kann Widgets hinzufügen, Ihre Daten analysieren und mehr',
  chatVoiceInputStart: 'Spracheingabe starten',
  chatVoiceInputStop: 'Stoppen Sie die Spracheingabe',
  chatMessageCopyTooltip: 'Kopieren',
  chatMessageCopiedTooltip: 'Kopiert!',
  chatMessageCopyAriaLabel: 'Nachricht kopieren',
  chatMessageRetryTooltip: 'Erneut versuchen',
  chatReasoningThinkingLabel: 'Denke nach…',
  chatReasoningSectionLabel: 'Begründung',
  chatComposerStopGeneratingLabel: 'Generierung stoppen',
  chatComposerSendMessageLabel: 'Nachricht senden',
  chatMessageTokenCount: (count) => `${count.toLocaleString('de')} Token`,
  chatMessageTurnCount: (count) => `${count} ${count === 1 ? 'Durchlauf' : 'Durchläufe'}`,

  // AI chat tool-call card titles
  chatToolLabelGetDashboardState: 'Dashboard-Status abrufen',
  chatToolLabelListPages: 'Seiten auflisten',
  chatToolLabelSetDashboardTitle: 'Dashboard-Titel festlegen',
  chatToolLabelAddPage: 'Seite hinzufügen',
  chatToolLabelRenamePage: 'Seite umbenennen',
  chatToolLabelRemovePage: 'Seite entfernen',
  chatToolLabelSetActivePage: 'Seite wechseln',
  chatToolLabelAddWidget: 'Widget hinzufügen',
  chatToolLabelUpdateWidget: 'Widget aktualisieren',
  chatToolLabelRemoveWidget: 'Widget entfernen',
  chatToolLabelSetWidgetLayout: 'Widget-Layout festlegen',
  chatToolLabelSetWidgetWidth: 'Widget-Breite festlegen',
  chatToolLabelSetWidgetForecast: 'Widget-Prognose festlegen',
  chatToolLabelAddPageFilter: 'Seitenfilter hinzufügen',
  chatToolLabelRemovePageFilter: 'Seitenfilter entfernen',
  chatToolLabelAddWidgetFilter: 'Widget-Filter hinzufügen',
  chatToolLabelRemoveWidgetFilter: 'Widget-Filter entfernen',
  chatToolLabelSummarisePage: 'Seite zusammenfassen',
  chatToolLabelApplyBulkUpdate: 'Massenaktualisierung anwenden',
  chatToolLabelRenameThread: 'Unterhaltung umbenennen',
  chatToolLabelQueryDataSource: 'Datenquelle abfragen',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Diese Diagrammkonfiguration verwendet Felder, die in der Widget-Quelle oder einer direkt zugehörigen Quelle nicht verfügbar sind.',
  chartUnsupportedMixedCrossSource:
    'Diese Diagrammkonfiguration mischt Felder aus verschiedenen Quellen auf eine Weise, die noch kein einziges sicheres Aggregationskorn aufweist.',
  chartUnsupportedScatterCrossSource:
    'Streudiagramme unterstützen noch keine Kombinationen von Feldern über mehrere Quellen hinweg.',
  chartUnsupportedMeasure:
    'Ein Kennzahlenfeld hat keinen Wert je Zeile. Es kann daher nur als Wert eines Diagramms verwendet werden – nie als Kategorieachse, Aufteilung, Farbe oder Größe – und in Streu- und Gantt-Diagrammen, die eine Markierung je Rohzeile zeichnen, überhaupt nicht.',
  chartUnsupportedDefault: 'Diese Diagrammkonfiguration wird noch nicht unterstützt.',
  chartForecastSeriesLabel: 'Vorhersage',

  // Grid summary labels
  gridSummaryLabelSum: 'Gesamt:',
  gridSummaryLabelAvg: 'Durchschnitt:',
  gridSummaryLabelCount: 'Anzahl:',
  gridSummaryLabelCountDistinct: 'Einzigartig:',
  gridSummaryLabelMin: 'Min.:',
  gridSummaryLabelMax: 'Maximal:',
  gridMutationError: 'Änderungen konnten nicht gespeichert werden',

  // Auto-generated widget titles
  widgetAutoTitleChart: 'Grafik',
  widgetAutoTitleKpi: 'KPI',
  widgetAutoTitleTable: 'Tabelle',
  widgetAutoTitleFilter: 'Filter',
  widgetAutoTitlePivot: 'Pivot-Tabelle',
  widgetAutoTitleMap: 'Karte',
  widgetAutoTitleDefault: 'Widget',
  widgetAutoTitleVs: 'vs',
  widgetAutoTitleBy: 'setzen',
  widgetAutoTitleSplitBy: 'geteilt durch',
  widgetAutoTitleByCountry: 'nach Ländern',
  widgetAutoTitleSourceSuffixChart: 'Grafik',
  widgetAutoTitleSourceSuffixKpi: 'KPI',
  widgetAutoTitleSourceSuffixPivot: 'dynamisch',
  widgetAutoTitleSourceSuffixMap: 'Karte',
  widgetAutoTitleFilterPrefix: 'Filter',
  widgetAggPrefixSum: 'Insgesamt',
  widgetAggPrefixAvg: 'Durchschnittlich von',
  widgetAggPrefixCount: 'Anzahl von',
  widgetAggPrefixMin: 'Min.',
  widgetAggPrefixMax: 'Max.',
  widgetAggPrefixCountDistinct: 'Unterscheidet sich von',
  widgetGroupByPrefixDay: 'Täglich',
  widgetGroupByPrefixWeek: 'Wöchentlich',
  widgetGroupByPrefixMonth: 'Monatlich',
  widgetGroupByPrefixQuarter: 'Vierteljährlich',
  widgetGroupByPrefixYear: 'Jährlich',
  widgetAutoTitleMoreFields: (count) => `+${count} weitere`,

  // Date filter labels
  dateFilterLast: (amount, unit) => `Letzte ${amount} ${unit}`,
  dateFilterNext: (amount, unit) => `Nächste ${amount} ${unit}`,
  dateFilterFrom: (date) => `Ab ${date}`,
  dateFilterUpTo: (label) => `Bis ${label}`,
  dateFilterSince: (date) => `Seit ${date}`,
  dateFilterUntil: (date) => `Bis ${date}`,
  dateFilterUnitYear: 'Jahr',
  dateFilterUnitYears: 'Jahre',
  dateFilterUnitMonth: 'Monat',
  dateFilterUnitMonths: 'Monate',
  dateFilterUnitWeek: 'Woche',
  dateFilterUnitWeeks: 'Wochen',
  dateFilterUnitDay: 'Tag',
  dateFilterUnitDays: 'Tage',
  dateFilterUnitHour: 'Zeit',
  dateFilterUnitHours: 'Std.',
  dateFilterUnitMinute: 'Minute',
  dateFilterUnitMinutes: 'Minuten',
  dateFilterUnitSecond: 'Sekunde',
  dateFilterUnitSeconds: 'Sekunden',

  // Widget delete confirmation dialog
  widgetDeleteConfirmTitle: 'Widget löschen?',
  widgetDeleteConfirmMessage: 'Dieses Widget wird dauerhaft von der Seite entfernt.',
  widgetDeleteConfirmOk: 'Löschen',
  widgetDeleteConfirmCancel: 'Abbrechen',

  // Canvas empty state
  canvasEmptyTitle: 'Die Arbeitsfläche ist leer',
  canvasEmptyEditModeHint:
    'Verwenden Sie das Erstellen-Panel, um Widgets hinzuzufügen, oder ziehen Sie sie hierher.',
  canvasEmptyViewModeHint: 'Wechseln Sie in den Bearbeitungsmodus, um Widgets hinzuzufügen.',

  // Map widget legend
  mapLegendAriaLabel: (fieldLabel, min, max) => `Farbskala für ${fieldLabel} von ${min} bis ${max}`,

  // Date range presets (calendar year / quarter)
  dateRangePresetThisCalendarYear: 'Dieses Jahr',
  dateRangePresetLastCalendarYear: 'Letztes Jahr',
  dateRangePresetLast2CalendarYears: 'Letzte 2 Jahre',
  dateRangePresetThisQuarter: 'Dieses Quartal',
  dateRangePresetLastQuarter: 'Letztes Quartal',
  dateRangePresetThisAndLastQuarter: 'Dieses & letztes Quartal',
  dateRangePresetCustom: 'Benutzerdefiniert',
  dateRangePresetGroupRolling: 'Gleitend',
  dateRangePresetGroupCalendarYear: 'Kalenderjahr',
  dateRangePresetGroupQuarter: 'Quartal',

  // Filters drawer (default view)
  filtersDefaultViewLabel: 'Standardansicht',

  // Quick filter bar
  quickFilterBarEnableFilter: 'Filter aktivieren',
  quickFilterBarDisableFilter: 'Filter deaktivieren',
  quickFilterBarRemoveFilter: 'Filter entfernen',

  // Cross-filter mode bar
  crossFilterBarModeFilter: 'Filter',
  crossFilterBarModeHighlight: 'Hervorheben',
  crossFilterBarModePerChart: 'Pro Diagramm',
  crossFilterBarAllPages: 'Alle Seiten',

  // Chart setup panel
  aggregationLockedHelperText:
    'Zählt Zeilen — wählen Sie ein Wertfeld aus, um zu summieren, zu mitteln usw.',

  // Funnel setup
  chartSetupFunnelLabelFormatLabel: 'Beschriftungsformat',
  chartSetupFunnelLabelFormatValue: 'Wert',
  chartSetupFunnelLabelFormatPercent: '% der Gesamtmenge',
  chartSetupFunnelLabelFormatConversion: 'Konversionsrate',
  chartSetupFunnelLabelPlacementLabel: 'Beschriftungsposition',
  chartSetupFunnelLabelPlacementInside: 'Innen',
  chartSetupFunnelLabelPlacementOutsideStart: 'Außen links',
  chartSetupFunnelLabelPlacementOutsideEnd: 'Außen rechts',
  chartSetupFunnelGapLabel: 'Abschnittsabstand (px)',
  chartSetupFunnelShapeLabel: 'Form',
  chartSetupFunnelShapeLinear: 'Linear',
  chartSetupFunnelShapeBump: 'Gebogen (Bump)',
  chartSetupFunnelShapeStep: 'Stufe',
  chartSetupFunnelShapePyramid: 'Pyramide',
  chartSetupFunnelStyleLabel: 'Stil',
  chartSetupFunnelStyleFilled: 'Gefüllt',
  chartSetupFunnelStyleOutlined: 'Umrandet',

  // Sankey setup
  chartSetupSankeySourceLabel: 'Quellfeld (von)',
  chartSetupSankeySourceHelperText: 'Kategorisches Feld für den Startknoten jedes Flusses',
  chartSetupSankeyTargetLabel: 'Zielfeld (nach)',
  chartSetupSankeyTargetHelperText: 'Kategorisches Feld für den Endknoten jedes Flusses',
  chartSetupSankeyValueHelperText: 'Numerisches Feld, summiert pro Quelle-→-Ziel-Verbindung',
  chartSetupSankeyLinkColorLabel: 'Verbindungsfarbe',
  chartSetupSankeyLinkColorSource: 'Vom Quellknoten',
  chartSetupSankeyLinkColorTarget: 'Vom Zielknoten',
  chartSetupSankeyShowValuesLabel: 'Werte auf Verbindungen anzeigen',

  // Pie/donut & funnel category fields
  chartSetupXFieldPieDonutLabel: 'Segmentkategorie',
  chartSetupXFieldPieDonutHelperText: 'Jeder eindeutige Wert wird zu einem Segment',
  chartSetupXFieldFunnelLabel: 'Phasenfeld',
  chartSetupXFieldFunnelHelperText: 'Kategorisches Feld, das jede Trichterphase definiert',
  chartSetupYMeasurePieDonutLabel: 'Segmentwert',
  chartSetupFieldlessCountSplitByTooltip:
    'Wählen Sie ein Kennzahlenfeld aus, um „Aufteilen nach“ zu aktivieren',
  chartSetupSplitByFieldlessCountHelperText:
    'Nicht verfügbar für eine feldlose Zählung — wählen Sie zuerst ein Kennzahlenfeld',

  // KPI setup panel
  kpiSetupDateRangePresetLabel: 'Bereich',

  // Map setup panel
  mapSetupValueFieldHelperText: 'Leer lassen, um Zeilen zu zählen',
  mapSetupInteractionsTitle: 'Interaktionen',
  mapSetupInteractionsDescription: 'Wenn andere Widgets angeklickt werden, reagiert diese Karte…',

  // Text setup panel
  textSetupPromptLabel: 'Prompt',
  textSetupPromptHelper:
    'Beschreiben Sie, was die KI schreiben soll — sie kann die Datenquellen auf dieser Seite abfragen',
  textSetupAiModeLabel: 'KI-Modus',

  // Accessible names for otherwise-unlabeled form controls
  exprNodeKindAriaLabel: 'Eingabetyp',
  exprFieldAriaLabel: 'Feld',
  exprAggregationAriaLabel: 'Aggregation',
  exprLiteralTypeAriaLabel: 'Literaltyp',
  exprBooleanValueAriaLabel: 'Boolescher Wert',
  filterRankDirectionAriaLabel: 'Rangfolge-Richtung',
  filterRankCountLabel: 'Anzahl der Elemente',
  filterSliderMinimumAriaLabel: (label) => `${label} Minimum`,
  filterSliderMaximumAriaLabel: (label) => `${label} Maximum`,
  filterRelativeDateUnitAriaLabel: 'Zeiteinheit',
  filterRelativeDateDirectionAriaLabel: 'Richtung',
  filterDateModeAriaLabel: 'Datumswertetyp',
  formulaOperatorAriaLabel: 'Operator',
  chartAnnotationAxisAriaLabel: 'Referenzlinienachse',
  gridConditionFieldAriaLabel: 'Bedingungsfeld',
  gridConditionOperatorAriaLabel: 'Bedingungsoperator',
  gridConditionStyleAriaLabel: 'Bedingungsstil',
  gridConditionValueAriaLabel: 'Bedingungswert',

  // KPI trend sentiment (screen-reader only)
  kpiTrendFavorableLabel: 'günstig',
  kpiTrendUnfavorableLabel: 'ungünstig',
  kpiTrendNoChangeLabel: 'keine Änderung',

  // Canvas accessibility
  canvasResizeColumnsAriaLabel: 'Spaltengröße ändern',
  canvasMoveWidgetUpAriaLabel: 'Widget nach oben verschieben',
  canvasMoveWidgetDownAriaLabel: 'Widget nach unten verschieben',
  canvasMoveWidgetLeftAriaLabel: 'Widget nach links verschieben',
  canvasMoveWidgetRightAriaLabel: 'Widget nach rechts verschieben',
  gridColumnMoveUpAriaLabel: 'Spalte nach oben verschieben',
  gridColumnMoveDownAriaLabel: 'Spalte nach unten verschieben',
  canvasRegionAriaLabel: 'Dashboard-Bereich',
  sidebarPanelOpenedAnnouncement: (label) => `Bereich ${label} geöffnet`,
  sidebarPanelClosedAnnouncement: 'Bereich geschlossen',
  canvasResizeAnnouncement: (span, total) => `Spalte auf ${span} von ${total} geändert`,
  canvasWidgetMovedAnnouncement: 'Widget verschoben',
  canvasWidgetAddedAnnouncement: 'Widget hinzugefügt',

  // Chart / KPI / map text alternatives
  ganttChartAriaLabel: (itemCount, from, to, details) =>
    `Gantt-Diagramm mit ${itemCount} ${itemCount === 1 ? 'Element' : 'Elementen'} von ${from} bis ${to}. ${details}.`,
  ganttItemAriaLabel: (label, from, to, duration) => `${label}: ${from} bis ${to} (${duration})`,
  sankeyLinkAriaLabel: (source, target, value) => `${source} bis ${target}: ${value}`,
  sankeyChartAriaLabel: (nodeCount, linkCount, details) =>
    `Sankey-Flussdiagramm mit ${nodeCount} ${nodeCount === 1 ? 'Knoten' : 'Knoten'} und ${linkCount} ${linkCount === 1 ? 'Verbindung' : 'Verbindungen'}. ${details}.`,
  mapRegionAriaLabel: (region, valueLabel, value) => `${region}: ${valueLabel} ${value}`,
  kpiGaugeAriaLabel: (value, max, percent) => `Anzeige: ${value} von ${max} (${percent} %).`,
  kpiSparklineAriaLabel: (pointCount, trend, from, to) => {
    let trendText = 'unverändert';
    if (trend === 'up') {
      trendText = 'steigend';
    } else if (trend === 'down') {
      trendText = 'fallend';
    }
    return `Sparkline mit ${pointCount} Punkten, ${trendText}, von ${from} bis ${to}.`;
  },
  mapChartAriaLabel: (measure, regionCount, min, max) =>
    `Choroplethenkarte${measure ? ` von ${measure}` : ''} mit ${regionCount} ${regionCount === 1 ? 'Region' : 'Regionen'}, Werte von ${min} bis ${max}.`,
  lineageGraphAriaLabel: (sourceCount, relationshipCount) =>
    `Datenbeziehungsdiagramm mit ${sourceCount} ${sourceCount === 1 ? 'Quelle' : 'Quellen'} und ${relationshipCount} ${relationshipCount === 1 ? 'Beziehung' : 'Beziehungen'}.`,
};

export const de: Localization = getStudioLocalization(deLocaleText);

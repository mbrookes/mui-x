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
  widgetConfigureMapHint:
    'Verwenden Sie die Registerkarte „Konfigurieren“, um das Länderfeld und das Wertefeld auszuwählen.',
  widgetNoData: 'Keine Daten',
  widgetLoadError: 'Daten konnten nicht geladen werden',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Filterbereich öffnen',
  quickFilterBarClearAll: 'Alle Seitenfilter löschen',
  quickFilterBarFiltered: 'Gefiltert',
  dateRangeBarFieldLabel: 'Datumsbereich',

  // Widget card actions
  widgetEditTooltip: 'Widget bearbeiten',
  widgetExportCsvTooltip: 'Als CSV exportieren',
  widgetExportPngTooltip: 'Als PNG exportieren',
  widgetExpandTooltip: 'Diagramm erweitern',
  widgetMoveToPageLabel: 'Auf Seite verschieben',
  widgetDuplicateTooltip: 'Widget duplizieren',
  widgetDeleteTooltip: 'Widget löschen',
  widgetAiAssistantTooltip: 'KI-Assistent',
  widgetAiInsightTooltip: 'KI-Einblick',
  widgetDetectAnomalyTooltip: 'Anomalien erkennen',
  widgetHideAnomalyTooltip: 'Anomalien verbergen',
  widgetExplainAnomalyTooltip: 'Erklären Sie Anomalien',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Konfigurieren',
  widgetEditDialogTabFilters: 'Filter',
  widgetEditDialogTabFormat: 'Format',
  widgetEditDialogCloseAriaLabel: 'Bearbeitungsdialog schließen',
  widgetUntitledLabel: (kindLabel) => `${kindLabel} ohne Titel`,

  // AI assistant
  aiAssistantOpenTooltip: 'KI-Assistent öffnen',
  aiAssistantCloseTooltip: 'KI-Assistent schließen',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Widget-Konfiguration schließen',
  sidebarPanelsAriaLabel: 'Seitenleistenbereiche',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Erhöhen',
  numberFieldDecreaseAriaLabel: 'Verringern',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Erweitertes Diagramm schließen',
  widgetCardExportPngAriaLabel: 'Exportieren Sie das erweiterte Diagramm als PNG',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Beschreiben Sie ein Widget',
  aiCreateWidgetPlaceholder: 'z. B.: Balkendiagramm mit Umsatz nach Land, Gesamtauftrags-KPI …',
  aiCreateWidgetButton: 'Erstellen',
  aiCreateWidgetLoading: 'Erstellen…',
  aiCreateWidgetError: 'Widget konnte nicht erstellt werden',

  // AI dashboard summary panel
  aiSummaryTitle: 'Dashboard-Zusammenfassung',
  aiSummarizeTooltip: 'Dashboard zusammenfassen',
  aiRegenerateTooltip: 'Regenerieren',
  aiCopyTooltip: 'Kopieren',
  aiCopiedTooltip: 'Kopiert!',
  aiCloseTooltip: 'Schließen',

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
  composeDrawerTabSetup: 'Konfigurieren',
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
  textFormatSerifFont: 'Serife',
  textFormatMonospaceFont: 'Monospaced',
  textFormatDefaultSize: 'Standard',
  textFormatAlignmentLabel: 'Ausrichtung',

  // Data drawer
  dataDrawerNoSources:
    'Keine Datenquellen konfiguriert. Fügen Sie dem Dashboard ein Widget hinzu, um Beispieldaten zu laden.',
  dataDrawerViewLineage: 'Datenherkunft anzeigen',
  dataDrawerLineageTitle: 'Datenherkunft',
  dataDrawerLineageHelper:
    'Klicken Sie auf einen Knoten, um dessen Daten anzuzeigen. Klicken Sie auf eine Kante, um die Join-Schlüsselfelder zu überprüfen.',
  dataDrawerRowsLabel: 'Linien',
  dataDrawerFieldsLabel: 'Felder',
  dataDrawerBackAriaLabel: 'Zurück zum Abstammungsdiagramm',
  dataDrawerCloseAriaLabel: 'Schließen Sie die Datenherkunft',
  dataDrawerEditTooltip: 'Bearbeiten',
  dataDrawerDeleteTooltip: 'Löschen',
  dataDrawerViewSourceTooltip: 'Quelldaten anzeigen',
  dataDrawerAddCalculatedField: 'Berechnetes Feld hinzufügen',
  dataDrawerNoData: (sourceLabel) => `Keine Daten für ${sourceLabel} verfügbar.`,
  dataDrawerMoreRows: (count) => `${count} weitere Zeile${count === 1 ? '' : 'n'}`,
  dataDrawerMoreColumns: (count) => `${count} weitere Spalte${count === 1 ? '' : 'n'}`,
  dataDrawerViewSourceLink: 'Quelldaten anzeigen →',
  dataDrawerMorePreviewRows: (count) => `+${count} weitere`,
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
  chartSetupCalculatedField: 'Berechnetes Feld…',
  chartSetupCategoryFieldLabel: 'Kategoriefeld',
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
  kpiSetupGaugeMaxLabel: 'Messgerät Max',
  kpiSetupTrendLabel: 'Trend',
  kpiSetupDateRangeLabel: 'Datumsbereich',
  kpiSetupDateRangeFieldLabel: 'Datumsfeld',
  kpiSetupCompPeriodLabel: 'Vergleichszeitraum',
  kpiSetupDateAggEarliest: 'Früher',
  kpiSetupDateAggLatest: 'Später',
  kpiSetupFillAreaLabel: 'Bereich füllen',
  kpiSetupCumulativeLabel: 'Kumulativ (kumulierte Summe)',
  kpiSetupAutoDateFilterPrefix: 'Datumsfilter verwenden:',
  kpiSetupCalculatedField: 'Berechnetes Feld…',
  kpiSetupInvertColours: 'Farben invertieren (kleiner ist besser)',
  kpiSetupFixedWindowLabel: 'Trend window',
  kpiSetupFixedWindowNone: 'From date filter',
  kpiSetupFixedWindowMonth: 'Last 30 days',
  kpiSetupFixedWindowQuarter: 'Last 90 days',
  kpiSetupFixedWindowYear: 'Last 365 days',

  // KPI widget
  kpiGrandTotalTooltip:
    'Gesamtsumme – Aktive Filter-Widgets werden nicht auf diesen KPI angewendet. Aktivieren Sie den Kreuzfiltermodus in den KPI-Einstellungen, um diese zu berücksichtigen.',
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

  // Map setup panel
  mapSetupMapTypeLabel: 'Kartentyp',
  mapSetupValueFieldLabel: 'Wertfeld (optional zum Zählen)',
  mapSetupColourSchemeLabel: 'Farbschema',
  mapSetupLegendPositionLabel: 'Position der Beschriftung',
  mapSetupScaleFromZeroLabel: 'Skalieren Sie von Grund auf',
  mapSetupClickableLabel: 'Anklickbar (Filterschriftart)',
  mapSetupCrossFilterLabel: 'Reagieren Sie auf Kreuzfilter',
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

  // Text setup panel
  textSetupTitleLabel: 'Titel',
  textSetupTitleHelper: 'Kopfzeile wird oben im Widget angezeigt',
  textSetupSubtitleLabel: 'Untertitel',
  textSetupSubtitleHelper: 'Kleinerer Text unter der Überschrift',
  textSetupBodyLabel: 'Körper',
  textSetupBodyHelper: 'Hauptinhalt des Widgets; unterstützt Klartext',

  // Page config panel
  pageConfigPageSectionTitle: 'Seite',
  pageConfigCardsSectionTitle: 'Karten',
  pageConfigBackgroundColourLabel: 'Hintergrundfarbe',
  pageConfigBackgroundColourPlaceholder: 'z.B.: #f5f5f5',
  pageConfigCardBackgroundLabel: 'Kartenhintergrund',
  pageConfigCardBackgroundPlaceholder: 'z.B.: #ffffff',
  pageConfigPaddingLabel: 'Polsterung',
  pageConfigCornerRadiusLabel: 'Eckenradius (px)',
  pageConfigCardBorderLabel: 'Kartenrand',
  pageConfigBorderColourLabel: 'Randfarbe',
  pageConfigBorderColourPlaceholder: 'z.B.: #e0e0e0',
  pageConfigBorderWidthLabel: 'Randbreite (px)',
  pageConfigPaddingNone: 'Keiner',
  pageConfigPaddingSmall: 'Klein (8px)',
  pageConfigPaddingMedium: 'Mittel (16px)',
  pageConfigPaddingLarge: 'Groß (24px)',

  // AI insight panel
  insightTypeSummary: 'Zusammenfassung',
  insightTypeAnalysis: 'Analyse',
  insightTypeForecast: 'Vorhersage',
  insightTypeAnomaly: 'Erklärung der Anomalie',
  insightTypeCorrelation: 'Korrelationsanalyse',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Filter reinigen',
  filterWidgetSelectAllLabel: 'Alles auswählen',
  filterWidgetClearAllLabel: 'Alles löschen',
  filterWidgetAllLabel: 'Alle',
  filterWidgetNoOptionsLabel: 'Keine Optionen gefunden',
  filterWidgetSelectedCount: (count) => `${count} ausgewählt`,
  filterWidgetExcludeLabel: 'Ausgewählte löschen',
  filterWidgetExcludingLabel: '⊘ Ausgewählte löschen',
  filterWidgetDateFromLabel: 'Von',
  filterWidgetDateToLabel: 'Bis',
  filterWidgetNoFieldConfigured:
    'Keine Felder konfiguriert. Wählen Sie im Bedienfeld „Verfassen“ ein Feld aus.',

  // Date range bar
  dateRangePresetAriaLabel: 'Datumsbereich voreingestellt',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Leeres Feld',
  dataSourceAddCalculatedField: 'Berechnetes Feld hinzufügen…',

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

  // Pivot widget
  pivotRowsColumnsLabel: (rowCount, colCount) => `${rowCount} Zeilen × ${colCount} Spalten`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} Zeile${count === 1 ? '' : 'n'} werden nicht angezeigt: Erhöhen Sie die Widget-Höhe, um alle zu sehen`,

  // Color input
  colorInputClearAriaLabel: (label) => `${label.toLowerCase()} löschen`,

  // KPI widget
  kpiTrendNewLabel: 'Neu',
  kpiTrendTargetTooltip: (value) => `Ziel: ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Vorheriger Zeitraum: ${period}`,
  kpiTrendNoDateFilterHint: 'Fügen Sie einen Datumsfilter hinzu, um den Trend anzuzeigen.',
  kpiSparklineNoTimeFieldHint:
    'Fügen Sie einen Datumsfilter hinzu oder wählen Sie ein Zeitfeld aus, um die Sparkline anzuzeigen.',

  // Chart widget
  chartMixedRequiresFieldsHint:
    'Für ein gemischtes Diagramm sind zwei oder mehr Kennzahlfelder erforderlich.',
  chartDefaultSeriesLabel: 'Wert',

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
  chatNewConversationName: 'Neues Gespräch',
  chatSwitchConversationTooltip: 'Unterhaltung wechseln',
  chatVoiceInputStart: 'Spracheingabe starten',
  chatVoiceInputStop: 'Stoppen Sie die Spracheingabe',
  chatVoiceInputNotSupported: 'Die Spracheingabe wird in diesem Browser nicht unterstützt',
  chatMessageCopyTooltip: 'Kopieren',
  chatMessageCopiedTooltip: 'Kopiert!',
  chatMessageCopyAriaLabel: 'Nachricht kopieren',
  chatMessageRetryTooltip: 'Erneut versuchen',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Diese Diagrammkonfiguration verwendet Felder, die in der Widget-Quelle oder einer direkt zugehörigen Quelle nicht verfügbar sind.',
  chartUnsupportedMixedCrossSource:
    'Diese Diagrammkonfiguration mischt Felder aus verschiedenen Quellen auf eine Weise, die noch kein einziges sicheres Aggregationskorn aufweist.',
  chartUnsupportedScatterCrossSource:
    'Streudiagramme unterstützen noch keine Kombinationen von Feldern über mehrere Quellen hinweg.',
  chartUnsupportedDefault: 'Diese Diagrammkonfiguration wird noch nicht unterstützt.',
  chartForecastSeriesLabel: 'Vorhersage',

  // Grid summary labels
  gridSummaryLabelSum: 'Gesamt:',
  gridSummaryLabelAvg: 'Durchschnitt:',
  gridSummaryLabelCount: 'Zählen:',
  gridSummaryLabelCountDistinct: 'Einzigartig:',
  gridSummaryLabelMin: 'Min.:',
  gridSummaryLabelMax: 'Maximal:',

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
};

export const de: Localization = getStudioLocalization(deLocaleText);

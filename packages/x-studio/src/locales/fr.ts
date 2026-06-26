import type { StudioLocaleText } from '../internals/StudioUIConfigContext';
import { getStudioLocalization, type Localization } from './utils/getStudioLocalization';

/**
 * French (fr) locale text for Studio.
 *
 * @example
 * ```tsx
 * import { frLocaleText } from '@mui/x-studio';
 * <Studio localeText={frLocaleText} />
 * ```
 */
export const frLocaleText: Partial<StudioLocaleText> = {
  // Drawers
  dataDrawerTitle: 'Données',
  composeDrawerTitle: 'Composer',
  filtersDrawerTitle: 'Filtres',

  // Date range presets
  dateRangePresetAllTime: 'Toute la période',
  dateRangePresetYTD: 'Année en cours',
  dateRangePresetThisMonth: 'Ce mois-ci',
  dateRangePresetLast3Months: '3 derniers mois',
  dateRangePresetLast12Months: '12 derniers mois',

  // Filters drawer
  filterSearchPlaceholder: 'Rechercher des filtres…',
  filtersSectionPageFiltersTitle: 'Filtres de page',
  filtersSectionNoFilters: 'Aucun filtre appliqué.',
  filtersSectionNoMatchingFilters: 'Aucun filtre correspondant.',
  filtersAddFilterTooltip: 'Ajouter un filtre',
  filtersSavedViewsTitle: 'Vues enregistrées',
  filtersSaveViewTooltip: 'Enregistrer les filtres de page en tant que vue nommée',
  filtersSaveViewButton: 'Enregistrer',
  filtersSaveViewPlaceholder: 'Nom de la vue',
  filtersDeleteViewTooltip: 'Supprimer la vue',
  filtersNoSavedViews: 'Aucune vue enregistrée. Appliquez des filtres et enregistrez ici.',
  filtersAddDataSourceHint: "Ajoutez d'abord une source de données et des widgets.",

  // Widget states
  widgetConfigureChartHint: "Utilisez l'onglet Configurer pour configurer ce graphique.",
  widgetConfigureGaugeHint:
    "Utilisez l'onglet Configurer pour choisir le champ de valeur de la jauge.",
  widgetConfigurePivotHint:
    "Utilisez l'onglet Configurer pour configurer le tableau croisé dynamique.",
  widgetConfigureMapHint:
    "Utilisez l'onglet Configurer pour choisir le champ de pays et le champ de valeur.",
  widgetNoData: 'Aucune donnée',
  widgetLoadError: 'Échec du chargement des données',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Ouvrir le panneau des filtres',
  quickFilterBarCloseFilters: 'Fermer le panneau des filtres',
  quickFilterBarClearAll: 'Effacer tous les filtres',
  quickFilterBarFiltered: 'Filtré',
  dateRangeBarFieldLabel: 'Plage de dates',

  // Widget card actions
  widgetEditTooltip: 'Modifier le widget',
  widgetExportCsvTooltip: 'Exporter au format CSV',
  widgetExportPngTooltip: 'Exporter au format PNG',
  widgetExpandTooltip: 'Agrandir le graphique',
  widgetMoveToPageLabel: 'Déplacer vers la page',
  widgetDuplicateTooltip: 'Dupliquer le widget',
  widgetDeleteTooltip: 'Supprimer le widget',
  widgetAiAssistantTooltip: 'Assistant IA',
  widgetAiInsightTooltip: "Aperçu de l'IA",
  widgetDetectAnomalyTooltip: 'Détecter les anomalies',
  widgetHideAnomalyTooltip: 'Masquer les anomalies',
  widgetExplainAnomalyTooltip: 'Expliquer les anomalies',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Configurer',
  widgetEditDialogTabFilters: 'Filtres',
  widgetEditDialogTabFormat: 'Format',
  widgetEditDialogCloseAriaLabel: "Fermer la boîte de dialogue d'édition",
  widgetUntitledLabel: (kindLabel) => `${kindLabel} sans titre`,

  // AI assistant
  aiAssistantOpenTooltip: "Ouvrir l'assistant IA",
  aiAssistantCloseTooltip: "Fermer l'assistant IA",
  aiCloseTooltip: 'Fermer',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Fermer la configuration du widget',
  sidebarPanelsAriaLabel: 'Panneaux latéraux',

  // NumberField
  numberFieldIncreaseAriaLabel: 'Augmenter',
  numberFieldDecreaseAriaLabel: 'Diminuer',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Fermer le graphique développé',
  widgetCardExportPngAriaLabel: 'Exporter le graphique développé au format PNG',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Décrire un widget',
  aiCreateWidgetPlaceholder:
    "Ex. : Graphique à barres montrant le chiffre d'affaires par pays, le KPI des commandes totales…",
  aiCreateWidgetButton: 'Créer',
  aiCreateWidgetLoading: 'Création…',
  aiCreateWidgetError: 'Échec de la création du widget',

  // Widget type names
  widgetKindGrid: 'Tableau',
  widgetKindChart: 'Graphique',
  widgetKindKpi: 'KPI',
  widgetKindText: 'Texte',
  widgetKindFilter: 'Filtre',
  widgetKindPivot: 'Tableau croisé dynamique',
  widgetKindMap: 'Carte',

  // Widget type descriptions
  widgetKindTextDescription: 'Titre, sous-titre et corps du texte',
  widgetKindKpiDescription: 'Métrique unique avec agrégation',
  widgetKindChartDescription: 'Visualisez les données avec un graphique configurable',
  widgetKindGridDescription: 'Grille de données avec tri et filtrage',
  widgetKindFilterDescription: 'Contrôle de filtre interactif pour le mode aperçu',
  widgetKindPivotDescription: 'Tableau croisé avec dimensions de lignes et de colonnes',
  widgetKindMapDescription: 'Carte choroplèthe mondiale par pays',
  composeCustomWidgetDescription: 'Widget personnalisé',

  // Data type labels
  dataTypeString: 'Texte',
  dataTypeNumber: 'Nombre',
  dataTypeBoolean: 'Booléen',
  dataTypeDate: 'Date',
  dataTypeDatetime: 'Date et heure',

  // Compose drawer / widget picker
  composeDrawerTabSetup: 'Configurer',
  composeChooseWidgetType: 'Choisissez un type de widget',
  composeNoDataSources:
    'Aucune source de données disponible. Seuls des widgets de texte peuvent être ajoutés.',
  composeOnThisPage: 'Sur cette page',
  composeAddWidgetLabel: (widgetTypeLabel) => `Ajouter le widget ${widgetTypeLabel}`,
  composeCloseAriaLabel: 'Fermer',
  composeBackToWidgetTypesAriaLabel: 'Retour aux types de widgets',
  composeCancel: 'Annuler',

  // Format panel
  formatAutoTitle: 'Titre généré automatiquement',
  formatResetTitle: 'Réinitialiser au titre généré automatiquement',
  formatAutoSubtitle: 'Sous-titre généré automatiquement',
  formatResetSubtitle: 'Réinitialiser les sous-titres générés automatiquement',
  formatPanelCompactNumbers: 'Nombres compacts',
  formatPanelWidgetTitleLabel: 'Titre du widget',
  formatPanelWidgetTitleHelperText: "Affiché dans l'en-tête du widget",
  formatPanelSubtitleLabel: 'Légende',
  formatPanelSubtitleHelperText: 'Ligne facultative affichée sous le titre',

  // Text format panel
  textFormatFontFamilyLabel: 'Famille de polices',
  textFormatFontSizeLabel: 'Taille de la police',
  textFormatColorLabel: 'Couleur',
  textFormatColorPlaceholder: 'Standard',
  textFormatAlignLeftAriaLabel: 'Aligner à gauche',
  textFormatAlignCenterAriaLabel: 'Centraliser',
  textFormatAlignRightAriaLabel: 'Aligner à droite',
  textFormatDefaultFont: 'Par défaut (thème)',
  textFormatSansSerifFont: 'Sans-serif',
  textFormatSerifFont: 'Serif',
  textFormatMonospaceFont: 'Monospace',
  textFormatDefaultSize: 'Standard',
  textFormatAlignmentLabel: 'Alignement',

  // Data drawer
  dataDrawerNoSources:
    'Aucune source de données configurée. Ajoutez un widget au tableau de bord pour charger des exemples de données.',
  dataDrawerViewLineage: 'Afficher le traçage des données',
  dataDrawerLineageTitle: 'Lignage des données',
  dataDrawerLineageHelper:
    'Cliquez sur un nœud pour afficher ses données. Cliquez sur un bord pour inspecter les champs clés de jointure.',
  dataDrawerRowsLabel: 'lignes',
  dataDrawerFieldsLabel: 'champs',
  dataDrawerBackAriaLabel: 'Retour au graphique de lignée',
  dataDrawerCloseAriaLabel: 'Fermer le lignage des données',
  dataDrawerEditTooltip: 'Modifier',
  dataDrawerDeleteTooltip: 'Supprimer',
  dataDrawerViewSourceTooltip: 'Afficher les données sources',
  dataDrawerAddCalculatedField: 'Ajouter un champ calculé',
  dataDrawerNoData: (sourceLabel) => `Aucune donnée disponible pour ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} ligne${count === 1 ? '' : 's'} de plus`,
  dataDrawerMoreColumns: (count) => `${count} colonne${count === 1 ? '' : 's'} de plus`,
  dataDrawerViewSourceLink: 'Afficher les données sources →',
  dataDrawerMorePreviewRows: (count) => `+${count} de plus`,
  lineageTypePrefix: (type) => `Type : ${type}`,
  lineageJoinDetail: (srcSource, srcField, tgtSource, tgtField) =>
    `Jointure : ${srcSource}.${srcField} = ${tgtSource}.${tgtField}`,
  lineageViaDetail: (via) => `Via : ${via}`,
  lineagePreviewAriaLabel: (label) => `Aperçu de ${label}`,
  lineageNoRelationships: 'Aucune relation définie entre les sources',

  // Relationship management
  relationshipEditTooltip: 'Modifier',
  relationshipRemoveTooltip: 'Retirer',
  relationshipCancel: 'Annuler',
  relationshipTypeManyToOne: 'Plusieurs-à-un',
  relationshipTypeOneToOne: 'En tête-à-tête',
  relationshipTypeManyToMany: 'Plusieurs à plusieurs',
  relationshipTypeLabel: 'Taper',
  relationshipJoinFieldLabel: 'Champ de jonction',
  relationshipJunctionTableLabel: 'Table de jonction (pont)',
  relationshipJunctionSourceLabel: 'Source de jonction',
  relationshipJunctionSourceFkLabel: "→ FK d'origine",
  relationshipJunctionTargetFkLabel: '→ Destination FK',
  relationshipAddTitle: 'Ajouter une relation',
  relationshipEditTitle: 'Modifier la relation',
  relationshipSourceManyLabel: 'Côté plusieurs',
  relationshipSourceLabel: 'Origine',
  relationshipTargetOneLabel: 'Côté un',
  relationshipTargetLabel: 'Destination',
  relationshipUpdate: 'Mettre à jour',
  relationshipAdd: 'Pour ajouter',
  relationshipSectionTitle: 'Relations',
  relationshipAddButton: 'Pour ajouter',
  relationshipNone: 'Aucune relation configurée.',
  relationshipVia: (junctionLabel) => `via ${junctionLabel}`,

  // Filter conditions & values
  filterConditionAnd: 'ET',
  filterConditionOr: 'OU',
  filterOperatorLabel: 'Opérateur',
  filterRemoveSecondCondition: 'Supprimer la deuxième condition',
  filterAbsoluteDate: 'Date absolue',
  filterRelativeDate: 'Date relative',
  filterBooleanTrue: 'VRAI',
  filterBooleanFalse: 'FAUX',
  filterRemoveAriaLabel: 'Supprimer le filtre',
  filterInteractiveSectionTitle: 'Filtres interactifs',
  filterCrossSectionTitle: 'Filtres croisés',
  filterClearFilter: 'Nettoyer le filtre',
  filterClearInteractiveAriaLabel: 'Effacer le filtre interactif',
  filterClearAllCrossFilters: 'Supprimer tous les filtres croisés',
  filterRemoveCrossFilter: 'Supprimer le filtre croisé',
  filterSearchValues: 'Rechercher des valeurs…',
  filterSelectField: 'Sélectionnez un champ…',
  filterValueLabel: 'Valeur',
  filterValueHelper: 'Valeur à comparer',
  filterValueAmountLabel: 'Valeur',
  filterSelectParent: 'Sélectionnez le filtre parent…',
  filterFieldLabel: 'Champ',
  filterRankByLabel: 'Trier par',
  filterSelectionNoValues: 'Aucune valeur trouvée.',
  filterSelectionAll: 'Tous',
  filterSelectionSelectedCount: (count) => `${count} sélectionné${count === 1 ? '' : 's'}`,
  filterSectionNoInteractiveFilters:
    "Aucun filtre interactif actif. Utilisez les widgets de filtre à l'écran pour définir des filtres.",
  filterSectionNoCrossFilters:
    'Aucun filtre croisé actif. Cliquez sur les éléments du graphique ou sélectionnez les lignes du tableau pour créer des filtres croisés.',
  filterSectionSelectedCount: (count) => `${count} sélectionné${count === 1 ? '' : 's'}`,
  filterSectionValueDisplay: (fieldLabel, value) => `${fieldLabel} = ${value}`,
  filterSectionSourcePrefix: (widgetTitle) => `De : ${widgetTitle}`,
  filterBodyAddCondition: 'Ajouter une condition',
  filterBodyNarrowOptions: 'Affiner les options en fonction de :',
  filterModeFilter: 'Filtre',
  filterModeSelect: 'Sélectionner',
  filterModeRank: 'Trier',
  filterRelativeUnitSeconds: 'secondes',
  filterRelativeUnitMinutes: 'minutes',
  filterRelativeUnitHours: 'heures',
  filterRelativeUnitDays: 'jours',
  filterRelativeUnitWeeks: 'semaines',
  filterRelativeUnitMonths: 'mois',
  filterRelativeUnitYears: 'années',
  filterDatePreset7Days: '7 jours',
  filterDatePreset30Days: '30 jours',
  filterDatePreset3Months: '3 mois',
  filterDatePreset12Months: '12 mois',
  filterDatePreset1Year: '1 an',
  filterRelativeDateAgo: 'il y a',
  filterRelativeDateFromNow: 'à partir de maintenant',
  filterDateLabel: 'Date',
  filterRankAggSumLabel: 'Somme de toutes les séries',
  filterRankAggAvgLabel: 'Moyenne de toutes les séries',
  filterRankAggMaxLabel: 'Maximum de toutes les séries',
  filterRankAggMinLabel: 'Minimum de toutes les séries',
  filterRankTop: 'Premiers',
  filterRankBottom: 'Derniers',

  // Expression field dialog
  exprNodeTypeField: 'Champ',
  exprNodeTypeLiteral: 'Littéral',
  exprNodeTypeFunction: 'Fonction',
  exprDataTypeNumber: 'Nombre',
  exprDataTypeText: 'Texte',
  exprDataTypeBoolean: 'Booléen',
  exprBooleanTrue: 'Vrai',
  exprBooleanFalse: 'Faux',
  exprExpandTooltip: 'Développer',
  exprCollapseTooltip: 'Réduire',
  exprRemoveInputTooltip: "Supprimer l'entrée",
  exprCancel: 'Annuler',
  exprSave: 'Sauvegarder',
  exprAddField: 'Ajouter un champ',
  expressionNameLabel: 'Nom',
  expressionNameHelperText:
    'Utilisé comme étiquette de champ dans les sélecteurs et les colonnes de table',
  expressionNamePlaceholder: 'par exemple : bénéfice, revenu par unité',
  expressionDescriptionLabel: 'Description',
  expressionDescriptionHelperText:
    "Facultatif. Affiché sous forme d'info-bulle dans les sélecteurs de champs",
  expressionDescriptionPlaceholder: 'Facultatif : décrivez ce que ce champ calcule',
  expressionPrecisionLabel: 'Précision',
  expressionPrecisionHelperText:
    'Nombre de décimales (0 à 10) utilisées pour formater ce champ calculé',

  // Shared aggregation function labels
  aggFnSum: 'Somme',
  aggFnCount: 'Compter',
  aggFnCountRows: 'Nombre (lignes)',
  aggFnAverage: 'Moyenne',
  aggFnMin: 'Min.',
  aggFnMax: 'Max.',

  // Shared time granularity labels
  timeGranNone: 'Aucun (valeurs brutes)',
  timeGranDay: 'Jour',
  timeGranWeek: 'Semaine',
  timeGranMonth: 'Mois',
  timeGranQuarter: 'Trimestre',
  timeGranYear: 'Année',

  // Shared sort direction labels
  sortAscendingAriaLabel: 'Croissant',
  sortDescendingAriaLabel: 'Descendant',
  crossFilterModeHighlight: 'Souligner',
  crossFilterModeFilter: 'Filtre',
  crossFilterModeNone: 'Aucun',

  // Chart setup panel
  chartTypePickerLabel: 'Type de graphique',
  chartTypeBarGrouped: 'Barres (groupées)',
  chartTypeBarStacked: 'Barre (empilée)',
  chartTypeBar100: 'Barre (100%)',
  chartTypeBarHorizontal: 'Barre (horizontale)',
  chartTypeBarStackedHorizontal: 'Barre (empilée, horizontale)',
  chartTypeBar100Horizontal: 'Barre (100 %, horizontale)',
  chartTypeLine: 'Ligne',
  chartTypeArea: 'Zone',
  chartTypeAreaStacked: 'Surface (empilée)',
  chartTypeArea100: 'Superficie (100%)',
  chartTypeScatter: 'Dispersion',
  chartTypeMixed: 'Mixte (barre + ligne)',
  chartTypeHeatmap: 'Carte thermique',
  chartTypeFunnel: 'Entonnoir',
  chartTypeGantt: 'Gantt / Chronologie',
  chartTypeSankey: 'Sankey',
  chartTypePie: 'Camembert',
  chartTypeDonut: 'Anneau',
  chartTypeGauge: 'Jauge',
  chartSetupValueFieldLabel: 'Champ de valeur',
  chartSetupValueFieldHelperText: 'Champ numérique à agréger',
  chartSetupAggregationLabel: 'Agrégation',
  chartSetupMinLabel: 'Min.',
  chartSetupMaxLabel: 'Max.',
  chartSetupGroupByLabel: 'Regrouper par',
  chartSetupSortByLabel: 'Trier par',
  chartSetupSortCategory: 'Catégorie',
  chartSetupSortValue: 'Valeur',
  chartSetupSortNatural: 'Naturel',
  chartSetupSortNone: 'Aucun',
  chartSetupSortPercent: 'Pourcentage',
  chartSetupSortDirectionAriaLabel: 'Sens de commande',
  chartSetupAnnotationsTitle: 'Remarques',
  chartSetupInteractionsTitle: 'Interactions',
  chartSetupInteractionsDescription: "Lorsque vous cliquez sur d'autres widgets, ce graphique…",
  chartSetupAddSeries: 'Ajouter une série',
  chartSetupNoMoreFields: 'Plus aucun champ à ajouter',
  chartSetupRemoveSeries: 'Supprimer la série',
  chartSetupAddReferenceLine: 'Ajouter une ligne de référence',
  chartSetupRemoveAnnotation: "Supprimer l'annotation",
  chartSetupNoReferenceLines: 'Aucune ligne de référence. Cliquez sur + pour en ajouter un.',
  chartSetupDualYAxis: "Double axe Y (série de lignes sur l'axe droit)",
  chartSetupReferenceLineValueLabel: 'Valeur',
  chartSetupReferenceLineLabelLabel: 'Étiquette',
  chartSetupYFieldLabel: 'Champ Y (numérique)',
  chartSetupYFieldHelperText: "Champ numérique tracé sur l'axe vertical",
  chartSetupColorByLabel: 'Colorier par (facultatif)',
  chartSetupColorByHelperText: 'Divise les points en séries par catégorie de code couleur',
  chartSetupSizeByLabel: 'Taille par (facultatif)',
  chartSetupSizeByHelperText:
    'Champ numérique qui contrôle le rayon de la bulle (produit un graphique à bulles)',
  chartSetupMinRadiusLabel: 'Rayon minimum',
  chartSetupMaxRadiusLabel: 'Rayon maximum',
  chartSetupFunnelValueHelperText:
    'Champ numérique additionné par étape — les étapes sont classées par valeur (la plus grande en premier)',
  chartSetupHeatmapRowAxisLabel: "Champ d'axe de ligne",
  chartSetupHeatmapRowAxisHelperText:
    "Champ pour l'axe vertical (ligne) — tout type de champ de la source principale, par ex. catégorie, remise % ou heure de la journée",
  chartSetupHeatmapValueLabel: 'Champ valeur/couleur',
  chartSetupHeatmapValueHelperText:
    "Champ numérique additionné par cellule pour déterminer l'intensité de la couleur",
  chartSetupHeatmapColourSchemeLabel: 'Jeu de couleurs',
  chartSetupHeatmapSortByLabel: 'Trier par',
  chartSetupHeatmapSortXAxis: 'Axe des colonnes (X)',
  chartSetupHeatmapSortYAxis: 'Axe des lignes (Y)',
  chartSetupArcLabelLabel: "Étiquette d'arc",
  chartSetupMinAngleLabel: 'Angle minimal (°)',
  chartSetupMinAngleHelperText:
    "Les tranches plus petites que cet angle (degrés) n'afficheront pas d'étiquette",
  chartSetupGanttLabelFieldLabel: "Champ d'étiquette",
  chartSetupGanttLabelFieldHelperText:
    "Champ affiché sous forme d'étiquette de ligne sur l'axe Y (par exemple, nom de la tâche ou de la commande)",
  chartSetupGanttStartDateLabel: 'Champ de date de début',
  chartSetupGanttStartDateHelperText: 'Champ date/heure pour le début de chaque barre',
  chartSetupGanttEndDateLabel: 'Champ de date de fin',
  chartSetupGanttEndDateHelperText: 'Champ date/heure pour la fin de chaque barre',
  chartSetupGanttColourByLabel: 'Colorier par (facultatif)',
  chartSetupGanttColourByHelperText:
    'Champ catégoriel utilisé pour colorer les barres (ex : statut ou catégorie)',
  chartSetupXFieldNumericLabel: 'Champ X (numérique)',
  chartSetupXFieldCategoryVertLabel: 'Champ Y/catégorie',
  chartSetupXFieldCategoryHorizLabel: 'Champ X/catégorie',
  chartSetupXFieldHorizontalHelperText: "Tracé sur l'axe horizontal",
  chartSetupXFieldGroupVertHelperText: "Regroupe les données le long de l'axe vertical",
  chartSetupXFieldGroupHorizHelperText: "Regroupe les données le long de l'axe horizontal",
  chartSetupYMeasureFieldsLabel: 'Champs Y/mesure',
  chartSetupXMeasureFieldsLabel: 'Champs X/mesure',
  chartSetupYMeasureFieldLabel: 'Champ/mesure Y',
  chartSetupXMeasureFieldLabel: 'Champ X/mesure',
  chartSetupNoDataAlert: 'Aucun champ de données disponible pour la configuration du graphique.',
  chartSetupSeriesLabel: (index) => `Série ${index + 1}`,
  chartSetupSeriesNumericHorizHelperText: "Champ numérique tracé le long de l'axe horizontal",
  chartSetupSeriesNumericSumHelperText: 'Champ numérique additionné ou moyenné par catégorie',
  chartSetupMixedSeriesBar: 'Bar',
  chartSetupMixedSeriesLine: 'Doubler',
  chartSetupCalculatedField: 'Champ calculé…',
  chartSetupCategoryFieldLabel: 'Champ Catégorie',
  chartSetupRemoveSplitByTooltip:
    'Supprimez les champs de mesure supplémentaires pour activer la division par',
  chartSetupInnerRingLabel: 'Catégorie de bague intérieure',
  chartSetupSplitByLabel: 'Diviser par (champ de série)',
  chartSetupArcLabelsTitle: "Étiquettes d'arc",
  chartSetupSplitByHelperText: 'Divise les données en une série séparée par valeur',
  chartSetupSplitByDisabledHelperText:
    'Non disponible lorsque plusieurs champs de mesure sont configurés',
  chartSetupInnerRingHelperText: 'Ajoute une bague intérieure concentrique regroupée par ce champ',

  // KPI setup panel
  kpiSetupChartLine: 'Doubler',
  kpiSetupChartBar: 'Bar',
  kpiSetupChartGauge: 'Jauge',
  kpiSetupCompPrevPeriod: 'Période précédente (durée équivalente)',
  kpiSetupCompPrevCalendarPeriod: 'Période calendaire précédente',
  kpiSetupCompSameLastYear: "Même période l'année dernière",
  kpiSetupInteractionsTitle: 'Interactions',
  kpiSetupInteractionsDescription: 'Lorsque d’autres widgets sont cliqués, ce KPI…',
  kpiSetupTimeFieldLabel: 'Champ de temps',
  kpiSetupGranularityLabel: 'Granularité',
  kpiSetupPlotTypeLabel: 'Type de graphique',
  kpiSetupValueFieldLabel: 'Champ de valeur',
  kpiSetupValueFieldHelperText: 'Champ à ajouter',
  kpiSetupSparklineLabel: 'Ligne scintillante',
  kpiSetupGaugeMaxLabel: 'But',
  kpiSetupTrendLabel: "S'orienter",
  kpiSetupDateRangeLabel: 'Plage de dates',
  kpiSetupDateRangeFieldLabel: 'Champ de date',
  kpiSetupCompPeriodLabel: 'Période de comparaison',
  kpiSetupDateAggEarliest: 'Plus tôt',
  kpiSetupDateAggLatest: 'Plus tard',
  kpiSetupFillAreaLabel: 'Zone de remplissage',
  kpiSetupCumulativeLabel: 'Cumulatif (total cumulé)',
  kpiSetupAutoDateFilterPrefix: 'Utilisation du filtre de date :',
  kpiSetupCalculatedField: 'Champ calculé…',
  kpiSetupInvertColours: 'Inverser les couleurs (plus petit est mieux)',
  kpiSetupFixedWindowLabel: 'Trend window',
  kpiSetupFixedWindowNone: 'From date filter',
  kpiSetupFixedWindowMonth: 'Last 30 days',
  kpiSetupFixedWindowQuarter: 'Last 90 days',
  kpiSetupFixedWindowYear: 'Last 365 days',

  // KPI widget
  kpiGrandTotalTooltip:
    'Grand Total — Les widgets de filtre actif ne sont pas appliqués à ce KPI. Activez le mode Cross Filter dans les paramètres des KPI pour les respecter.',
  kpiGranularityAutoLabel: 'Soi',

  // Grid setup panel
  gridSetupDataSourceLabel: 'Source de données',
  gridSetupDataSourcePlaceholder: 'Sélectionnez une source de données…',
  gridSetupAllColumnsAdded: 'Toutes les colonnes disponibles ont été ajoutées',
  gridSetupCrossFilterFieldLabel: 'Champ de filtre croisé',
  gridSetupCrossFilterFieldHelper:
    "Champ appliqué aux autres widgets lorsqu'une ligne est sélectionnée ; par défaut est la première colonne visible",
  gridSetupGroupByLabel: 'Regrouper par',
  gridSetupGroupByHelper:
    "Réduire les lignes en groupes : définir l'agrégation par colonne ci-dessous",
  gridSetupDefaultSortLabel: 'Ordre par défaut',
  gridSetupHeightLabel: 'Hauteur (px)',
  gridSetupConditionalFormattingTitle: 'Mise en forme conditionnelle',
  gridSetupConditionalCustom: 'Coutume',
  gridSetupRemoveRuleAriaLabel: 'Supprimer la règle',
  gridSetupInteractionsTitle: 'Interactions',
  gridSetupInteractionsDescription: "Lorsque vous cliquez sur d'autres widgets, ce tableau…",
  gridSetupChooseSourceHelper: 'Choisissez une source de données pour configurer les colonnes',
  gridSetupNoSourceAlert:
    'Sélectionnez une source de données ci-dessus pour configurer les colonnes et les paramètres de cette table.',
  gridSetupColumnsTitle: 'Colonnes',
  gridSetupColumnOptionsAriaLabel: (label) => `Options de ${label}`,
  gridSetupColumnGroupLabel: '(groupe)',
  gridSetupColumnRemove: 'Retirer',
  gridSetupColumnAggNone: 'Aucun',
  gridSetupColumnAggUnique: 'Célibataire',
  gridSetupColumnAggSummaryTooltip: 'Définir le résumé/supprimer',
  gridSetupColumnAggLabel: (isGroupBy, aggLabel) =>
    `${isGroupBy ? 'Agrégation' : 'Résumé'} : ${aggLabel}`,
  gridSetupColumnSetAggTooltip: "Définir l'agrégation",
  gridSetupAddColumn: 'Ajouter une colonne',
  gridSetupCalculatedColumn: 'Colonne calculée…',
  gridSetupAddRule: 'Ajouter une règle',
  gridSetupCFContains: 'contient',
  gridSetupCFIsEmpty: 'est vide',
  gridSetupCFNotEmpty: "n'est pas vide",
  gridSetupCFStyleRed: 'Rouge',
  gridSetupCFStyleGreen: 'Vert',
  gridSetupCFStyleYellow: 'Jaune',
  gridSetupCFStyleBlue: 'Bleu',
  gridSetupCFStyleBold: 'Audacieux',

  // Map setup panel
  mapSetupMapTypeLabel: 'Type de carte',
  mapSetupValueFieldLabel: 'Champ de valeur (facultatif pour le comptage)',
  mapSetupColourSchemeLabel: 'Jeu de couleurs',
  mapSetupLegendPositionLabel: 'Position de la légende',
  mapSetupScaleFromZeroLabel: 'Évoluer à partir de zéro',
  mapSetupClickableLabel: 'Cliquable (police de filtre)',
  mapSetupCrossFilterLabel: 'Répondre aux filtres croisés',
  mapSetupColorBlues: 'Bleu',
  mapSetupColorReds: 'Rouges',
  mapSetupColorGreens: 'Légumes verts',
  mapSetupColorOranges: 'Oranges',
  mapSetupColorPurples: 'Violets',
  mapSetupLegendBottom: 'Bas',
  mapSetupLegendTop: 'Plus haut',
  mapSetupLegendLeft: 'Gauche',
  mapSetupLegendRight: 'Droite',
  mapSetupLegendHidden: 'Aucune',
  mapSetupLegendAlignLabel: 'Alignement de la légende',
  mapSetupLegendAlignStart: 'Haut',
  mapSetupLegendAlignCenter: 'Milieu',
  mapSetupLegendAlignEnd: 'Bas',
  mapFormatLegendAlignLeft: 'Gauche',
  mapFormatLegendAlignRight: 'Droite',
  mapSetupRegionFieldLabel: 'Champ Région',
  mapSetupRegionFieldHelperText:
    'Un champ qui contient des identifiants de région correspondant aux ID de ressources géographiques.',

  // Pivot setup panel
  pivotSetupDescription:
    'Créez un tableau croisé en choisissant un champ de ligne, un champ de colonne et une mesure de valeur.',
  pivotSetupRowFieldLabel: 'Champ de ligne',
  pivotSetupRowFieldHelper: 'Champ catégoriel affiché sous forme de groupes de lignes à gauche',
  pivotSetupColFieldLabel: 'Champ de colonne',
  pivotSetupColFieldHelper: 'Champ catégoriel réparti entre les en-têtes de colonnes',
  pivotSetupValueFieldLabel: 'Champ de valeur',
  pivotSetupValueFieldHelper: 'Champ numérique agrégé dans chaque cellule',
  pivotSetupShowTotals: 'Afficher la ligne et la colonne des totaux',
  pivotSetupAggregationLabel: 'Agrégation',

  // Inline formula bar
  inlineFormulaBarAddTooltip: 'Ajouter un champ de formule calculée',
  inlineFormulaBarCloseAriaLabel: 'Fermer la barre de formule',
  inlineFormulaBarLabelLabel: 'Étiquette',
  inlineFormulaBarAutoHelperText:
    'Généré automatiquement à partir de la formule – modifier pour personnaliser',
  inlineFormulaBarCancelButton: 'Annuler',
  inlineFormulaBarAddButton: 'Pour ajouter',
  inlineFormulaBarFieldOperandLabel: 'Champ',
  inlineFormulaBarNumberOperandLabel: 'Nombre',
  inlineFormulaBarOperandTypeAriaLabel: (label) => `type de ${label}`,
  inlineFormulaBarButtonLabel: 'Formule',
  inlineFormulaBarOperandALabel: 'LE',
  inlineFormulaBarOperandBLabel: 'B',

  // Field detail view
  fieldDetailRowSourceId: 'Identifiant de la source',
  fieldDetailRowName: 'Nom',
  fieldDetailRowDescription: 'Description',
  fieldDetailRowDataType: 'Type de données',
  fieldDetailRowCalculationType: 'Type de calcul',
  fieldDetailRowNoCalculation: 'Aucun calcul',
  fieldDetailRowFormat: 'Format',
  fieldDetailNumberFormatLabel: 'Format numérique',
  fieldDetailNumberFormatDefault: 'Standard',
  fieldDetailFormatInteger: 'Entier',
  fieldDetailFormatDecimal: 'Décimal',
  fieldDetailFormatPercent: 'Pourcentage',
  fieldDetailFormatCurrency: 'Pièce de monnaie',

  // Filters drawer
  filtersDrawerRenameViewTooltip: 'Renommer la vue',
  filtersSectionWidgetTitle: (title) => `Widget : ${title}`,
  filtersRenameViewAriaLabel: 'Renommer la vue enregistrée',
  filtersRenameViewButtonAriaLabel: (name) => `Renommer la vue "${name}"`,
  filtersDeleteViewAriaLabel: (name) => `Supprimer la vue "${name}"`,

  // Filter setup panel
  filterSetupControlTypeLabel: 'Type de contrôle',
  filterSetupMultiSelect: 'Sélection multiple',
  filterSetupMultiSelectDescription:
    'Menu déroulant avec cases à cocher pour les valeurs catégorielles',
  filterSetupToggleChips: 'Basculer les puces',
  filterSetupToggleChipsDescription: 'Boutons de puce en ligne pour les valeurs catégorielles',
  filterSetupDateRange: 'Plage de dates',
  filterSetupDateRangeDescription: 'Sélecteurs de dates de début et de fin',
  filterSetupSlider: 'Curseur',
  filterSetupSliderDescription: 'Curseur de plage pour les champs numériques ou de date',
  filterSetupMinLabel: 'Min.',
  filterSetupMaxLabel: 'Max.',
  filterSetupStepLabel: 'Étape',
  filterSetupSelectFieldAlert: 'Sélectionnez un champ pour configurer le contrôle de filtre.',
  filterSetupSliderRangeHelperText:
    'Plage du curseur (laissez vide pour détecter automatiquement à partir des données)',

  // Text setup panel
  textSetupTitleLabel: 'Titre',
  textSetupTitleHelper: 'En-tête affiché en haut du widget',
  textSetupSubtitleLabel: 'Légende',
  textSetupSubtitleHelper: "Texte plus petit sous l'en-tête",
  textSetupBodyLabel: 'Corps',
  textSetupBodyHelper: 'Contenu principal du widget ; prend en charge le texte brut',

  // Page config panel
  pageConfigPageSectionTitle: 'Page',
  pageConfigCardsSectionTitle: 'Cartes',
  pageConfigBackgroundColourLabel: 'Couleur de fond',
  pageConfigBackgroundColourPlaceholder: 'par exemple : #f5f5f5',
  pageConfigCardBackgroundLabel: 'Fond de carte',
  pageConfigCardBackgroundPlaceholder: 'par exemple : #ffffff',
  pageConfigPaddingLabel: 'Rembourrage',
  pageConfigCornerRadiusLabel: 'Rayon de coin (px)',
  pageConfigCardBorderLabel: 'Bord de la carte',
  pageConfigBorderColourLabel: 'Couleur de la bordure',
  pageConfigBorderColourPlaceholder: 'par exemple : #e0e0e0',
  pageConfigBorderWidthLabel: 'Largeur de bordure (px)',
  pageConfigPaddingNone: 'Aucun',
  pageConfigPaddingSmall: 'Petit (8px)',
  pageConfigPaddingMedium: 'Moyen (16px)',
  pageConfigPaddingLarge: 'Grand (24px)',

  // AI insight panel
  insightTypeSummary: 'Résumé',
  insightTypeAnalysis: 'Analyse',
  insightTypeForecast: 'Prévision',
  insightTypeAnomaly: "Explication de l'anomalie",
  insightTypeCorrelation: 'Analyse de corrélation',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Nettoyer le filtre',
  filterWidgetSelectAllLabel: 'Tout sélectionner',
  filterWidgetClearAllLabel: 'Tout effacer',
  filterWidgetAllLabel: 'Tous',
  filterWidgetNoOptionsLabel: 'Aucune option trouvée',
  filterWidgetSelectedCount: (count) => `${count} sélectionné${count === 1 ? '' : 's'}`,
  filterWidgetExcludeLabel: 'Supprimer la sélection',
  filterWidgetExcludingLabel: '⊘ Suppression de la sélection',
  filterWidgetDateFromLabel: 'De',
  filterWidgetDateToLabel: "Jusqu'à",
  filterWidgetNoFieldConfigured:
    'Aucun champ configuré. Sélectionnez un champ dans le panneau Composer.',

  // Date range bar
  dateRangePresetAriaLabel: 'Plage de dates prédéfinie',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Effacer le champ',
  dataSourceAddCalculatedField: 'Ajouter un champ calculé…',

  // Widget filter row
  widgetFilterFieldHelperText: "Champ auquel ce filtre s'applique",
  drawerPanelOpenAriaLabel: (title) => `Ouvrir le panneau ${title}`,
  drawerPanelCloseNamedAriaLabel: (title) => `Fermer le panneau ${title}`,
  sidebarPanelToggleAriaLabel: (isActive, label) =>
    isActive ? `Fermer le panneau ${label}` : `Ouvrir le panneau ${label}`,
  addWidgetGroupAriaLabel: (groupLabel) => `Widgets de ${groupLabel}`,
  addWidgetSelectAriaLabel: (label) => `Sélectionner le widget : ${label}`,
  formatPanelNoSubtitlePlaceholder: 'Pas de sous-titre',

  // Widget filters panel
  widgetFiltersPanelNoSource: "Ce widget n'a pas de source de données.",
  widgetFiltersPanelDescription:
    'Conditions permanentes appliquées aux données de ce widget avant tout filtre interactif.',
  widgetFiltersPanelNoFilters: 'Sans filtres, toutes les données sont affichées.',
  widgetFiltersPanelAddButton: 'Ajouter un filtre',

  // Expression field preview
  expressionPreviewMeasureLabel: (count) =>
    `Aperçu (mesure sur ${count.toLocaleString('fr')} lignes)`,
  expressionPreviewFirstRowsLabel: (count) =>
    `Aperçu (premières ${count.toLocaleString('fr')} lignes)`,

  // Pivot widget
  pivotRowsColumnsLabel: (rowCount, colCount) => `${rowCount} lignes × ${colCount} colonnes`,

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} ligne${count === 1 ? '' : 's'} non affichée${count === 1 ? '' : 's'} : augmentez la hauteur du widget pour tout voir`,

  // Color input
  colorInputClearAriaLabel: (label) => `Effacer ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'Nouveau',
  kpiTrendTargetTooltip: (value) => `Objectif : ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Période précédente : ${period}`,
  kpiTrendNoDateFilterHint: 'Ajoutez un filtre de date pour afficher la tendance.',
  kpiSparklineNoTimeFieldHint:
    "Ajoutez un filtre de date ou sélectionnez un champ d'heure pour afficher le sparkline.",

  // Chart widget
  chartMixedRequiresFieldsHint: 'Le graphique mixte nécessite 2 champs de mesure ou plus.',
  chartDefaultSeriesLabel: 'Valeur',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Utilisez l'onglet Configuration pour choisir un ${fieldLabel.toLowerCase()} et un champ de valeur.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'En-tête de ligne/colonne',
  pivotBlankValueLabel: '(vide)',
  pivotTotalLabel: 'Total',

  // Expression dialog
  exprDialogEditTitle: 'Modifier le champ calculé',
  exprDialogNewTitle: 'Nouveau champ calculé',

  // Expression field — measure checkbox
  exprMeasureLabel: 'Mesure (agrégation)',
  exprMeasureHelperText:
    "Calcule une valeur unique sur l'ensemble des données (par exemple, le chiffre d'affaires total).",
  exprDimensionHelperText: 'Calculez une valeur par ligne (ex. : prix × quantité).',

  // Chart color scheme options
  chartColorSchemePrimary: 'Primaire (bleu)',
  chartColorSchemeSuccess: 'Succès (vert)',
  chartColorSchemeWarning: 'Attention (orange)',
  chartColorSchemeError: 'Erreur (rouge)',

  // AI chat suggestions
  aiSuggestionBarChart: (numericLabel, catLabel) =>
    `Graphique à barres : ${numericLabel} par ${catLabel}`,
  aiSuggestionKpi: (fieldLabel) => `KPI : total de ${fieldLabel}`,
  aiSuggestionTable: (sourceLabel) => `Tableau de ${sourceLabel}`,
  aiSuggestionChangeToLine: (widgetTitle) =>
    `Transformer « ${widgetTitle} » en graphique en courbes`,
  aiSuggestionAddSparkline: (widgetTitle) => `Ajouter une sparkline à « ${widgetTitle} »`,
  aiSuggestionAddDateFilter: 'Ajouter un filtre de date',
  aiSuggestionAddPage: 'Ajouter une nouvelle page',
  aiSuggestionSummarisePage: 'Résumer la page',
  aiSuggestionWhatDataAvailable: 'Quelles données sont disponibles ?',
  chatNewConversationName: 'Nouvelle conversation',
  chatSwitchConversationTooltip: 'Changer de conversation',
  chatVoiceInputStart: 'Démarrer la saisie vocale',
  chatVoiceInputStop: 'Arrêter la saisie vocale',
  chatVoiceInputNotSupported: "La saisie vocale n'est pas prise en charge dans ce navigateur",
  chatMessageCopyTooltip: 'Copier',
  chatMessageCopiedTooltip: 'Copié\u00a0!',
  chatMessageCopyAriaLabel: 'Copier le message',
  chatMessageRetryTooltip: 'Réessayer',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Cette configuration de graphique utilise des champs qui ne sont pas disponibles dans la source du widget ou dans une source directement associée.',
  chartUnsupportedMixedCrossSource:
    "Cette configuration de graphique mélange des champs provenant de différentes sources d'une manière qui ne dispose pas encore d'un seul grain d'agrégation sécurisé.",
  chartUnsupportedScatterCrossSource:
    'Les nuages ​​de points ne prennent pas encore en charge les combinaisons de champs entre sources.',
  chartUnsupportedDefault: "Cette configuration de graphique n'est pas encore prise en charge.",
  chartForecastSeriesLabel: 'Prévision',

  // Grid summary labels
  gridSummaryLabelSum: 'Total:',
  gridSummaryLabelAvg: 'Moyenne:',
  gridSummaryLabelCount: 'Nombre :',
  gridSummaryLabelCountDistinct: 'Uniques :',
  gridSummaryLabelMin: 'Min. :',
  gridSummaryLabelMax: 'Max. :',

  // Auto-generated widget titles
  widgetAutoTitleChart: 'Graphique',
  widgetAutoTitleKpi: 'KPI',
  widgetAutoTitleTable: 'Tableau',
  widgetAutoTitleFilter: 'Filtre',
  widgetAutoTitlePivot: 'Tableau croisé dynamique',
  widgetAutoTitleMap: 'Carte',
  widgetAutoTitleDefault: 'Widget',
  widgetAutoTitleVs: 'contre',
  widgetAutoTitleBy: 'par',
  widgetAutoTitleSplitBy: 'divisé par',
  widgetAutoTitleByCountry: 'par pays',
  widgetAutoTitleSourceSuffixChart: 'graphique',
  widgetAutoTitleSourceSuffixKpi: 'KPI',
  widgetAutoTitleSourceSuffixPivot: 'dynamique',
  widgetAutoTitleSourceSuffixMap: 'carte',
  widgetAutoTitleFilterPrefix: 'Filtre',
  widgetAggPrefixSum: 'Total de',
  widgetAggPrefixAvg: 'Moyenne de',
  widgetAggPrefixCount: 'Nombre de',
  widgetAggPrefixMin: 'Min.',
  widgetAggPrefixMax: 'Max.',
  widgetAggPrefixCountDistinct: 'Distinct de',
  widgetGroupByPrefixDay: 'Tous les jours',
  widgetGroupByPrefixWeek: 'Hebdomadaire',
  widgetGroupByPrefixMonth: 'Mensuel',
  widgetGroupByPrefixQuarter: 'Trimestriel',
  widgetGroupByPrefixYear: 'Annuel',
  widgetAutoTitleMoreFields: (count) => `+${count} de plus`,

  // Date filter labels
  dateFilterLast: (amount, unit) => `Derniers ${amount} ${unit}`,
  dateFilterNext: (amount, unit) => `Prochains ${amount} ${unit}`,
  dateFilterFrom: (date) => `À partir de ${date}`,
  dateFilterUpTo: (label) => `Jusqu'à ${label}`,
  dateFilterSince: (date) => `Depuis ${date}`,
  dateFilterUntil: (date) => `Jusqu'à ${date}`,
  dateFilterUnitYear: 'année',
  dateFilterUnitYears: 'années',
  dateFilterUnitMonth: 'mois',
  dateFilterUnitMonths: 'mois',
  dateFilterUnitWeek: 'semaine',
  dateFilterUnitWeeks: 'semaines',
  dateFilterUnitDay: 'jour',
  dateFilterUnitDays: 'jours',
  dateFilterUnitHour: 'heure',
  dateFilterUnitHours: 'heures',
  dateFilterUnitMinute: 'minute',
  dateFilterUnitMinutes: 'minutes',
  dateFilterUnitSecond: 'seconde',
  dateFilterUnitSeconds: 'secondes',

  // Widget delete confirmation dialog
  widgetDeleteConfirmTitle: 'Supprimer le widget\u00a0?',
  widgetDeleteConfirmMessage: 'Ce widget sera définitivement supprimé de la page.',
  widgetDeleteConfirmOk: 'Supprimer',
  widgetDeleteConfirmCancel: 'Annuler',
};

export const fr: Localization = getStudioLocalization(frLocaleText);

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
  filterSearchClearAriaLabel: 'Effacer la recherche de filtres',
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
  widgetNoData: 'Aucune donnée',
  widgetLoadError: 'Échec du chargement des données',
  mapGeographyLoadError: 'Échec du chargement des données cartographiques. Veuillez réessayer.',
  widgetLoadingLabel: 'Chargement',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Ouvrir le panneau des filtres',
  quickFilterBarClearAll: 'Effacer tous les filtres',
  dateRangeBarFieldLabel: 'Plage de dates',

  // Widget card actions
  widgetEditTooltip: 'Modifier le widget',
  widgetExportCsvTooltip: 'Télécharger en CSV',
  widgetExportPngTooltip: 'Télécharger en PNG',
  widgetExportNoDataMessage:
    "Aucune donnée disponible à exporter pour l'instant. Ouvrez la grille pour qu'elle puisse charger les données du serveur, puis réessayez l'exportation.",
  widgetExportUnavailableMessage:
    "Ce widget n'a rien à exporter. Terminez sa configuration — un tableau nécessite une source de données et un tableau croisé dynamique nécessite des lignes, des colonnes et des valeurs — puis réessayez.",
  widgetExpandTooltip: 'Agrandir le widget',
  widgetMoveToPageLabel: 'Déplacer vers la page',
  widgetDuplicateTooltip: 'Dupliquer le widget',
  widgetDeleteTooltip: 'Supprimer le widget',
  widgetAiAssistantTooltip: 'Assistant IA',
  widgetAiInsightTooltip: "Aperçu de l'IA",
  widgetAiRefreshTooltip: 'Actualiser le contenu IA',
  widgetInsightTypeSummary: 'Résumé',
  widgetInsightTypeAnalysis: 'Analyse',
  widgetInsightTypeForecast: 'Prévision',
  widgetDetectAnomalyTooltip: 'Détecter les anomalies',
  widgetHideAnomalyTooltip: 'Masquer les anomalies',
  widgetExplainAnomalyTooltip: 'Expliquer les anomalies',

  // Widget edit dialog
  widgetEditDialogTabSetup: 'Configurer',
  widgetEditDialogTabFilters: 'Filtres',
  widgetEditDialogTabFormat: 'Format',
  widgetEditDialogCloseAriaLabel: "Fermer la boîte de dialogue d'édition",
  widgetUntitledLabel: (kindLabel) => `${kindLabel} sans titre`,
  widgetEditDialogPreviewLabel: (kindLabel) => `Aperçu ${kindLabel.toLowerCase()}`,

  // AI assistant
  aiAssistantOpenTooltip: "Ouvrir l'assistant IA",
  aiAssistantCloseTooltip: "Fermer l'assistant IA",
  aiAssistantPanelTitle: 'Assistant IA',

  // Drawer panel / sidebar
  drawerPanelCloseAriaLabel: 'Fermer la configuration du widget',
  sidebarPanelsAriaLabel: 'Panneaux latéraux',
  drawerPanelError: "Une erreur s'est produite lors de l'affichage de ce panneau.",

  // NumberField
  numberFieldIncreaseAriaLabel: 'Augmenter',
  numberFieldDecreaseAriaLabel: 'Diminuer',

  // Widget card (expanded state)
  widgetCardCloseExpandedAriaLabel: 'Fermer le graphique développé',
  widgetCardExportPngAriaLabel: 'Télécharger le graphique développé au format PNG',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Décrire un widget',
  aiCreateWidgetPlaceholder:
    "Ex. : Graphique à barres montrant le chiffre d'affaires par pays, le KPI des commandes totales…",
  aiCreateWidgetButton: 'Créer',
  aiCreateWidgetLoading: 'Création…',
  aiCreateWidgetError: 'Échec de la création du widget',
  aiCreateWidgetNetworkError: 'Erreur réseau. Vérifiez votre connexion et réessayez.',
  aiCreateWidgetRequestFailed: (status, detail) =>
    `Échec de la requête IA (${status})${detail ? ` : ${detail}` : ''}.`,
  aiCreateWidgetInvalidResponse: "Réponse non valide de l'IA.",
  aiTextWidgetGenerationError: 'Échec de la génération du contenu',

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
  // French typography keeps a non-breaking space between a number and its unit.
  textFormatFontSizeOption: (px) => `${px}\u00a0px`,
  textFormatAlignmentLabel: 'Alignement',

  // Data drawer
  dataDrawerNoSources:
    'Aucune source de données configurée. Ajoutez un widget au tableau de bord pour charger des exemples de données.',
  dataDrawerViewLineage: 'Afficher le traçage des données',
  dataDrawerLineageTitle: 'Lignage des données',
  dataDrawerLineageHelper:
    'Cliquez sur un nœud pour afficher ses données. Cliquez sur un bord pour inspecter les champs clés de jointure.',
  dataDrawerRowsLabel: (count) => `${count} ${count === 1 ? 'ligne' : 'lignes'}`,
  dataDrawerFieldsLabel: (count) => `${count} ${count === 1 ? 'champ' : 'champs'}`,
  dataDrawerBackAriaLabel: 'Retour au graphique de lignée',
  dataDrawerCloseAriaLabel: 'Fermer le lignage des données',
  dataDrawerEditTooltip: 'Modifier',
  dataDrawerDeleteTooltip: 'Supprimer',
  dataDrawerAddCalculatedField: 'Ajouter un champ calculé',
  dataDrawerNoData: (sourceLabel) => `Aucune donnée disponible pour ${sourceLabel}.`,
  dataDrawerMoreRows: (count) => `${count} ligne${count === 1 ? '' : 's'} de plus`,
  dataDrawerMoreColumns: (count) => `${count} colonne${count === 1 ? '' : 's'} de plus`,
  dataDrawerViewSourceLink: 'Afficher les données sources →',
  dataDrawerMorePreviewRows: (count) => `+${count} de plus`,
  dataDrawerRowsUnknown: 'nombre de lignes indisponible',
  dataDrawerDeleteFieldConfirmTitle: 'Supprimer le champ calculé ?',
  dataDrawerDeleteFieldConfirmMessage: (fieldLabel, referenceCount) =>
    `« ${fieldLabel} » est utilisé à ${referenceCount} ${
      referenceCount === 1 ? 'endroit' : 'endroits'
    } (widgets, filtres ou champs calculés). Le supprimer laissera ${
      referenceCount === 1 ? 'cet endroit' : 'ces endroits'
    } sans valeur à afficher.`,
  saveRejectedMessage:
    "Cette modification n'a pas pu être enregistrée — elle a peut-être été supprimée ou modifiée ailleurs. Fermez la boîte de dialogue et réessayez.",
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
  filterSelectionCapHint: (cap) =>
    `Affichage des ${cap} premières valeurs. Saisissez du texte pour affiner la liste.`,
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
  filterRankTopCount: (count) => `${count} premiers`,
  filterRankBottomCount: (count) => `${count} derniers`,

  // Filter summary
  filterSummaryAnyValue: 'valeur quelconque',
  filterSummaryIsOneOf: 'est l’un de :',
  filterSummaryIsNot: 'n’est pas :',
  filterSummaryAndMore: (count) => `et ${count} de plus`,
  filterSummaryFrom: (value) => `depuis ${value}`,
  filterSummaryUntil: (value) => `jusqu’à ${value}`,

  // Filter operator labels (per field type)
  filterOperator_string_equals: 'Est égal à',
  filterOperator_string_not_equals: "N'est pas égal à",
  filterOperator_string_contains: 'Contient',
  filterOperator_string_does_not_contain: 'Ne contient pas',
  filterOperator_string_starts_with: 'Commence par',
  filterOperator_string_not_starts_with: 'Ne commence pas par',
  filterOperator_string_ends_with: 'Se termine par',
  filterOperator_string_not_ends_with: 'Ne se termine pas par',
  filterOperator_string_is_empty: 'Est vide',
  filterOperator_string_is_not_empty: "N'est pas vide",
  filterOperator_number_equals: '=',
  filterOperator_number_not_equals: '≠',
  filterOperator_number_greater_than: '>',
  filterOperator_number_greater_than_or_equal: '≥',
  filterOperator_number_less_than: '<',
  filterOperator_number_less_than_or_equal: '≤',
  filterOperator_number_between: 'Entre',
  filterOperator_number_is_empty: 'Est vide',
  filterOperator_number_is_not_empty: "N'est pas vide",
  filterOperator_date_equals: 'Le',
  filterOperator_date_not_equals: 'Pas le',
  filterOperator_date_less_than: 'Avant',
  filterOperator_date_greater_than: 'Après',
  filterOperator_date_less_than_or_equal: 'Le ou avant',
  filterOperator_date_greater_than_or_equal: 'Le ou après',
  filterOperator_date_between: 'Entre',
  filterOperator_date_is_empty: 'Est vide',
  filterOperator_date_is_not_empty: "N'est pas vide",
  filterOperator_datetime_equals: 'À',
  filterOperator_datetime_not_equals: 'Pas à',
  filterOperator_datetime_greater_than: 'Après',
  filterOperator_datetime_less_than: 'Avant',
  filterOperator_datetime_greater_than_or_equal: 'À ou après',
  filterOperator_datetime_less_than_or_equal: 'À ou avant',
  filterOperator_datetime_between: 'Entre',
  filterOperator_datetime_is_empty: 'Est vide',
  filterOperator_datetime_is_not_empty: "N'est pas vide",
  filterOperator_boolean_equals: 'Est',
  filterOperator_boolean_not_equals: "N'est pas",

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
  expressionBuilderSectionLabel: 'Expression',

  // Expression builder: operator picker
  exprOpAdd: 'Additionner (+)',
  exprOpSubtract: 'Soustraire (−)',
  exprOpMultiply: 'Multiplier (×)',
  exprOpDivide: 'Diviser (÷)',
  exprOpModulo: 'Modulo (%)',
  exprOpNegate: 'Négation (−x)',
  exprOpEquals: 'Égal à (=)',
  exprOpNotEqual: 'Différent de (≠)',
  exprOpLessThan: 'Inférieur à (<)',
  exprOpGreaterThan: 'Supérieur à (>)',
  exprOpLessThanOrEqual: 'Inférieur ou égal à (≤)',
  exprOpGreaterThanOrEqual: 'Supérieur ou égal à (≥)',
  exprOpAnd: 'Et',
  exprOpOr: 'Ou',
  exprOpNot: 'Non',
  exprOpIsTrue: 'Est vrai',
  exprOpIsFalse: 'Est faux',
  exprOpIsNull: 'Est nul',
  exprOpIsNotNull: "N'est pas nul",
  exprOpIf: 'Si / Alors / Sinon',
  exprOpIn: 'Dans (la valeur fait partie de)',
  exprOpDatediff: 'Différence de dates',
  exprGroupArithmetic: 'Arithmétique',
  exprGroupComparison: 'Comparaison',
  exprGroupLogical: 'Logique',
  exprGroupConditional: 'Conditionnel',
  exprGroupDate: 'Date',
  exprInputLabelUnit: 'Unité (par exemple "jour", "mois", "année")',
  exprInputLabelCondition: 'Condition',
  exprInputLabelThen: 'Alors',
  exprInputLabelElse: 'Sinon',
  exprInputLabelGeneric: (index) => `Entrée ${index}`,
  exprAddInputButton: 'Ajouter une entrée',
  exprOutputTypeLabel: 'Type de sortie :',
  exprRootNodeLabel: 'Expression',
  exprLiteralValueAriaLabel: 'Valeur littérale',
  exprUnnamedFieldLabel: 'Sans nom',
  exprPreviewNullLabel: 'null',
  exprCalculatedFieldBadgeLabel: 'Champ calculé',

  // Expression validation errors
  exprErrorMissingId: 'Le champ calculé doit avoir un identifiant.',
  exprErrorMissingLabel: 'Le champ calculé doit avoir un nom.',
  exprErrorMissingSourceId: 'Le champ calculé doit être rattaché à une source de données.',
  exprErrorMaxDepth: (maxDepth) => `L'expression est imbriquée sur plus de ${maxDepth} niveaux.`,
  exprErrorUnknownField: (fieldId) =>
    `Le champ « ${fieldId} » est introuvable parmi les champs de la source et les champs calculés.`,
  exprErrorUnreachableField: (fieldId, fieldSourceId) =>
    `Le champ « ${fieldId} » appartient à la source de données « ${fieldSourceId} », qui n'est pas liée à la source de données de ce champ.`,
  exprErrorMalformedNode:
    "Nœud d'expression incorrect : un nœud opérateur (avec un tableau `inputs`), une valeur littérale, une référence de champ ou une référence de champ joint est attendu.",
  exprErrorInsufficientArity: (operator, required, actual) =>
    `L'opérateur « ${operator} » requiert au moins ${required} entrée(s), ${actual} fournie(s).`,
  exprErrorCircularDependency: (fieldId) =>
    `Le champ calculé « ${fieldId} » crée une dépendance circulaire.`,

  // Shared aggregation function labels
  aggFnSum: 'Somme',
  aggFnCount: 'Compter',
  aggFnCountRows: 'Nombre (lignes)',
  aggFnCountValues: 'Nombre (valeurs)',
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
  chartSetupRemoveSplitByTooltip:
    'Supprimez les champs de mesure supplémentaires pour activer la division par',
  chartSetupInnerRingLabel: 'Catégorie de bague intérieure',
  chartSetupSplitByLabel: 'Diviser par (champ de série)',
  chartSetupArcLabelsTitle: "Étiquettes d'arc",
  chartSetupSplitByHelperText: 'Divise les données en une série séparée par valeur',
  chartSetupSplitByDisabledHelperText:
    'Non disponible lorsque plusieurs champs de mesure sont configurés',
  chartSetupInnerRingHelperText: 'Ajoute une bague intérieure concentrique regroupée par ce champ',
  chartSetupGaugeMinRevertedHelperText:
    'Le minimum doit être un nombre inférieur au maximum — votre saisie a été rétablie.',
  chartSetupGaugeMaxRevertedHelperText:
    'Le maximum doit être un nombre supérieur au minimum — votre saisie a été rétablie.',
  chartSetupRadiusRevertedHelperText: (min, max) =>
    `Saisissez un nombre entre ${min} et ${max}, en gardant le rayon minimum inférieur au rayon maximum — votre saisie a été rétablie.`,
  chartSetupValueClampedHelperText: (clamped) =>
    `En dehors de la plage autorisée — ajusté à ${clamped}.`,

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
  kpiSetupInvertColours: 'Inverser les couleurs (plus petit est mieux)',
  kpiSetupFixedWindowLabel: 'Fenêtre de tendance',
  kpiSetupFixedWindowNone: 'Depuis le filtre de dates',
  kpiSetupFixedWindowMonth: 'Les 30 derniers jours',
  kpiSetupFixedWindowQuarter: 'Les 90 derniers jours',
  kpiSetupFixedWindowYear: 'Les 365 derniers jours',

  // KPI widget
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
  gridSetupMeasuresSubheader: 'Mesures',
  gridSetupMeasureNotColumnHelper:
    "Les mesures agrègent l'ensemble des données : elles n'ont donc pas de valeur par ligne et ne peuvent pas être des colonnes de tableau. Utilisez-les dans un KPI ou un graphique.",
  gridSetupCFValuePlaceholder: 'valeur',

  // Map setup panel
  mapSetupMapTypeLabel: 'Type de carte',
  mapSetupValueFieldLabel: 'Champ de valeur (facultatif pour le comptage)',
  mapSetupColourSchemeLabel: 'Jeu de couleurs',
  mapSetupLegendPositionLabel: 'Position de la légende',
  mapSetupScaleFromZeroLabel: 'Évoluer à partir de zéro',
  mapSetupClickableLabel: 'Cliquable (police de filtre)',
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
  mapSetupCountryFieldLabel: 'Champ de pays',
  mapSetupCountryFieldHelperText:
    'Un champ contenant des codes ISO alpha-2, alpha-3 ou des noms de pays complets.',
  mapSetupStateFieldLabel: 'Champ d’État',
  mapSetupStateFieldHelperText:
    'Un champ contenant des noms d’États américains ou des abréviations postales à 2 lettres.',
  mapSetupUnreachableFieldWarning:
    "Ce champ ne provient pas de la source du widget ni d'une source directement liée, il ne peut donc pas être résolu et la carte s'affichera vide.",

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
  filterSetupMinAboveMaxError: 'Min. doit être inférieur à Max. — sinon le widget les inverse.',
  filterSetupStepNotPositiveError: "L'étape doit être supérieure à 0 — sinon le widget l'ignore.",
  filterSetupStepExceedsRangeError: "L'étape est plus large que la plage Min.–Max.",

  // Text setup panel
  textSetupTitleLabel: 'Titre',
  textSetupTitleHelper: 'En-tête affiché en haut du widget',
  textSetupSubtitleLabel: 'Légende',
  textSetupSubtitleHelper: "Texte plus petit sous l'en-tête",
  textSetupBodyLabel: 'Corps',
  textSetupBodyHelper: 'Contenu principal du widget ; prend en charge le texte brut',

  // Filter widget controls
  filterWidgetClearAriaLabel: 'Nettoyer le filtre',
  filterWidgetSelectAllLabel: 'Tout sélectionner',
  filterWidgetClearAllLabel: 'Tout effacer',
  filterWidgetAllLabel: 'Tous',
  filterWidgetNoOptionsLabel: 'Aucune option trouvée',
  filterWidgetNoSearchMatchesLabel: 'Aucun résultat',
  filterRankConflictMessage:
    'Un seul filtre Top-N ou Bottom-N est autorisé par page. Supprimez d’abord le filtre existant.',
  filterWidgetSelectedCount: (count) => `${count} sélectionné${count === 1 ? '' : 's'}`,
  filterWidgetExcludeLabel: 'Supprimer la sélection',
  filterWidgetExcludingLabel: '⊘ Suppression de la sélection',
  filterWidgetDateFromLabel: 'De',
  filterWidgetDateToLabel: "Jusqu'à",
  filterWidgetNoFieldConfigured:
    'Aucun champ configuré. Sélectionnez un champ dans le panneau Composer.',

  // Data source field select
  dataSourceClearFieldAriaLabel: 'Effacer le champ',
  dataSourceAddCalculatedField: 'Ajouter un champ calculé…',
  dataSourceFieldUnavailableOption: (fieldId) => `${fieldId} (indisponible)`,
  dataSourceFieldUnavailableHelperText: (fieldId) =>
    `« ${fieldId} » n'est plus disponible dans les données. Choisissez un autre champ.`,
  dataSourceFieldUnavailableGroupLabel: 'Indisponible',

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

  // Gantt chart
  ganttHiddenRowsLabel: (count) =>
    `+${count} ligne${count === 1 ? '' : 's'} non affichée${count === 1 ? '' : 's'} : augmentez la hauteur du widget pour tout voir`,

  // Color input
  colorInputClearAriaLabel: (label) => `Effacer ${label.toLowerCase()}`,
  colorInputPickerAriaLabel: (label) => `Sélecteur de couleur ${label.toLowerCase()}`,

  // KPI widget
  kpiTrendNewLabel: 'Nouveau',
  kpiTrendTargetTooltip: (value) => `Objectif : ${value}`,
  kpiTrendPreviousPeriodTooltip: (period) => `Période précédente : ${period}`,
  kpiTrendVsLabel: (period) => `vs. ${period}`,
  kpiTrendNoDateFilterHint: 'Ajoutez un filtre de date pour afficher la tendance.',
  kpiSparklineNoTimeFieldHint:
    "Ajoutez un filtre de date ou sélectionnez un champ d'heure pour afficher le sparkline.",

  // Chart widget
  chartMixedRequiresFieldsHint: 'Le graphique mixte nécessite 2 champs de mesure ou plus.',
  chartDefaultSeriesLabel: 'Valeur',
  chartEmptyCategoryLabel: '(vide)',
  chartOtherBucketLabel: 'Autre',
  chartHeatmapRequiresFieldsHint:
    "La carte thermique nécessite des champs pour l'axe des colonnes, l'axe des lignes et la valeur.",
  chartFunnelRequiresFieldsHint:
    "Le graphique en entonnoir nécessite un champ d'étape et un champ de valeur.",
  chartSankeyRequiresFieldsHint:
    'Le diagramme de Sankey nécessite des champs source, cible et valeur.',
  chartGanttRequiresFieldsHint:
    "Le diagramme de Gantt nécessite un champ d'étiquette et des champs de dates de début et de fin.",
  chartGanttDurationLabel: 'Durée :',
  chartGanttDurationDays: (days) => `${days} j`,
  chartGanttDurationHours: (hours) => `${hours} h`,
  chartCrossFilterFilteredOutLabel: 'filtré',

  // Map widget
  widgetConfigureMapFieldHint: (fieldLabel) =>
    `Utilisez l'onglet Configuration pour choisir un ${fieldLabel.toLowerCase()} et un champ de valeur.`,

  // Pivot table
  pivotCornerHeaderAriaLabel: 'En-tête de ligne/colonne',
  pivotBlankValueLabel: '(vide)',
  pivotTotalLabel: 'Total',
  pivotRowsTruncatedNotice: (shown, total) =>
    `Affichage des ${shown} premières catégories de lignes sur ${total}.`,
  pivotColumnsTruncatedNotice: (shown, total) =>
    `Affichage des ${shown} premières catégories de colonnes sur ${total}.`,

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
  aiSuggestionBarChartPrompt: (numericLabel, catLabel, sourceLabel) =>
    `Ajoute un graphique à barres montrant ${numericLabel} par ${catLabel} à partir des données ${sourceLabel}.`,
  aiSuggestionKpiPrompt: (fieldLabel, sourceLabel) =>
    `Ajoute une carte KPI montrant le total de ${fieldLabel} depuis ${sourceLabel}.`,
  aiSuggestionTablePrompt: (sourceLabel) =>
    `Ajoute un tableau de données montrant les enregistrements de ${sourceLabel}.`,
  aiSuggestionChangeToLinePrompt: (widgetTitle) =>
    `Transforme le widget « ${widgetTitle} » en graphique en courbes.`,
  aiSuggestionAddSparklinePrompt: (widgetTitle) =>
    `Ajoute une sparkline au widget KPI « ${widgetTitle} ».`,
  aiSuggestionAddDateFilterPrompt:
    'Ajoute un widget de filtre de plage de dates au tableau de bord.',
  aiSuggestionAddPagePrompt: 'Crée une nouvelle page de tableau de bord.',
  aiSuggestionSummarisePagePrompt:
    'Donne-moi un résumé exécutif des principaux enseignements de cette page — concentre-toi sur les données, les tendances et les anomalies plutôt que sur la structure de la page.',
  aiSuggestionWhatDataAvailablePrompt:
    'Quelles sources de données et quels champs sont disponibles pour construire ce tableau de bord ?',
  chatNewConversationName: 'Nouvelle conversation',
  chatSwitchConversationTooltip: 'Changer de conversation',
  chatNoConversationsLabel: 'Aucune conversation pour le moment',
  aiInsightSummaryPrompt: (widgetTitle) =>
    `Donne-moi un résumé général du widget « ${widgetTitle} » en 2 ou 3 phrases — ce qu'il montre et l'enseignement le plus important. Sois bref, sans puces.`,
  aiInsightAnalysisPrompt: (widgetTitle) =>
    `Analyse le widget « ${widgetTitle} » — identifie les tendances clés, les schémas et les valeurs notables`,
  aiInsightForecastPrompt: (widgetTitle) =>
    `Établis une prévision pour le widget « ${widgetTitle} » — quelle tendance attends-tu sur les prochaines périodes ?`,
  aiInsightCorrelationPrompt: (widgetTitle) =>
    `Montre une analyse de corrélation pour le widget « ${widgetTitle} »`,
  aiAnomalyExplainPrivatePrompt: (widgetTitle, count) =>
    `Explique ${count === 1 ? "l'anomalie détectée" : `les ${count} anomalies détectées`} dans le widget « ${widgetTitle} ». Les valeurs de données sous-jacentes sont masquées (mode privé) ; raisonne sur les causes probables en termes généraux.`,
  aiAnomalyExplainPrompt: (widgetTitle, details) =>
    `Explique les anomalies détectées dans le widget « ${widgetTitle} » :\n${details}`,
  aiAnomalyDetailLine: (axisLabel, value, annotationLabel) =>
    `- Anomalie sur l'${axisLabel} à ${value}${annotationLabel ? ` (${annotationLabel})` : ''}`,
  aiAnomalyAxisX: 'axe X',
  aiAnomalyAxisY: 'axe Y',
  chatUserDisplayName: 'Vous',
  chatComposerPlaceholder: 'Comment puis-je vous aider ?',
  chatEmptyStateTitle: "Posez-moi n'importe quelle question sur votre tableau de bord",
  chatEmptyStateSubtitle: 'Je peux ajouter des widgets, analyser vos données et plus encore',
  chatVoiceInputStart: 'Démarrer la saisie vocale',
  chatVoiceInputStop: 'Arrêter la saisie vocale',
  chatMessageCopyTooltip: 'Copier',
  chatMessageCopiedTooltip: 'Copié\u00a0!',
  chatMessageCopyAriaLabel: 'Copier le message',
  chatMessageRetryTooltip: 'Réessayer',
  chatReasoningThinkingLabel: 'Réflexion en cours…',
  chatReasoningSectionLabel: 'Raisonnement',
  chatComposerStopGeneratingLabel: 'Arrêter la génération',
  chatComposerSendMessageLabel: 'Envoyer le message',
  chatMessageTokenCount: (count) =>
    `${count.toLocaleString('fr')} ${count === 1 ? 'jeton' : 'jetons'}`,
  chatMessageTurnCount: (count) => `${count} ${count === 1 ? 'tour' : 'tours'}`,

  // AI chat tool-call card titles
  chatToolLabelGetDashboardState: 'Obtenir l’état du tableau de bord',
  chatToolLabelListPages: 'Lister les pages',
  chatToolLabelSetDashboardTitle: 'Définir le titre du tableau de bord',
  chatToolLabelAddPage: 'Ajouter une page',
  chatToolLabelRenamePage: 'Renommer la page',
  chatToolLabelRemovePage: 'Supprimer la page',
  chatToolLabelSetActivePage: 'Changer de page',
  chatToolLabelAddWidget: 'Ajouter un widget',
  chatToolLabelUpdateWidget: 'Mettre à jour le widget',
  chatToolLabelRemoveWidget: 'Supprimer le widget',
  chatToolLabelSetWidgetLayout: 'Définir la disposition du widget',
  chatToolLabelSetWidgetWidth: 'Définir la largeur du widget',
  chatToolLabelSetWidgetForecast: 'Définir la prévision du widget',
  chatToolLabelAddPageFilter: 'Ajouter un filtre de page',
  chatToolLabelRemovePageFilter: 'Supprimer le filtre de page',
  chatToolLabelAddWidgetFilter: 'Ajouter un filtre de widget',
  chatToolLabelRemoveWidgetFilter: 'Supprimer le filtre de widget',
  chatToolLabelSummarisePage: 'Résumer la page',
  chatToolLabelApplyBulkUpdate: 'Appliquer une mise à jour groupée',
  chatToolLabelRenameThread: 'Renommer la conversation',
  chatToolLabelQueryDataSource: 'Interroger la source de données',
  chatApprovalWillRemoveWidgets: 'Supprimera ces widgets',
  chatApprovalWillRemovePages: 'Supprimera ces pages',
  chatApprovalWillRemoveFilters: 'Supprimera ces filtres',
  chatApprovalWillOrphanWidgets: 'Laissera ces widgets sur aucune page',
  chatApprovalUpdatedWidgetCount: 'Widgets mis à jour',

  // Chart unsupported messages
  chartUnsupportedFieldNotFound:
    'Cette configuration de graphique utilise des champs qui ne sont pas disponibles dans la source du widget ou dans une source directement associée.',
  chartUnsupportedMixedCrossSource:
    "Cette configuration de graphique mélange des champs provenant de différentes sources d'une manière qui ne dispose pas encore d'un seul grain d'agrégation sécurisé.",
  chartUnsupportedScatterCrossSource:
    'Les nuages ​​de points ne prennent pas encore en charge les combinaisons de champs entre sources.',
  chartUnsupportedMeasure:
    "Un champ de mesure n'a pas de valeur par ligne : il ne peut donc servir que de valeur d'un graphique — jamais d'axe de catégories, de répartition, de couleur ou de taille — et pas du tout dans les nuages de points ni les diagrammes de Gantt, qui tracent une marque par ligne brute.",
  chartUnsupportedDefault: "Cette configuration de graphique n'est pas encore prise en charge.",
  chartForecastSeriesLabel: 'Prévision',

  // Grid summary labels
  gridSummaryLabelSum: 'Total :',
  gridSummaryLabelAvg: 'Moyenne :',
  gridSummaryLabelCount: 'Nombre :',
  gridSummaryLabelCountDistinct: 'Uniques :',
  gridSummaryLabelCountValues: 'Valeurs :',
  gridSummaryLabelMin: 'Min. :',
  gridSummaryLabelMax: 'Max. :',
  gridMutationError: "Échec de l'enregistrement des modifications",

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
  widgetAggPrefixCountValues: 'Nombre de valeurs de',
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

  // Canvas empty state
  canvasEmptyTitle: 'Le canevas est vide',
  canvasEmptyEditModeHint:
    'Utilisez le panneau Composer pour ajouter des widgets ou faites-les glisser ici.',
  canvasEmptyViewModeHint: 'Passez en mode Édition pour ajouter des widgets.',

  // Map widget legend
  mapLegendAriaLabel: (fieldLabel, min, max) =>
    `Échelle de couleurs de ${fieldLabel} de ${min} à ${max}`,

  // Date range presets (calendar year / quarter)
  dateRangePresetThisCalendarYear: 'Cette année',
  dateRangePresetLastCalendarYear: "L'année dernière",
  dateRangePresetLast2CalendarYears: 'Les 2 dernières années',
  dateRangePresetThisQuarter: 'Ce trimestre',
  dateRangePresetLastQuarter: 'Le trimestre dernier',
  dateRangePresetThisAndLastQuarter: 'Ce trimestre et le précédent',
  dateRangePresetCustom: 'Personnalisé',
  dateRangePresetGroupRolling: 'Glissant',
  dateRangePresetGroupCalendarYear: 'Année civile',
  dateRangePresetGroupQuarter: 'Trimestre',

  // Filters drawer (default view)
  filtersDefaultViewLabel: 'Vue par défaut',

  // Quick filter bar
  quickFilterBarEnableFilter: 'Activer le filtre',
  quickFilterBarDisableFilter: 'Désactiver le filtre',
  quickFilterBarRemoveFilter: 'Supprimer le filtre',

  // Cross-filter mode bar
  crossFilterBarModeFilter: 'Filtre',
  crossFilterBarModeHighlight: 'Surligner',
  crossFilterBarModePerChart: 'Par graphique',
  crossFilterBarAllPages: 'Toutes les pages',

  // Chart setup panel
  aggregationLockedHelperText:
    'Compte les lignes — choisissez un champ de valeur pour additionner, faire la moyenne, etc.',

  // Funnel setup
  chartSetupFunnelLabelFormatLabel: "Format d'étiquette",
  chartSetupFunnelLabelFormatValue: 'Valeur',
  chartSetupFunnelLabelFormatPercent: '% du total',
  chartSetupFunnelLabelFormatConversion: 'Taux de conversion',
  chartSetupFunnelLabelPlacementLabel: "Position de l'étiquette",
  chartSetupFunnelLabelPlacementInside: 'Intérieur',
  chartSetupFunnelLabelPlacementOutsideStart: 'Extérieur gauche',
  chartSetupFunnelLabelPlacementOutsideEnd: 'Extérieur droit',
  chartSetupFunnelGapLabel: 'Espacement des sections (px)',
  chartSetupFunnelShapeLabel: 'Forme',
  chartSetupFunnelShapeLinear: 'Linéaire',
  chartSetupFunnelShapeBump: 'Courbe (bombée)',
  chartSetupFunnelShapeStep: 'Palier',
  chartSetupFunnelShapePyramid: 'Pyramide',
  chartSetupFunnelStyleLabel: 'Style',
  chartSetupFunnelStyleFilled: 'Rempli',
  chartSetupFunnelStyleOutlined: 'Contour',

  // Sankey setup
  chartSetupSankeySourceLabel: 'Champ source (origine)',
  chartSetupSankeySourceHelperText: 'Champ catégoriel pour le nœud de départ de chaque flux',
  chartSetupSankeyTargetLabel: 'Champ cible (destination)',
  chartSetupSankeyTargetHelperText: "Champ catégoriel pour le nœud d'arrivée de chaque flux",
  chartSetupSankeyValueHelperText: 'Champ numérique additionné par lien source → cible',
  chartSetupSankeyLinkColorLabel: 'Couleur du lien',
  chartSetupSankeyLinkColorSource: 'Depuis le nœud source',
  chartSetupSankeyLinkColorTarget: 'Depuis le nœud cible',
  chartSetupSankeyShowValuesLabel: 'Afficher les valeurs sur les liens',

  // Pie/donut & funnel category fields
  chartSetupXFieldPieDonutLabel: 'Catégorie des tranches',
  chartSetupXFieldPieDonutHelperText: 'Chaque valeur unique devient une tranche',
  chartSetupXFieldFunnelLabel: "Champ d'étape",
  chartSetupXFieldFunnelHelperText: "Champ catégoriel définissant chaque étape de l'entonnoir",
  chartSetupYMeasurePieDonutLabel: 'Valeur des tranches',
  chartSetupFieldlessCountSplitByTooltip:
    'Choisissez un champ de mesure pour activer la division par',
  chartSetupSplitByFieldlessCountHelperText:
    "Non disponible pour un comptage sans champ — choisissez d'abord un champ de mesure",

  // KPI setup panel
  kpiSetupDateRangePresetLabel: 'Plage',

  // Map setup panel
  mapSetupValueFieldHelperText: 'Laissez vide pour compter les lignes',
  mapSetupInteractionsTitle: 'Interactions',
  mapSetupInteractionsDescription: "Lorsque vous cliquez sur d'autres widgets, cette carte…",

  // Text setup panel
  textSetupPromptLabel: 'Invite',
  textSetupPromptHelper:
    "Décrivez ce que l'IA doit écrire — elle peut interroger les sources de données de cette page",
  textSetupAiModeLabel: 'Mode IA',

  // Accessible names for otherwise-unlabeled form controls
  exprNodeKindAriaLabel: "Type d'entrée",
  exprFieldAriaLabel: 'Champ',
  exprAggregationAriaLabel: 'Agrégation',
  exprLiteralTypeAriaLabel: 'Type littéral',
  exprBooleanValueAriaLabel: 'Valeur booléenne',
  filterRankDirectionAriaLabel: 'Sens du classement',
  filterRankCountLabel: "Nombre d'éléments",
  filterSliderMinimumAriaLabel: (label) => `${label} minimum`,
  filterSliderMaximumAriaLabel: (label) => `${label} maximum`,
  filterRelativeDateUnitAriaLabel: 'Unité de temps',
  filterRelativeDateDirectionAriaLabel: 'Direction',
  filterDateModeAriaLabel: 'Type de valeur de date',
  formulaOperatorAriaLabel: 'Opérateur',
  chartAnnotationAxisAriaLabel: 'Axe de la ligne de référence',
  gridConditionFieldAriaLabel: 'Champ de condition',
  gridConditionOperatorAriaLabel: 'Opérateur de condition',
  gridConditionStyleAriaLabel: 'Style de condition',
  gridConditionValueAriaLabel: 'Valeur de condition',

  // KPI trend sentiment (screen-reader only)
  kpiTrendFavorableLabel: 'favorable',
  kpiTrendUnfavorableLabel: 'défavorable',
  kpiTrendNoChangeLabel: 'aucun changement',

  // Canvas accessibility
  canvasResizeColumnsAriaLabel: 'Redimensionner les colonnes',
  canvasMoveWidgetUpAriaLabel: 'Déplacer le widget vers le haut',
  canvasMoveWidgetDownAriaLabel: 'Déplacer le widget vers le bas',
  canvasMoveWidgetLeftAriaLabel: 'Déplacer le widget vers la gauche',
  canvasMoveWidgetRightAriaLabel: 'Déplacer le widget vers la droite',
  gridColumnMoveUpAriaLabel: 'Déplacer la colonne vers le haut',
  gridColumnMoveDownAriaLabel: 'Déplacer la colonne vers le bas',
  canvasRegionAriaLabel: 'Zone du tableau de bord',
  sidebarPanelOpenedAnnouncement: (label) => `Panneau ${label} ouvert`,
  sidebarPanelClosedAnnouncement: 'Panneau fermé',
  canvasResizeAnnouncement: (span, total) => `Colonne redimensionnée à ${span} sur ${total}`,
  canvasWidgetMovedAnnouncement: 'Widget déplacé',
  canvasWidgetAddedAnnouncement: 'Widget ajouté',

  // Chart / KPI / map text alternatives
  ganttChartAriaLabel: (itemCount, from, to, details) =>
    `Diagramme de Gantt avec ${itemCount} ${itemCount === 1 ? 'élément' : 'éléments'} du ${from} au ${to}. ${details}.`,
  ganttItemAriaLabel: (label, from, to, duration) => `${label} : du ${from} au ${to} (${duration})`,
  sankeyLinkAriaLabel: (source, target, value) => `${source} vers ${target} : ${value}`,
  sankeyChartAriaLabel: (nodeCount, linkCount, details) =>
    `Diagramme de flux Sankey avec ${nodeCount} ${nodeCount === 1 ? 'nœud' : 'nœuds'} et ${linkCount} ${linkCount === 1 ? 'lien' : 'liens'}. ${details}.`,
  mapRegionAriaLabel: (region, valueLabel, value) => `${region} : ${valueLabel} ${value}`,
  kpiGaugeAriaLabel: (value, max, percent) => `Jauge : ${value} sur ${max} (${percent} %).`,
  kpiSparklineAriaLabel: (pointCount, trend, from, to) => {
    let trendText = 'stable';
    if (trend === 'up') {
      trendText = 'en hausse';
    } else if (trend === 'down') {
      trendText = 'en baisse';
    }
    return `Sparkline avec ${pointCount} points, ${trendText}, du ${from} au ${to}.`;
  },
  mapChartAriaLabel: (measure, regionCount, min, max) =>
    `Carte choroplèthe${measure ? ` de ${measure}` : ''} avec ${regionCount} ${regionCount === 1 ? 'région' : 'régions'}, valeurs de ${min} à ${max}.`,
  lineageGraphAriaLabel: (sourceCount, relationshipCount) =>
    `Graphique des relations de données avec ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'} et ${relationshipCount} ${relationshipCount === 1 ? 'relation' : 'relations'}.`,
};

export const fr: Localization = getStudioLocalization(frLocaleText);

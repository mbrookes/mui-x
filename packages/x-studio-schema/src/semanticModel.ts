/**
 * The semantic model: what the data MEANS, as distinct from what it is.
 *
 * A data source describes physical shape — there is a column `amt`, it holds numbers. The semantic
 * model describes business meaning — `orders` joins to `customers` through this pair of keys,
 * `profit` is `revenue - cost`, and `profit` is a MEASURE (one aggregate over the filtered set)
 * rather than a calculated column (a value per row). None of that is recoverable from a schema;
 * somebody decided it.
 *
 * ## Why it has its own identity (ADR 0004)
 *
 * These definitions used to sit directly on `StudioDoc` as `relationships` and `expressionFields`.
 * Not because anyone chose the workbook-embedded branch of the BI fork — because `StudioDoc` is
 * where dashboard state lives, which is a fine reason to put a field somewhere and not a reason to
 * pick an architecture.
 *
 * The consequence of leaving it there: two dashboards over the same warehouse redeclare the model
 * independently, and fixing a join in one leaves every other dashboard on the old one **silently**,
 * because a wrong join produces numbers rather than errors.
 *
 * Giving the model an `id` is what turns "the doc contains these arrays" into "the doc names a
 * model". The model still travels inline by default, so authoring is unchanged and a dashboard is
 * still a self-contained artifact — but a host that wants one governed definition of `revenue` can
 * now supply it (see {@link resolveSemanticModel}) instead of needing a schema change first.
 *
 * This is deliberately NOT a shared semantic layer. There is no authoring surface for a shared
 * model, no permission story, and no versioning of a model apart from its dashboard. Those are
 * ADR 0004's option 3. This is the shape that leaves option 3 reachable, taken at the only point
 * where it costs one type and no migration.
 */
import type { StudioRelationship } from './dataTypes';
import type { StudioExpressionField } from './expressionTypes';

/**
 * The id every document-local model carries unless a host names one deliberately.
 *
 * A constant rather than a generated id, and that is the point: two dashboards authored against
 * the same host-provided model must NAME the same thing for {@link resolveSemanticModel} to hand
 * them the same definitions. A per-document uuid would make every dashboard's model unshareable by
 * construction, which is the state this ADR exists to leave.
 */
export const DEFAULT_SEMANTIC_MODEL_ID = 'inline';

/** The definitions of what a dashboard's data means. */
export interface StudioSemanticModel {
  /**
   * Identity of the model, not of the dashboard.
   *
   * Two documents carrying the same `id` are asserting they mean the same model, which is what
   * lets a host override both with one governed definition.
   */
  id: string;
  /** Human-readable name, for when a host offers a choice of models. */
  label?: string;
  /** How sources join — cardinality, key fields, junction tables. */
  relationships: StudioRelationship[];
  /** Calculated columns and measures. */
  expressionFields: StudioExpressionField[];
}

/** An empty model under the default id — what a fresh dashboard starts with. */
export function createDefaultSemanticModel(): StudioSemanticModel {
  return { id: DEFAULT_SEMANTIC_MODEL_ID, relationships: [], expressionFields: [] };
}

/**
 * The model a dashboard actually resolves against: its own, unless a host supplied one under the
 * same id.
 *
 * The one indirection ADR 0004 asks for. Override by ID rather than by a flag or a separate
 * pointer field, because that is what makes the two branches the same mechanism: a document that
 * has never met a shared model resolves to its inline copy, and the same document opened in a host
 * with a governed `inline`-named model resolves to that one, with no edit to the document.
 *
 * **The inline model is not deleted when it is overridden.** It stays as the document's own
 * definition, so a dashboard exported to JSON is still self-contained and still opens correctly in
 * a host that has no model registry at all. That is the property that keeps this reversible.
 * @param state The doc (the document's own model) and runtime (what the host supplied).
 * @returns The effective model.
 */
export function resolveSemanticModel(state: {
  doc: { semanticModel: StudioSemanticModel };
  runtime?: { semanticModels?: Record<string, StudioSemanticModel> };
}): StudioSemanticModel {
  const own = state.doc.semanticModel;
  return state.runtime?.semanticModels?.[own.id] ?? own;
}

/**
 * True when the effective model came from the host rather than from the document.
 *
 * The reducer needs this: its relationship and expression-field handlers write to the DOCUMENT's
 * model, so with a host model active an edit would be applied to something nothing reads. Editing
 * a shared model is ADR 0004 option 3 — it needs a permission and versioning story this does not
 * have — so the handlers decline instead, visibly.
 * @param state The doc and runtime.
 * @returns Whether a host-provided model is in effect.
 */
export function isSemanticModelExternal(state: {
  doc: { semanticModel: StudioSemanticModel };
  runtime?: { semanticModels?: Record<string, StudioSemanticModel> };
}): boolean {
  return resolveSemanticModel(state) !== state.doc.semanticModel;
}

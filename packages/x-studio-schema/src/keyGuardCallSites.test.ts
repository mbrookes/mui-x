import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KEY_GUARD_FAMILY,
  REPO_ROOT,
  findGuardReExports,
  findGuardSites,
  findIndirectGuardReferences,
  readGuardNames,
} from 'test/utils/guardCallSites';

/**
 * `isSafeKey`'s call-site inventory — the family whose enumeration was wrong by 78%.
 *
 * ── Why this file exists ──
 *
 * A sweep reported this guard *"swept clean: isSafeKey 4 sites, 4/4 KILLED"*. It counted the
 * four places the guard is spelled `isSafeKey` AT THE CALL. `applyMutation.ts` opens with
 *
 *     const isSafePatchKey = isSafeKey;
 *
 * and that one line gives the same function FOURTEEN more shipped call sites, none of which
 * the sweep saw, and eight of which had no test at all. A reader of "4 sites, 4/4 KILLED"
 * would conclude the family was fully pinned while 44% of it was unobserved.
 *
 * The escape is not exotic — a module-local alias is ordinary TypeScript, and the CSS-guard
 * scan written one round earlier NAMED it in its docblock as an escape it had closed. It had
 * closed it for the two modules it hardcoded, and this family was not one of them. So the
 * scan is now generic over a {@link GuardFamily} and this family is registered:
 * `test/utils/guardCallSites.ts` resolves the alias, and the completeness test below is what
 * makes the count 18 rather than whatever anyone remembers.
 *
 * ── What a row claims ──
 *
 * Every row is one call site, derived from the AST. `pinnedBy` names the test measured to
 * fail when that call is replaced by a pass-through that always returns `true` — measured, one
 * site at a time, at project `x-studio-schema`. Fourteen rows carry one.
 *
 * The other four carry `unpinnable` instead, and that is the deliberate part. Each is a real
 * guard that no test can pin, because a neighbouring guard already rejects every input that
 * would reach it — measured by mutating the neighbour, not argued from reading. Recording them
 * as rows, with the neighbour named, is what stops the next round from either (a) reporting
 * them as missing protection or (b) deleting them because "nothing failed". Both have happened
 * in this codebase; `rebalanceRowSpans`' docblock records the first, and the second is why a
 * live budget guard was lost a round earlier.
 *
 * ── Why there were seven and are now four ──
 *
 * `unpinnable` claims *no test can pin this*. For three of the seven that was too strong: what
 * was measured is that no REACHABLE input pins them, because no producer in this package can
 * put a prototype-hazard own key into `state.widgets` (six producers x three hazard keys,
 * 18/18 clean). A test that FABRICATES that pre-state with one `Object.defineProperty` makes
 * each guard's removal observable with its named neighbour fully intact, and those three rows
 * now carry a `pinnedBy` and a `note` saying the pre-state is unreachable. The distinction is
 * not pedantic: the label exists to stop a future round deleting these calls on the strength
 * of their silence, and a live discriminating test is a strictly stronger stop than a
 * paragraph of prose.
 *
 * One of the three also had the WRONG REASON, which is the more useful correction — a label
 * whose whole job is to be a claim a reader can check had a claim that does not check out. See
 * the `note` on `isSafeKey(widget.id)#2`.
 *
 * A row's `site` id is `<file>:<guard>(<first argument>)#<n>`, where `#n` disambiguates calls
 * whose text is identical. Several `isSafeKey(key)` calls in one file therefore have ordinals
 * that ARE positional among themselves — the one case where the rows are interchangeable, and
 * why each `what` names the enclosing handler a reader can search for.
 */

type KeyGuardEntry = {
  /** `<file>:<guard>(<first argument>)#<n>`, exactly as the scan derives it. */
  site: string;
  /** Which call this is — the enclosing handler, and what the key would otherwise do. */
  what: string;
  /**
   * Optional standing caveat about the row itself — what the pinning test had to fabricate,
   * or what a previous version of this row claimed and measurement refuted. Not a substitute
   * for `pinnedBy`/`unpinnable`; both of those stay mandatory.
   */
  note?: string;
} & (
  | { pinnedBy: { file: string; test: string }; unpinnable?: never }
  /** The neighbouring guard that already rejects everything reaching this one, measured. */
  | { unpinnable: string; pinnedBy?: never }
);

const P = 'packages/x-studio-schema/src/';

const KEY_GUARD_INVENTORY: KeyGuardEntry[] = [
  // ── The four sites spelled `isSafeKey` at the call — the ones the old sweep counted ──
  {
    site: `${P}docScreening.ts:isSafeKey(id)#0`,
    what: '`screenWidgets` — drops a widget whose MAP KEY is a prototype-hazard id, at both the factory and the persistence load boundary. This is why no hazard id can ever be a live widget, which is what makes four of the rows below unpinnable',
    pinnedBy: {
      file: `${P}statePersistence.test.ts`,
      test: 'drops a persisted "__proto__" widget key from the widgets map (finding 1.2)',
    },
  },
  {
    site: `${P}docScreening.ts:isSafeKey(pageId)#0`,
    what: '`screenPagesShape` — the same screen for a page map key',
    pinnedBy: {
      file: `${P}factories.test.ts`,
      test: 'drops a prototype-hazard page key and a page carrying a prototype-hazard own key',
    },
  },
  {
    site: `${P}internalGuards.ts:isSafeKey(key)#0`,
    what: '`stripUnsafeOwnKeys` — the shared rebuild that drops hazard own keys from any record',
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'addFilter strips a prototype-hazard own key from filter.scope before appending (Tier2)',
    },
  },
  {
    site: `${P}parseStateMutation.ts:isSafeKey(value)#0`,
    what: '`isSafeId` — the wire boundary, which REJECTS a whole mutation carrying a hazard id',
    pinnedBy: {
      file: `${P}parseStateMutation.test.ts`,
      test: 'rejects an addWidget widget with id "%s"',
    },
  },

  // ── The fourteen reached through the `isSafePatchKey` alias ──
  {
    site: `${P}applyMutation.ts:isSafeKey(widget.id)#0`,
    what: '`isInsertableAddedWidget` — screens a bulk `addedWidgets[]` id before it becomes a `state.widgets` key',
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'an added widget with a __proto__ id does not re-prototype nextWidgets',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(key)#0`,
    what: "`removeSpanEntries` — screens each SURVIVING span key while rebuilding a page's `widgetColSpans`. Reachable from the public `Studio initialState` prop, whose `widgetColSpans` no screen sweeps",
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'removeWidget drops an unsafe key from every page it rebuilds spans for',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(pid)#0`,
    what: '`normalizePersistedPages` — drops a hazard page key from a persisted/hand-edited doc',
    pinnedBy: {
      file: `${P}statePersistence.test.ts`,
      test: 'drops a persisted "__proto__" page key and does not re-prototype the pages map (finding 1.2)',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(key)#1`,
    what: "`normalizePersistedPages`' span rebuild — the load-boundary twin of `removeSpanEntries`",
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'drops a prototype-hazard widgetColSpans key from a persisted page',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(id)#0`,
    what: '`addPage` — the new page id, which becomes a `state.pages` key',
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'addPage with a prototype-hazard id is a no-op (Tier 3)',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(widget.id)#1`,
    what: '`addWidget` — the new widget id, which becomes a `state.widgets` key',
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'addWidget with a prototype-hazard id is a no-op (Tier 3)',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(key)#2`,
    what: "`updateWidget`'s config-patch loop — each key of a server-built `config` patch",
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'a config patch with an own __proto__ key does not pollute Object.prototype (1.2)',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(key)#3`,
    what: "`updateWidget`'s `changes` merge loop — each key of a wholesale widget merge",
    unpinnable:
      'subsumed by the `MERGEABLE_WIDGET_CHANGE_KEYS.has(key)` allow-list three lines below, which admits only real, mergeable `StudioWidget` fields and therefore rejects every hazard key first. Measured: this guard alone SURVIVES, the allow-list alone is KILLED by 3 tests, and both together are KILLED',
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(widgetId)#0`,
    what: '`setWidgetColSpan` — the widget id before the `newSpans[widgetId] = clamped` write',
    note: 'Was `unpinnable`. Reaching this guard needs a hazard id already admitted as a real widget, which `screenWidgets`/`addWidget`/`isInsertableAddedWidget` all prevent — so NO REACHABLE input pins it, and the pinning test fabricates that pre-state with `Object.defineProperty`. Its named neighbour `Object.hasOwn(state.widgets, widgetId)` is intact in that test and passes, so only this guard stops the write. The neighbour is separately pinned by "no-ops a set_widget_width for a row id that is not a real widget"',
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'setWidgetColSpan refuses a widget id that is a prototype-hazard own key of state.widgets',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(id)#1`,
    what: "`setWidgetColSpan`'s `canWriteSpan` — the row-mate a rebalance may write a span for",
    note: 'The one row of the seven that is neither falsified nor positively verified. A differential hazard probe reached this rebalance with a hazard row-mate and produced NO behaviour difference with either conjunct neutralised, or both — so unlike its three neighbours it could not be converted to a `pinnedBy`, and unlike them nothing contradicts its stated reason either. The measurement below is all the evidence there is; deliberately not upgraded on reasoning alone',
    unpinnable:
      'subsumed by the `Object.hasOwn(state.widgets, id)` conjunct it is ANDed with, in the same predicate. Measured: this conjunct alone SURVIVES, the `hasOwn` conjunct alone is KILLED by "does not rebalance a span onto a phantom row-mate sharing the row"',
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(widget.id)#2`,
    what: "`applyBulkUpdate`'s re-added-id set — an id named by both `removedWidgetIds` and `addedWidgets`",
    note: 'Was `unpinnable` FOR A REASON THAT IS MEASURABLY WRONG. The row used to say the `removedWidgetIdSet.has(widget.id)` conjunct beside it subsumes this guard, because `removedWidgetIds` is `isSafeId`-screened at the wire. Both halves fail: a server-built bulk (`executeToolOnState` bypasses the parser — the reducer guards mutations the server builds WITHOUT it, so leaning on the wire screen is circular here) puts a hazard id straight into the set and `has` returns TRUE, and with that neighbour neutralised the pinning test below still passes while a hazard-free idempotent-add test fails. So the neighbour is load-bearing for the replace semantics and screens no hazard at all. What actually keeps this site inert on reachable input is the `screenWidgets`/`isInsertableAddedWidget` chain that stops a hazard id being a live widget; the pinning test fabricates that pre-state instead',
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'applyBulkUpdate does not count a prototype-hazard id as a re-added widget',
    },
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(key)#4`,
    what: "`applyBulkUpdate`'s `clampedSpans` rebuild — each key of a wire-supplied `widgetColSpans`",
    unpinnable:
      'subsumed by `enforceLayoutColSpans`\' orphan prune a few lines below, which deletes every span key not naming a member of the sanitized rows — and rows are filtered against `validRowIds`, which no hazard id can enter. Measured: this guard alone SURVIVES 1123/1123, the prune alone is KILLED by 5 tests, and BOTH together are KILLED by 6 — the sixth being "never lets a wire-supplied unsafe span key survive an applyBulkUpdate", written to observe the pair',
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(id)#2`,
    what: "`applyBulkUpdate`'s merge-branch `canWriteSpan` — the row-mate the rebalance may write to",
    unpinnable:
      "UNREACHABLE at this caller, both conjuncts: `rowIds` here is `sanitizedRows`, already filtered by `validRowIds`, and `anchorIds` is `keys(clampedSpans)`, already filtered by this same guard. Measured: either conjunct alone, and both, leave the suite green. Kept for the reason `rebalanceRowSpans`' docblock gives — unreachable-at-today's-callers is a fact about the callers, not the guard",
  },
  {
    site: `${P}applyMutation.ts:isSafeKey(update.widgetId)#0`,
    what: "`applyBulkUpdate`'s `updatedWidgets` loop — the id of a widget being merged",
    note: "Was `unpinnable`, subsumed by the `Object.hasOwn(nextWidgets, update.widgetId)` existence check just below, as that site's own comment says. True of every REACHABLE input — no hazard id can be an own key of the widgets map — so the pinning test fabricates one; the `hasOwn` neighbour is intact in that test and passes",
    pinnedBy: {
      file: `${P}applyMutation.test.ts`,
      test: 'applyBulkUpdate.updatedWidgets refuses a prototype-hazard widget id',
    },
  },
];

describe('isSafeKey — call-site inventory', () => {
  const guards = readGuardNames(KEY_GUARD_FAMILY);
  const found = findGuardSites(KEY_GUARD_FAMILY);

  it('reads the family from the guard module itself', () => {
    expect(guards).toEqual(['isSafeKey']);
    expect(KEY_GUARD_FAMILY.modules.every((m) => existsSync(join(REPO_ROOT, m)))).toBe(true);
  });

  it('finds exactly the call sites the inventory records — no more, no fewer', () => {
    // THE assertion. The previous enumeration of this family said four; there are eighteen,
    // and the difference is one `const isSafePatchKey = isSafeKey;`. A new call site — under
    // any local name, through the package barrel, through the `@mui/x-studio-schema`
    // specifier — fails this until a row is written for it.
    expect(found.map((s) => s.site).sort()).toEqual(
      KEY_GUARD_INVENTORY.map((row) => row.site).sort(),
    );
  });

  it('has no RENAMING re-export of the guard', () => {
    // `x-studio-schema/src/index.ts` re-exports `unsafeKeys.ts` PLAINLY, which the scan
    // follows. A renaming re-export it cannot follow, so it must not exist.
    expect(findGuardReExports(KEY_GUARD_FAMILY)).toEqual([]);
  });

  it('has no guard referenced anywhere except as the callee of a call', () => {
    // A module-scope `const g = isSafeKey;` IS resolved — that is the whole point of this
    // file. Anything else (a callback, a `let`, an object-literal property, a rebinding
    // inside a function body) is reported here rather than silently subtracting a row.
    expect(findIndirectGuardReferences(KEY_GUARD_FAMILY)).toEqual([]);
  });

  it.each(KEY_GUARD_INVENTORY.filter((row) => row.pinnedBy))(
    'names a live pinning test for $site',
    (entry) => {
      const file = join(REPO_ROOT, entry.pinnedBy!.file);
      expect(existsSync(file), `missing test file ${entry.pinnedBy!.file}`).toBe(true);
      expect(
        readFileSync(file, 'utf8'),
        `${entry.pinnedBy!.file} no longer contains the test named for ${entry.site}`,
      ).toContain(entry.pinnedBy!.test);
    },
  );

  it('accounts for every site as either pinned or explicitly unpinnable', () => {
    // No row may be silent. `unpinnable` is a claim a reader can check — it names the
    // neighbouring guard and the measurement — not a shrug.
    const unaccounted = KEY_GUARD_INVENTORY.filter((row) => !row.pinnedBy && !row.unpinnable);
    expect(unaccounted).toEqual([]);
    // Stated as a ratio rather than left implicit: this family is 78% pinned, and the rest is
    // defence-in-depth that is subsumed by something that IS pinned. The previous enumeration
    // reported "4 sites, 4/4 KILLED", which reads as 100%. Three of the seven rows that once
    // said `unpinnable` are pinned by tests that fabricate an unreachable pre-state; each of
    // those carries a `note` saying so, because "pinned" and "pinned only from a state no
    // producer can build" are different claims.
    expect(KEY_GUARD_INVENTORY.filter((row) => row.pinnedBy)).toHaveLength(14);
    expect(KEY_GUARD_INVENTORY.filter((row) => row.unpinnable)).toHaveLength(4);
  });
});

# Architecture review — `@mui/x-studio-schema` (iteration 8)

Fresh ground-up review of every file in `packages/x-studio-schema/src/` plus `ARCHITECTURE.md`,
re-derived from the current working tree (no prior finding assumed to still apply). All four
findings below were **reproduced against the real source** with a scratch `tsx` script (dispatch
corruption, spans-only layout wipe, null-config poisoning, null-thread crash all confirmed at
runtime).

**Summary: 0 Tier 1 · 4 Tier 2.**

The package is in very good shape after seven hardening rounds — the reducer's no-op contract,
the id/key hygiene, the load-boundary totality, and the parser/reducer table symmetry all check
out. What remains are gaps at the *seams between* previously-fixed defenses: the dispatch lookup
that every hardened handler sits behind, the one-field-present case the "both-absent" layout fix
left open, the add-path counterpart of the load-boundary null-config coercion, and the entry-level
counterpart of the `ai.threads` array check.

---

## Tier 2 findings

### 2.1 — Reducer dispatch resolves `mutation.type` through the prototype chain; a `type: 'constructor'` replaces the doc with `{}`

**Where:** `src/applyMutation.ts:1456` (`applyDocMutation`) and `:1478` (`mutationLabel`).

```ts
const handler = MUTATION_HANDLERS[mutation.type] as MutationHandler<StateMutation> | undefined;
return handler ? handler.apply(doc, mutation.args) : doc;
```

`MUTATION_HANDLERS` is a plain object literal, so the bracket lookup resolves prototype-chain
members. Verified at runtime against the real module:

- `applyDocMutation(doc, { type: 'constructor', args: {} })` → `handler` is `Object`, and
  `handler.apply(doc, args)` is `Function.prototype.apply` — it *invokes `Object()`* and returns a
  **fresh `{}`**, silently replacing the entire doc (worse than a throw: a caller that commits the
  result has wiped the dashboard; `serializeDoc({})` then throws on the next save).
- `type: 'toString'` → the "doc" becomes the string `"[object Object]"`.
- `type: '__proto__'` → `TypeError: handler.apply is not a function` mid-apply.
- `mutationLabel({ type: 'constructor' })` → `TypeError: handler.label is not a function`.

This directly contradicts the function's own documented contract — the code comment says "*a value
arriving over the wire … is not guaranteed to match, so guard the lookup at runtime too*", and
`ARCHIT
// ── Studio active locale ────────────────────────────────────────────────────
//
// `<Studio localeText={frLocaleText} />` chose the STRINGS but nothing chose the
// FORMATTERS: every `Intl` call in the package passed `undefined` as its locale
// argument, which resolves to the browser's locale. A French bundle rendered in an
// `en-US` browser therefore printed French labels next to `1,234.5` and
// `Jan 5, 2026` — the numbers and dates silently disagreeing with the words beside
// them. `<Studio locale="fr-FR" />` closes that: it names one BCP-47 tag that every
// formatter in the package resolves against.
//
// Why a module-level value rather than a prop threaded to each formatter: the
// formatters are plain (non-React) helpers — `formatNumber`, `formatDateValue`,
// `shortMonthName`, `formatCrossFilterValue` — reached from ~40 call sites spread
// across widget internals, aggregation code, and CSV export, most of which have no
// React context in scope at all. `StudioProvider` publishes the resolved locale here
// during its render, so every one of those helpers picks it up with no signature
// change and no call-site churn.
//
// The consequence to know about: two `<Studio>` instances mounted simultaneously with
// DIFFERENT `locale` props share this single value, so the last one to render wins for
// both. That is an accepted trade — Studio is a full-page dashboard shell, and the
// alternative (a `locale` argument on 40 call sites in a dozen files) buys nothing for
// the single-instance case that is the only one that occurs in practice. Components
// that need the locale inside React should prefer the `useStudioLocale()` hook, which
// reads the real per-instance context value.

let activeStudioLocale: string | undefined;

/**
 * Publishes the locale resolved from `<Studio locale={…} />` so the non-React `Intl`
 * helpers in this package can read it. Called by `StudioProvider`; not part of the
 * public API.
 *
 * @param locale - A BCP-47 language tag, or `undefined` to fall back to the runtime default.
 */
export function setActiveStudioLocale(locale: string | undefined): void {
  activeStudioLocale = locale;
}

/**
 * The BCP-47 tag every `Intl` formatter in this package should resolve against.
 *
 * Returns `undefined` when the host did not pass `<Studio locale={…} />`, which is the
 * exact value these call sites passed before this existed — so the default behaviour
 * (resolve to the runtime/browser locale) is unchanged.
 *
 * @returns The active BCP-47 language tag, or `undefined` for the runtime default.
 */
export function getStudioLocale(): string | undefined {
  return activeStudioLocale;
}

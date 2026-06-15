/**
 * Type-only augmentation shim for the workspace typecheck gate.
 *
 * This example type-checks the consumed `@mui/x-*` packages from source (they
 * are not pre-built). A package applies its ambient module augmentations from
 * files elsewhere in *its own* `src` — e.g. the dayjs `utc`/`timezone` plugins
 * that augment `Dayjs` are imported by a sibling of `AdapterDayjs`, and
 * `@mui/x-data-grid` augments the MUI `Palette` in its theme module. The
 * example's partial import graph never reaches those files, so without this
 * shim `tsc` reports the augmented members as missing.
 *
 * These are side-effect type imports only; nothing imports this module, so it
 * is tree-shaken out of the runtime bundle and affects the typecheck alone.
 */
import 'dayjs/plugin/utc';
import 'dayjs/plugin/timezone';
import '@mui/x-data-grid/themeAugmentation';
// Makes `theme.vars` non-optional (CSS-vars theme), matching the package
// tsconfigs' `types`. Without it `palette` widens to plain `Palette`, which the
// data-grid's own `material/variables.ts` reads `.DataGrid` off of.
import '@mui/material/themeCssVarsAugmentation';

export {};

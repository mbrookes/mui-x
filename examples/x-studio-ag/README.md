# x-studio-ag example

A side-by-side comparison harness: the demo datasets used by the other Studio examples, rendered with `ag-studio-react` instead of `@mui/x-studio`.

## What it demonstrates

Nothing about the MUI X implementation — this app imports no `@mui/x-studio` code. It exists so the same sales and office-supplies data can be looked at in a competing dashboard builder, which makes feature and behavior gaps easy to see. Data comes from [`x-studio-shared`](../x-studio-shared), so both sides really are showing the same rows.

## Does it need the dev server?

**No.** Every row is generated in the browser, and the app reads no environment variables at all.

## Running it

```bash
cd examples/x-studio-ag
pnpm dev                      # http://localhost:3004
```

Every Vite-based x-studio example defaults to port 3004, so run one at a time or pass an override: `pnpm dev --port 3005`.

## URL parameters

| Parameter            | Effect                                                                |
| -------------------- | --------------------------------------------------------------------- |
| `?rows=N`            | Generate N sales rows instead of the default dataset.                 |
| `?dataset=ag-studio` | Load the office-supplies dataset instead of sales.                    |
| `?mode=adapter`      | Route rows through an adapter rather than handing them over directly. |

## A note on the dependency

`ag-studio-react` is declared as `latest`, so the version you get depends on when you installed. The lockfile currently records 2.0.1; a fresh resolution pulls whatever is newest, which has already produced a major-version jump. If this app breaks while the others run, check the installed version first:

```bash
cat node_modules/ag-studio-react/package.json | grep '"version"'
```

## Other scripts

| Script            | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `pnpm build`      | Type-check, then build to `dist/`. `pnpm preview` serves it. |
| `pnpm typescript` | Type-check only.                                             |

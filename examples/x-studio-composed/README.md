# x-studio-composed example

The same dashboard as the [`x-studio`](../x-studio) example, assembled from the individual parts instead of the all-in-one `<Studio>` component.

## What it demonstrates

How to host Studio when you need the surrounding chrome to be yours:

- Create the controller yourself with `createStudioController`, then provide it through `StudioProvider`.
- Lay out `StudioCanvas`, `StudioWidgetEditDialog` and your own toolbar, and subscribe to state through selectors such as `selectPages` and `selectFilters`.
- Opt into `useStudioKeyboardShortcuts`, and drive save/load through `serializeState`, `deserializeState` and `migrateState`.

Reach for this example when the question is "how do I embed Studio in an app that already has a shell?".

## Does it need the dev server?

**No.** Unlike the other two Studio apps, this one ships no `.env`, so `STUDIO_SERVER_URL` is unset and the app runs in memory mode against rows generated in the browser.

To exercise the server path, copy `.env.example` to `.env.local` and start the [dev server](../x-studio-dev-server). The app then routes every widget query — and write-back, for editable Grid widgets — through `/api/sales-data` and `/api/sales-mutations`.

## Running it

```bash
cd examples/x-studio-composed
pnpm dev                      # http://localhost:3004
```

Every Vite-based x-studio example defaults to port 3004, so run one at a time or pass an override: `pnpm dev --port 3005`.

## URL parameters

| Parameter            | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `?mode=`             | `memory`, `adapter` or `server`. Takes precedence over `.env.local`. |
| `?rows=N`            | Generate N sales rows instead of the default dataset.                |
| `?dataset=ag-studio` | Load the office-supplies dataset instead of sales.                   |
| `?page=ID`           | Open a specific dashboard page.                                      |
| `?fv=`               | Page filter values, for a shareable filtered link.                   |

`?mode=adapter` keeps everything in the browser but routes it through `src/simulatedServer.ts`, which is a useful way to watch the query descriptors a real backend would receive.

## Environment

| Variable              | Default  | Purpose                                                |
| --------------------- | -------- | ------------------------------------------------------ |
| `STUDIO_SERVER_URL`   | _(none)_ | Dev server base URL. Its presence selects server mode. |
| `STUDIO_SERVER_TOKEN` | _(none)_ | Bearer token, when the dev server sets `STUDIO_TOKEN`. |

## Other scripts

| Script            | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `pnpm build`      | Type-check, then build to `dist/`. `pnpm preview` serves it. |
| `pnpm typescript` | Type-check only.                                             |

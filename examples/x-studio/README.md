# x-studio example

The main development app for `@mui/x-studio` — a full dashboard host wired to a real backend, and the app most day-to-day Studio work is done against.

## What it demonstrates

- The all-in-one `<Studio>` component with an imperative `StudioHandle` ref (undo/redo, mode switching, state serialization).
- Server-backed data: every widget query is batched and pushed down to SQL through `createBatchingAdapter`.
- The AI assistant, dashboard save/load, cross-source relationships (sales + CRM) and a third data source served by a separate example server.

## Does it need the dev server?

**Yes, by default.** The committed `.env` sets `STUDIO_SERVER_URL=http://localhost:3020`, and the app selects server mode whenever that variable is present. With nothing listening on 3020, every widget renders `Failed to fetch`.

To run it standalone, pick another data mode with a URL parameter:

| URL                                   | Data source                                             |
| ------------------------------------- | ------------------------------------------------------- |
| `http://localhost:3004/?mode=memory`  | Rows generated in the browser. No backend.              |
| `http://localhost:3004/?mode=adapter` | The same rows, routed through `src/simulatedServer.ts`. |
| `http://localhost:3004/?rows=5000`    | Generates 5000 rows, which implies memory mode.         |

The in-app Settings dialog writes the same `?mode` parameter. Removing `STUDIO_SERVER_URL` from `.env` makes memory mode the default instead.

## Running it

```bash
# Terminal 1 — backend (skip for ?mode=memory)
cd examples/x-studio-dev-server
pnpm dev                      # http://localhost:3020

# Terminal 2 — this app
cd examples/x-studio
pnpm dev                      # http://localhost:3004
```

Every Vite-based x-studio example defaults to port 3004, so run one at a time or pass an override: `pnpm dev --port 3005`.

## URL parameters

| Parameter            | Effect                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `?mode=`             | `memory`, `adapter` or `server`. Takes precedence over `.env`.                                                     |
| `?rows=N`            | Generate N sales rows instead of the default dataset.                                                              |
| `?dataset=ag-studio` | Load the office-supplies dataset instead of sales.                                                                 |
| `?server=URL`        | Point at a different backend. Only read when `STUDIO_SERVER_URL` is unset.                                         |
| `?page=ID`           | Open a specific dashboard page.                                                                                    |
| `?bp=N`              | Set the responsive stack breakpoint, in pixels.                                                                    |
| `?fv=`               | Page filter values. In view mode the app writes them back to the URL, so a filtered dashboard is a shareable link. |

## Environment

Copy `.env.example` to `.env.local` to override anything below. Vite exposes the `VITE_` and `STUDIO_` prefixes only.

| Variable                    | Default                 | Purpose                                                |
| --------------------------- | ----------------------- | ------------------------------------------------------ |
| `STUDIO_SERVER_URL`         | `http://localhost:3020` | Dev server base URL. Its presence selects server mode. |
| `STUDIO_SERVER_TOKEN`       | _(none)_                | Bearer token, when the dev server sets `STUDIO_TOKEN`. |
| `VITE_EMPLOYEES_SERVER_URL` | `http://localhost:3002` | The employees data source.                             |

## The two optional backends

- **AI features** (chat, generated insights, dashboard titles) go to `/api/ai` on the dev server, so they need it running **and** `LLM_API_KEY` set in its `.env.local`. Without a key the rest of the app is unaffected.
- **The employees data source** always talks to the [`server-side-data`](../server-side-data) example, whatever data mode is active. Start it on a free port:

  ```bash
  cd examples/server-side-data/server && PORT=3002 pnpm dev
  ```

## Other scripts

| Script             | What it does                                                 |
| ------------------ | ------------------------------------------------------------ |
| `pnpm dev:scan`    | Dev server with `react-scan` enabled.                        |
| `pnpm dev:wdyr`    | Dev server with `why-did-you-render` enabled.                |
| `pnpm dev:profile` | Aliases `react-dom/profiling` so the React Profiler works.   |
| `pnpm analyze`     | Production build plus a treemap of the bundle.               |
| `pnpm build`       | Type-check, then build to `dist/`. `pnpm preview` serves it. |
| `pnpm typescript`  | Type-check only.                                             |

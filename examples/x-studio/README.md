# x-studio example

The main development app for `@mui/x-studio` — a full dashboard host wired to a real backend, and the app most day-to-day Studio work is done against.

## What it demonstrates

- The all-in-one `<Studio>` component with an imperative `StudioHandle` ref (undo/redo, mode switching, state serialization).
- Server-backed data: every widget query is batched and pushed down to SQL through `createBatchingAdapter`.
- The AI assistant, dashboard save/load, cross-source relationships (sales + CRM) and a third data source served by a separate example server.

## Does it need the dev server?

**Yes, by default.** The committed `.env` sets `STUDIO_SERVER_URL=http://localhost:3020`, and the app selects server mode whenever that variable is present. With nothing listening on 3020, every widget renders `Failed to fetch`.

To run it standalone, pick another data mode with a URL parameter:

| URL                                      | Data source                                             |
| ---------------------------------------- | ------------------------------------------------------- |
| `http://localhost:3004/?mode=memory`     | Rows generated in the browser. No backend.              |
| `http://localhost:3004/?mode=adapter`    | The same rows, routed through `src/simulatedServer.ts`. |
| `http://localhost:3004/?rows=5000`       | Generates 5000 rows, which implies memory mode.         |
| `http://localhost:3004/?mode=data-layer` | The MUI data layer. Needs the variables below.          |

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
| `?mode=`             | `memory`, `adapter`, `server` or `data-layer`. Takes precedence over `.env`.                                       |
| `?rows=N`            | Generate N sales rows instead of the default dataset.                                                              |
| `?dataset=ag-studio` | Load the office-supplies dataset instead of sales.                                                                 |
| `?server=URL`        | Point at a different backend. Only read when `STUDIO_SERVER_URL` is unset.                                         |
| `?page=ID`           | Open a specific dashboard page.                                                                                    |
| `?bp=N`              | Set the responsive stack breakpoint, in pixels.                                                                    |
| `?fv=`               | Page filter values. In view mode the app writes them back to the URL, so a filtered dashboard is a shareable link. |

## Environment

Copy `.env.example` to `.env.local` to override anything below. Vite exposes the `VITE_` and `STUDIO_` prefixes only.

| Variable                    | Default                 | Purpose                                                  |
| --------------------------- | ----------------------- | -------------------------------------------------------- |
| `STUDIO_SERVER_URL`         | `http://localhost:3020` | Dev server base URL. Its presence selects server mode.   |
| `STUDIO_SERVER_TOKEN`       | _(none)_                | Bearer token, when the dev server sets `STUDIO_TOKEN`.   |
| `VITE_EMPLOYEES_SERVER_URL` | `http://localhost:3002` | The employees data source.                               |
| `STUDIO_DATA_LAYER_URL`     | _(none)_                | Data layer origin. Its presence selects data layer mode. |
| `DATA_LAYER_API_KEY`        | _(none)_                | A `dl_...` key. Only the Vite proxy reads it.            |

## The MUI data layer

In data layer mode the app reads every entity from `GET /api/v1/schema` and makes each one a data source.
The data drawer lists the entities. A starter page shows one grid per entity.
Each widget query goes to `POST /api/v1/query`; queries made in the same tick share one batch.
The other modes stay available through Settings or `?mode=`.

The data layer sends no CORS headers, so the browser calls `/data-layer` on the Vite server.
Vite proxies `/data-layer/api/v1/*` to `STUDIO_DATA_LAYER_URL` and adds `Authorization: Bearer $DATA_LAYER_API_KEY`.
The key never reaches the client bundle. The proxy works for `pnpm dev` and `pnpm preview`.

To use the deployed preview:

1. Sign in at https://data-layer-mvp-preview.onrender.com and open the Connect page.
2. Create an API key and copy it. The key has the same access as your user.
3. Add both variables to `.env.local`:

   ```bash
   STUDIO_DATA_LAYER_URL=https://data-layer-mvp-preview.onrender.com
   DATA_LAYER_API_KEY=dl_...
   ```

4. Run `pnpm dev` and open http://localhost:3004.

How Studio maps to the data layer (`src/connectors/dataLayer/`):

| Studio                                   | Data layer                                                     |
| ---------------------------------------- | -------------------------------------------------------------- |
| `StudioDataSource` (`dl-<entity>`)       | One entity from `/api/v1/schema`                               |
| Field type `number`                      | `integer` or `number`. `json` becomes a JSON string.           |
| `descriptor.select`                      | `select`, without expression fields                            |
| `descriptor.filter` (`StudioFilterNode`) | `where`. The server checks `filterable` and `requiredFilters`. |
| `descriptor.limit`                       | Row cap. The adapter pages with `limit` and `offset`.          |
| `aggregations`, `groupBy`, sorting       | Not sent. Studio aggregates and sorts the returned rows.       |

The adapter reads at most 5000 rows per widget. When `hasMore` is still true, or a result is `partial`, a warning names the entity.
Errors show as `CODE: message` in the widget, or above the canvas when the schema fails to load.
`ends_with`, `not_ends_with`, and filters on another source fail with `OPERATOR_NOT_SUPPORTED`.

Tests:

```bash
pnpm vitest run --config vitest.config.mts   # client, filters, adapter
# With the app and a data layer running, from the repository root:
DATA_LAYER_E2E=1 PLAYWRIGHT_TEST_BASE_URL=http://localhost:3004 pnpm test:e2e-studio dataLayer
```

The end-to-end test expects two Petstore entities readable by the key's owner:
`pets` on `GET /pet/findByStatus`, and `pet` on `GET /pet/{petId}` with `petId` bound to an `id` filter.

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

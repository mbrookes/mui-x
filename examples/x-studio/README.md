# x-studio example

A dashboard with a single heatmap widget plotting, for every (UI component
library, data grid library) pair, how many non-fork GitHub repositories
declare both as dependencies — e.g. how many repos combine `@mui/material`
with `@mui/x-data-grid` vs. with `ag-grid-react`. See
`src/connectors/githubLibraryUsageSource.ts` for the full list of libraries
compared and how the GitHub code-search query is built.

## Architecture

- **Client** (`src/`) — a Vite/React app built on `@mui/x-studio`. It has no
  embedded credentials: `src/connectors/githubLibraryUsageSource.ts` reads
  the adoption matrix from `GET /api/github-library-usage` on this app's own
  API server, resolved relative to the current origin.
- **Server** (`src/server/`) — a small Express app that:
  - proxies GitHub's code-search API using a server-side
    `GITHUB_SEARCH_TOKEN`, so the token never ships to the browser (GitHub
    code search requires authentication — baking a personal access token
    into the client bundle via a `VITE_`-prefixed env var would expose it to
    anyone who loads the page);
  - caches the computed matrix in memory for 24h, since building it costs one
    rate-limited GitHub search per (component library × data grid library)
    cell — see `COMPONENT_LIBRARIES`/`DATA_GRID_LIBRARIES` in
    `src/server/githubLibraryUsage.ts` for the current lists;
  - serves the built static client (`dist/`) when present, so a single
    process/service can host both — see [Deploying to Railway](#deploying-to-railway).

## Running locally

```bash
# Client (Vite dev server, port 3004)
pnpm --filter x-studio-example dev

# API server (port 3006) — required for the heatmap to show real data
cp .env.example .env.local   # then set GITHUB_SEARCH_TOKEN
pnpm --filter x-studio-example server
```

`vite.config.ts` proxies `/api` requests from the dev server to
`http://localhost:3006`, so the client's relative `fetch('/api/...')` calls
work in dev without any client-side base-URL configuration. Without
`GITHUB_SEARCH_TOKEN` set (or without the server running at all), the heatmap
renders its "No data to display" empty state rather than erroring — see
`src/connectors/githubLibraryUsageSource.ts`.

## Deploying to Railway

`railway.toml` (repo root) builds the client and runs the server as one
Railway service, which then serves both the static site and the API from the
same origin. Configure on the Railway service:

- `GITHUB_SEARCH_TOKEN` — required for real heatmap data.
- `ALLOWED_ORIGINS` — optional; only needed for origins _other than_ the
  service's own (same-origin requests, including the co-hosted production
  client, are always allowed regardless of this list — see
  `src/server/index.ts`).

Lessons carried over from deploying `examples/x-studio-survey` to Railway:

- **Builder**: `railway.toml` pins `builder = "railpack"`. The deprecated
  Nixpacks builder provisions Node from nix (an older patch version whose
  corepack cannot launch pnpm v11's pure-ESM CLI), which crashes with
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` no matter what else is
  configured. Railpack resolves the exact Node version via mise from
  `.node-version`/`engines`, which the repo already pins to 22.22.3.
- **One service, not two**: this fork's org policy disables GitHub Pages, so
  there's no separate static host for the built client. The API server
  serves `dist/` (with an `index.html` SPA fallback for non-`/api/*` GET
  requests) when present, registered _after_ every `/api/*` route so static
  serving never shadows the API.
- **CORS must be scoped to `/api`, not mounted globally**: the built client's
  module `<script>` tag is `crossorigin`, so the browser sends an `Origin`
  header even for that same-origin asset request. A CORS check that rejects
  it throws inside the callback, which Express turns into a bare 500 for the
  script load — invisible from `curl` (which doesn't send `Origin`), so this
  needs an actual browser to catch.
- **Don't hardcode the deployed domain in `ALLOWED_ORIGINS`**: instead, the
  server always allows the request's own origin (computed from
  `req.protocol`/`req.get('host')`, which requires `app.set('trust proxy', true)`
  since Railway terminates TLS at an edge proxy). That keeps the co-hosted
  client working across redeploys to a different Railway domain without
  needing `ALLOWED_ORIGINS` updated every time.
- **Generic env var names collide with ambient ones**: an earlier draft of
  this server read `GITHUB_TOKEN` — a name enough tools set as an ambient
  environment variable (GitHub Actions injects one automatically, as do some
  sandboxes) that a deploy could silently authenticate with the wrong,
  wrongly-scoped credential instead of failing loudly. Renamed to the
  unambiguous `GITHUB_SEARCH_TOKEN`.

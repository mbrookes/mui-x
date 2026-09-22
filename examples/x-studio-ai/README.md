# x-studio-ai example

A chat-first host for `@mui/x-studio`: the dashboard is built by talking to the AI assistant rather than by dragging widgets onto a canvas.

## What it demonstrates

- Several chat threads side by side, each owning its own `StudioController` and dashboard, persisted to `localStorage`.
- Chat titles and descriptions generated from the first message.
- A custom geography (UK regions) registered for Map widgets, and a localized UI with a language switcher.

## Does it need the dev server?

**For chat, always.** The app never talks to an LLM directly: it posts to `/api/ai/chat` on the dev server, which holds the API key and runs the agentic loop. With no `STUDIO_SERVER_URL` set, the AI config is `undefined` and the assistant is unavailable — which leaves very little of this example to look at.

**For data, only by default.** The committed `.env` sets `STUDIO_SERVER_URL=http://localhost:3020`, so rows come from SQL through a batching adapter. Remove that entry and the app falls back to `src/dataAdapter.ts`, an in-memory adapter over rows generated in the browser.

The dev server also needs `LLM_API_KEY` in its own `.env.local`, or chat requests fail.

## Running it

```bash
# Terminal 1 — backend, with an LLM key configured
cd examples/x-studio-dev-server
cp .env.example .env.local     # then set LLM_API_KEY
pnpm dev                       # http://localhost:3020

# Terminal 2 — this app
cd examples/x-studio-ai
pnpm dev                       # http://localhost:3004
```

Every Vite-based x-studio example defaults to port 3004, so run one at a time or pass an override: `pnpm dev --port 3005`.

## Environment

Copy `.env.example` to `.env.local` to override. Vite exposes the `VITE_` and `STUDIO_` prefixes only.

| Variable              | Default                 | Purpose                                                    |
| --------------------- | ----------------------- | ---------------------------------------------------------- |
| `STUDIO_SERVER_URL`   | `http://localhost:3020` | Dev server base URL. Required for chat, optional for data. |
| `STUDIO_SERVER_TOKEN` | _(none)_                | Bearer token, when the dev server sets `STUDIO_TOKEN`.     |

The Settings dialog shows the resolved server URL, which is the quickest way to confirm what the app picked up.

## Other scripts

| Script            | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `pnpm build`      | Type-check, then build to `dist/`. `pnpm preview` serves it. |
| `pnpm typescript` | Type-check only.                                             |

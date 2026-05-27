# x-studio AI proxy

A minimal server-side proxy that keeps your LLM API key out of the browser.

The proxy accepts requests from the x-studio example apps, adds the API key server-side, and forwards them to OpenAI (or any OpenAI-compatible endpoint). It streams the SSE response back so the x-studio AI chat adapter receives it in the same format as a direct API call.

## Quick start

### 1. Install dependencies

```bash
cd examples/x-studio-ai-proxy
npm install        # or pnpm install / yarn
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at least `LLM_API_KEY`.

### 3. Start the proxy

```bash
npm run dev        # starts on http://localhost:3010 with hot-reload
```

### 4. Configure the x-studio example app

In `examples/x-studio` (or `examples/x-studio-composed`), edit `.env.local`:

```env
# Point the app at your local proxy (no API key in the browser!)
LLM_ENDPOINT=http://localhost:3010/v1/chat/completions

# Optional: shared secret (must match STUDIO_TOKEN in the proxy .env)
# LLM_TOKEN=change-me-to-a-random-secret
```

Then start the example app normally:

```bash
cd examples/x-studio
npm run dev
```

## Environment variables

| Variable          | Required | Default                                      | Description                                                |
| ----------------- | -------- | -------------------------------------------- | ---------------------------------------------------------- |
| `LLM_API_KEY`     | ✅       | —                                            | Your API key (stays on the server)                         |
| `PORT`            |          | `3010`                                       | Port the proxy listens on                                  |
| `LLM_ENDPOINT`    |          | `https://api.openai.com/v1/chat/completions` | Upstream LLM endpoint (change for Azure, Ollama, etc.)     |
| `STUDIO_TOKEN`    |          | _(none)_                                     | If set, clients must send `X-Studio-Token: <value>` header |
| `ALLOWED_ORIGINS` |          | `*`                                          | Comma-separated list of allowed CORS origins               |

## Using a custom LLM endpoint (Azure, Ollama, etc.)

Set `LLM_ENDPOINT` to any OpenAI-compatible endpoint:

```env
# Azure OpenAI
LLM_ENDPOINT=https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT/chat/completions?api-version=2024-02-01

# Ollama (local)
LLM_ENDPOINT=http://localhost:11434/v1/chat/completions
LLM_API_KEY=ollama   # Ollama requires a non-empty but otherwise arbitrary key
```

## Token authentication

For an extra layer of security, set a shared secret in the proxy:

```env
# proxy .env
STUDIO_TOKEN=change-me-to-a-random-secret
```

Then configure the example app to send it:

```env
# example app .env.local
LLM_TOKEN=change-me-to-a-random-secret
```

The app passes it as an `X-Studio-Token` request header; the proxy rejects requests that omit or mismatched the token with a `401 Unauthorized` response.

## Production notes

This proxy is intentionally minimal — it is a starting point, not a production-ready service. Before deploying:

- **Restrict CORS:** Set `ALLOWED_ORIGINS` to your production domain.
- **Secure the token:** Use a long random secret for `STUDIO_TOKEN`, stored in your secrets manager.
- **Add rate limiting:** Protect against abuse with a library like [`express-rate-limit`](https://www.npmjs.com/package/express-rate-limit).
- **Use HTTPS:** Terminate TLS at your load balancer or reverse proxy.
- **Integrate your auth system:** Replace the `X-Studio-Token` check with your existing user authentication (JWT validation, session cookies, etc.).

## API

### `GET /health`

Returns `{ status: "ok", timestamp: "..." }`. Useful for load-balancer health checks.

### `POST /v1/chat/completions`

Accepts the same request body as the [OpenAI chat completions API](https://platform.openai.com/docs/api-reference/chat) and forwards it upstream with the API key added. Streams the response back as SSE.

Optional request header: `X-Studio-Token: <token>` (required when `STUDIO_TOKEN` is set).

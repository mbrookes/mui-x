/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Direct LLM connection — set in .env.local when NOT using the dev server
  readonly LLM_ENDPOINT?: string;
  readonly LLM_TOKEN?: string;
  readonly LLM_API_KEY?: string;
  readonly LLM_MODEL?: string;
  // Dev server connection — routes both AI and data through x-studio-dev-server
  readonly VITE_STUDIO_SERVER_URL?: string;
  readonly VITE_STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

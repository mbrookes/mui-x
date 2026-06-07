/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Direct LLM connection
  readonly LLM_ENDPOINT?: string;
  readonly LLM_API_KEY?: string;
  readonly LLM_MODEL?: string;
  readonly LLM_TOKEN?: string;
  // Dev server connection
  readonly VITE_STUDIO_SERVER_URL?: string;
  readonly VITE_STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

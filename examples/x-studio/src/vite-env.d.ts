/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to 'true' by `pnpm dev:wdyr` — activates why-did-you-render */
  readonly VITE_WDYR?: string;
  // LLM AI config — set in .env.local for local AI integration
  readonly LLM_ENDPOINT?: string;
  readonly LLM_TOKEN?: string;
  readonly LLM_API_KEY?: string;
  readonly LLM_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

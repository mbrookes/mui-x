/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Dev server connection — routes AI queries through x-studio-ai-middleware
  readonly STUDIO_SERVER_URL?: string;
  readonly STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

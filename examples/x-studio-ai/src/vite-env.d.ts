/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Dev server connection
  readonly STUDIO_SERVER_URL?: string;
  readonly STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

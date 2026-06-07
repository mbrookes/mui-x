/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Dev server connection
  readonly VITE_STUDIO_SERVER_URL?: string;
  readonly VITE_STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

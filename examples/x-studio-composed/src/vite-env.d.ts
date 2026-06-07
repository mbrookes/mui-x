/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Dev server connection — routes both AI and data through x-studio-dev-server
  readonly VITE_STUDIO_SERVER_URL?: string;
  readonly VITE_STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

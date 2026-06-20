/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to 'true' by `pnpm dev:wdyr` — activates why-did-you-render */
  readonly VITE_WDYR?: string;
  /** Set to 'true' by `pnpm dev:scan` — activates react-scan */
  readonly VITE_REACT_SCAN?: string;
  // Dev server connection — routes both AI and data through x-studio-dev-server
  readonly STUDIO_SERVER_URL?: string;
  readonly STUDIO_SERVER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

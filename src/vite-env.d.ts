/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PARASCENE_BASE_URL?: string;
  readonly VITE_PARASCENE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Admin HTTP API base URL (the `AdminApiUrl` stack output). Required. */
  readonly VITE_ADMIN_API_BASE?: string;
  /** Cognito app client id — defaults to the dev test client when unset. */
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

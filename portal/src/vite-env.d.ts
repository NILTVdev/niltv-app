/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Portal API base URL (the PortalApiUrl stack output). Required. */
  readonly VITE_PORTAL_API?: string;
  /** The niltv.com Cognito user pool id. Required. */
  readonly VITE_COGNITO_POOL_ID?: string;
  /** A Cognito app client id the portal API accepts. Required. */
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /** dev or prod. */
  readonly VITE_STAGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

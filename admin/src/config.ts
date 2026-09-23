/**
 * Runtime config. `apiBase` is required — App renders a setup screen when it is
 * absent instead of firing requests at `undefined`.
 */

const rawBase = import.meta.env.VITE_ADMIN_API_BASE;

export const config = {
  /** Admin API origin, no trailing slash. `undefined` → show the setup screen. */
  apiBase: rawBase ? rawBase.replace(/\/+$/, "") : undefined,
  cognito: {
    region: "us-east-1",
    userPoolId: "us-east-1_3NKbi2MYH",
    /** Dev test client — a public identifier, not a secret. */
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID || "4g3a4ho0hfv2lh68toj1bnrdve",
  },
} as const;

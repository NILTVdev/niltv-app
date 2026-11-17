/**
 * Runtime config from the Vite env. The API URL and both Cognito ids are
 * required: App renders a setup screen when any is missing instead of
 * firing requests at `undefined`.
 */

const clean = (value: string | undefined): string | undefined => {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : undefined;
};

export const config = {
  /** Portal API origin, no trailing slash. */
  apiBase: clean(import.meta.env.VITE_PORTAL_API)?.replace(/\/+$/, ""),
  cognito: {
    userPoolId: clean(import.meta.env.VITE_COGNITO_POOL_ID),
    clientId: clean(import.meta.env.VITE_COGNITO_CLIENT_ID),
  },
  stage: clean(import.meta.env.VITE_STAGE) ?? "dev",
} as const;

/** Names of the env values that are missing, for the setup screen. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.apiBase) missing.push("VITE_PORTAL_API");
  if (!config.cognito.userPoolId) missing.push("VITE_COGNITO_POOL_ID");
  if (!config.cognito.clientId) missing.push("VITE_COGNITO_CLIENT_ID");
  return missing;
}

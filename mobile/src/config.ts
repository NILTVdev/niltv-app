/**
 * Runtime configuration. Defaults point at the live dev stack (public
 * identifiers — safe to commit per docs/CONVENTIONS.md); each value can be
 * overridden at build time via the matching EXPO_PUBLIC_* env var.
 */
export const config = {
  /** API origin (CloudFront in front of the HTTP API). No trailing slash. */
  apiBase: process.env.EXPO_PUBLIC_API_BASE ?? "https://d1nm1d2txb83wa.cloudfront.net",
  // V2 pool ids (SSO migration). The launch pools are retired.
  userPoolId: process.env.EXPO_PUBLIC_USER_POOL_ID ?? "us-east-1_fxm8vObBQ",
  userPoolClientId: process.env.EXPO_PUBLIC_USER_POOL_CLIENT_ID ?? "68pp1ldrho0houc8qpm9kgua6p",
  awsRegion: process.env.EXPO_PUBLIC_AWS_REGION ?? "us-east-1",
  /** NIL STAR Official Rules (spec §7 compliance link). */
  rulesUrl: process.env.EXPO_PUBLIC_RULES_URL ?? "https://www.niltv.com/nil-star-rules",
  /**
   * Community guidelines / terms page for comments (App Store 1.2). No default:
   * set EXPO_PUBLIC_GUIDELINES_URL (https) once the page exists. Unset, the app
   * shows only its built-in summary and no link.
   */
  guidelinesUrl: process.env.EXPO_PUBLIC_GUIDELINES_URL,
  /**
   * A monitored address for comment concerns (App Store 1.2: published contact
   * information). No default: set EXPO_PUBLIC_SUPPORT_EMAIL. Unset, no contact
   * link is shown.
   */
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL,
} as const;

export type Config = typeof config;

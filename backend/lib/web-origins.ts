/**
 * Browser origins allowed to call the public API cross-origin. Replaces the
 * former wildcard: the mobile app is native (no Origin header, CORS never
 * applies), so only the web surfaces need to be listed.
 * Auth is a Bearer header (never cookies), so credentials stay off and a
 * listed origin can only read what it could read anyway - this narrows the
 * blast radius of a rogue page reading the API, nothing more.
 */
export const webOrigins = (stage: string): string[] =>
  stage === "prod"
    ? ["https://niltv.com", "https://www.niltv.com", "https://prod.dkdfgvugisb3v.amplifyapp.com"]
    : [
        "https://dev.dkdfgvugisb3v.amplifyapp.com",
        // local dev: Expo web + Vite admin
        "http://localhost:8081",
        "http://localhost:19006",
        "http://localhost:5173",
        "http://localhost:3000",
      ];

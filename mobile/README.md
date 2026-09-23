# NILTV mobile

Expo (SDK 57) + expo-router client for NILTV. iOS and Android are the targets;
web is a dev convenience only (see the root `CLAUDE.md` gotchas).

## Run it

```sh
# from the repo root (npm workspaces: install at root only)
npm install
npm start            # same as: cd mobile && npx expo start
```

Press `w` for web, `i` for the iOS simulator (macOS) or `a` for Android. The app
uses a development build (`expo-dev-client`) for native behaviour; make one with
`eas build --profile development`.

## Checks

```sh
npm run typecheck --workspace mobile
npm run test --workspace mobile     # vitest over the pure logic in src/
cd mobile && npx expo lint
```

## Config

- `src/config.ts`: API base, Cognito pool and client ids, region and rules URL.
  Defaults point at the dev stack; each value can be overridden at build time with
  the matching `EXPO_PUBLIC_*` env var.
- `eas.json`: build profiles `development` (dev client), `preview` (internal APK)
  and `production` (store builds, auto-incrementing build number). The preview and
  production profiles set their own `EXPO_PUBLIC_*` values.
- `app.json`: app name, bundle ids, icons, splash, EAS project and update settings.
  The update runtime follows the app `version`, so bump it with any change that needs
  a new native build.

## Layout

- `app/`: expo-router routes (thin screens). Tabs in `(tabs)/`; detail routes in
  `athlete/`, `channel/`, `event/` and `video/`.
- `src/api/`: API client and TanStack Query hooks. Responses are validated with the
  `@niltv/types` schemas; never redeclare a shape here.
- `src/auth/`: Cognito sign-in and token storage.
- `src/components/`: shared UI.
- `src/lib/`: pure logic that screens delegate to, unit tested.
- `src/theme/tokens.ts`: design tokens per `docs/CONVENTIONS.md` (do not tweak per screen).
- `scripts/sync-featured-rails.mjs`: copies the site's curated Featured shelves into
  `src/lib/featuredRails.generated.json`. Run it before an OTA update.

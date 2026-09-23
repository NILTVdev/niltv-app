import { router, type Href } from "expo-router";

/**
 * Back navigation that survives web deep-loads. On web, a directly loaded URL
 * (shared link, refresh, new tab) is the first history entry, so router.back()
 * has nowhere to go and warns "The action 'GO_BACK' was not handled by any
 * navigator". Fall back to replacing with a sensible screen instead.
 */
export function goBack(fallback: Href = "/"): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace(fallback);
  }
}

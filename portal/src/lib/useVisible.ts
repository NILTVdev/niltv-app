/** True while the tab is visible; polling and read markers pause when it is not. */
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const snapshot = (): boolean => !document.hidden;

export const useVisible = (): boolean => useSyncExternalStore(subscribe, snapshot, () => true);

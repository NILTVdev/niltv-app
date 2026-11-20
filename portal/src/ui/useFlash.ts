/** Deep links: once the target card renders, scroll to it and outline it briefly. */
import { useEffect, useRef } from "react";

export function useFlash(elementId: string | undefined, ready: boolean): void {
  const done = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!elementId || !ready || done.current === elementId) return;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(elementId);
      if (!el) return;
      done.current = elementId;
      el.scrollIntoView({ block: "center" });
      el.classList.add("flash");
      window.setTimeout(() => el.classList.remove("flash"), 1800);
    }, 50);
    return () => window.clearTimeout(timer);
  }, [elementId, ready]);
}

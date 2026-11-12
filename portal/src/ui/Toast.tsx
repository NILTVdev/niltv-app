/**
 * Short confirmations in a polite live region, so screen readers hear them
 * without losing their place. Errors that belong to a form show inline
 * instead; a toast is for "Saved." and friends.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

interface ToastItem {
  id: number;
  text: string;
  tone: "info" | "bad";
}

type Notify = (text: string, tone?: "info" | "bad") => void;

const ToastContext = createContext<Notify>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const notify = useCallback<Notify>((text, tone = "info") => {
    const id = next.current++;
    setItems((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 3200);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.tone === "bad" ? " bad" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = (): Notify => useContext(ToastContext);

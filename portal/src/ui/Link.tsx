/** A real link that the router handles in place (new-tab and modifier clicks still work). */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { navigate } from "../lib/router";

export function Link({
  to,
  children,
  onNavigate,
  ...rest
}: { to: string; children: ReactNode; onNavigate?: () => void } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
    onNavigate?.();
  };
  return (
    <a {...rest} href={to} onClick={onClick}>
      {children}
    </a>
  );
}

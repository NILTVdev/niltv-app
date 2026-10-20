/**
 * A tiny history-API router: one path per screen, plus an id for the deep
 * links (/messages/{convId}, /schedule/{eventId}, /postings/{id}).
 * The host must serve index.html for every path (SPA fallback).
 */
import { useSyncExternalStore } from "react";
import type { Screen } from "./nav";

export const PATHS: Record<Screen, string> = {
  home: "/",
  hub: "/content-hub",
  messages: "/messages",
  schedule: "/schedule",
  postings: "/postings",
  posts: "/my-posts",
  page: "/my-page",
  payments: "/payments",
  account: "/account",
  refer: "/refer",
  help: "/help",
  athletes: "/athletes",
  guests: "/guests",
  requests: "/requests",
  payouts: "/payouts",
  access: "/team",
};

/** Screens that take an id segment. */
const WITH_ID = new Set<Screen>(["messages", "schedule", "postings"]);

export interface Route {
  /** null = unknown path; the app sends it to the role's start screen */
  screen: Screen | null;
  id?: string;
}

const BY_PATH = new Map<string, Screen>(Object.entries(PATHS).map(([screen, path]) => [path, screen as Screen]));

export function parsePath(pathname: string): Route {
  const clean = "/" + pathname.split(/[?#]/)[0]!.split("/").filter(Boolean).join("/");
  const direct = BY_PATH.get(clean);
  if (direct) return { screen: direct };
  const parts = clean.split("/").filter(Boolean);
  if (parts.length === 2) {
    const screen = BY_PATH.get(`/${parts[0]}`);
    if (screen && WITH_ID.has(screen)) {
      let id = parts[1]!;
      try {
        id = decodeURIComponent(id);
      } catch {
        /* keep the raw segment */
      }
      return { screen, id };
    }
  }
  return { screen: null };
}

export function pathFor(screen: Screen, id?: string): string {
  const base = PATHS[screen];
  return id && WITH_ID.has(screen) ? `${base}/${encodeURIComponent(id)}` : base;
}

const NAV_EVENT = "portal:navigate";

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (path === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export const go = (screen: Screen, id?: string, opts?: { replace?: boolean }): void => navigate(pathFor(screen, id), opts);

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const snapshot = (): string => window.location.pathname;

/** The current path, re-rendering on push, replace and back/forward. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

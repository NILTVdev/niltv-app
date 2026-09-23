import { router } from "expo-router";
import { create } from "zustand";

import { queryKeys } from "@/api/keys";
import { queryClient } from "@/api/queryClient";
import { restoreSession, setOnSessionLost, signOut } from "@/auth/cognito";

export type AuthStatus = "restoring" | "guest" | "signedIn";
export type AuthSheetMode = "signIn" | "signUp";

interface AuthState {
  status: AuthStatus;
  email: string | null;
  name: string | null;
  /** stashed gated action (design §3.3) — runs after a successful auth */
  pendingAction: (() => void) | null;
  /** which form the sheet opens on (confirm-code is internal to the sheet) */
  sheetMode: AuthSheetMode;
  /**
   * Signup interest step (design §6.2): opened by the auth sheet after a
   * FIRST sign-up (never plain sign-in); the interest sheet runs the stashed
   * gated action when it finishes, taking over that duty from the auth sheet.
   */
  interestOpen: boolean;
  openAuth: (mode?: AuthSheetMode) => void;
  closeAuth: () => void;
  setSignedIn: (email: string, name: string) => void;
  signOutAction: () => Promise<void>;
  runPendingAction: () => void;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: "restoring",
  email: null,
  name: null,
  pendingAction: null,
  sheetMode: "signUp",
  interestOpen: false,

  openAuth: (mode = "signUp") => {
    set({ sheetMode: mode });
    router.push("/auth");
  },

  /** left /auth without signing in — drop any stashed action */
  closeAuth: () => set({ pendingAction: null }),

  setSignedIn: (email, name) => set({ status: "signedIn", email, name }),

  signOutAction: async () => {
    await signOut();
    // gcTime 0 handles unobserved copies; this drops any observed one now.
    queryClient.removeQueries({ queryKey: queryKeys.me });
    set({ status: "guest", email: null, name: null, pendingAction: null });
  },

  runPendingAction: () => {
    const action = get().pendingAction;
    set({ pendingAction: null });
    action?.();
  },
}));

/**
 * Gated-action helper (design §3.3): signed in → run now; otherwise stash the
 * action and open the auth sheet — after a successful auth the sheet calls
 * runPendingAction() to resume it.
 */
export function requireAuth(action: () => void): void {
  const { status } = useAuthStore.getState();
  if (status === "signedIn") {
    action();
    return;
  }
  useAuthStore.setState({ pendingAction: action, sheetMode: "signUp" });
  router.push("/auth");
}

let booted = false;

/** Boot-time session restore — called once from the root layout. */
export async function bootstrapAuth(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    const session = await restoreSession();
    if (session) {
      useAuthStore.setState({ status: "signedIn", email: session.email, name: session.name });
    } else {
      useAuthStore.setState({ status: "guest" });
    }
  } catch {
    useAuthStore.setState({ status: "guest" });
  }
}

// Refresh token revoked/expired mid-session → fall back to guest cleanly.
setOnSessionLost(() => {
  queryClient.removeQueries({ queryKey: queryKeys.me });
  useAuthStore.setState({ status: "guest", email: null, name: null });
});

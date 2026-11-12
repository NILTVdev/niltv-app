import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * auth.ts against a stand-in for amazon-cognito-identity-js. Each refresh
 * waits until the test answers it, like a slow or hung Cognito call. The
 * stand-in writes and clears tokens in the storage it was given, as the real
 * library does.
 */
const cognito = vi.hoisted(() => {
  type Answer = { ok: true; idToken: string } | { ok: false; code: string };
  type Call = { user: string; refreshToken: string; answer: (a: Answer) => void };
  const calls: Call[] = [];
  const prefix = "CognitoIdentityServiceProvider.client";

  class CognitoUser {
    username: string;
    storage: Storage;
    constructor(data: { Username: string; Storage: Storage }) {
      this.username = data.Username;
      this.storage = data.Storage;
    }
    getUsername() {
      return this.username;
    }
    signOut() {}
    refreshSession(token: { getToken(): string }, cb: (err: unknown, session: unknown) => void) {
      const refreshToken = token.getToken();
      calls.push({
        user: this.username,
        refreshToken,
        answer: (a) => {
          const key = (name: string) => `${prefix}.${this.username}.${name}`;
          if (!a.ok) {
            if (a.code === "NotAuthorizedException") {
              for (const name of ["idToken", "accessToken", "refreshToken", "clockDrift"]) this.storage.removeItem(key(name));
              this.storage.removeItem(`${prefix}.LastAuthUser`);
            }
            cb({ code: a.code }, null);
            return;
          }
          this.storage.setItem(key("idToken"), a.idToken);
          this.storage.setItem(key("accessToken"), "access");
          this.storage.setItem(key("refreshToken"), refreshToken);
          this.storage.setItem(key("clockDrift"), "0");
          this.storage.setItem(`${prefix}.LastAuthUser`, this.username);
          cb(null, { getIdToken: () => ({ getJwtToken: () => a.idToken }) });
        },
      });
    }
  }

  class CognitoUserPool {
    storage: Storage;
    constructor(data: { Storage: Storage }) {
      this.storage = data.Storage;
    }
    getClientId() {
      return "client";
    }
    getCurrentUser() {
      const name = this.storage.getItem(`${prefix}.LastAuthUser`);
      return name ? new CognitoUser({ Username: name, Storage: this.storage }) : null;
    }
  }

  class CognitoIdToken {
    token: string;
    constructor(data: { IdToken: string }) {
      this.token = data.IdToken;
    }
    decodePayload() {
      return JSON.parse(this.token) as Record<string, unknown>;
    }
  }

  class CognitoRefreshToken {
    token: string;
    constructor(data: { RefreshToken: string }) {
      this.token = data.RefreshToken;
    }
    getToken() {
      return this.token;
    }
  }

  class Dummy {}

  return {
    calls,
    prefix,
    module: {
      CognitoUser,
      CognitoUserPool,
      CognitoIdToken,
      CognitoRefreshToken,
      AuthenticationDetails: Dummy,
      CognitoUserAttribute: Dummy,
    },
  };
});

vi.mock("amazon-cognito-identity-js", () => cognito.module);
vi.mock("./config", () => ({ config: { apiBase: "https://api", cognito: { userPoolId: "pool", clientId: "client" }, stage: "dev" } }));
vi.mock("./lib/push", () => ({ runningStandalone: () => false }));

const now = 1_800_000_000_000;
const min = 60_000;

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

const idToken = (email: string, expiresIn: number, n = 0): string =>
  JSON.stringify({ email, exp: Math.floor((now + expiresIn) / 1000), n });

let tab: Storage;
let auth: typeof import("./auth");

/** Store a session, as a sign-in does. */
function storeSession(user: string, refreshToken: string, id: string): void {
  tab.setItem(`${cognito.prefix}.${user}.idToken`, id);
  tab.setItem(`${cognito.prefix}.${user}.refreshToken`, refreshToken);
  tab.setItem(`${cognito.prefix}.${user}.clockDrift`, "0");
  tab.setItem(`${cognito.prefix}.LastAuthUser`, user);
}

const stored = (user: string, name: string) => tab.getItem(`${cognito.prefix}.${user}.${name}`);
const lastUser = () => tab.getItem(`${cognito.prefix}.LastAuthUser`);

/** The reason a promise rejected, without leaving it unhandled. */
const settledError = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (err: unknown) => err);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  cognito.calls.length = 0;
  tab = memory();
  (globalThis as { window?: unknown }).window = { sessionStorage: tab, localStorage: memory() };
  vi.resetModules();
  auth = await import("./auth");
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe("getIdToken refresh", () => {
  it("stores the new tokens and shares one refresh between callers", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const a = auth.getIdToken();
    const b = auth.getIdToken();
    expect(cognito.calls).toHaveLength(1);
    const fresh = idToken("ana@x.com", 60 * min, 1);
    cognito.calls[0]!.answer({ ok: true, idToken: fresh });
    await expect(a).resolves.toBe(fresh);
    await expect(b).resolves.toBe(fresh);
    expect(stored("ana", "idToken")).toBe(fresh);
    expect(stored("ana", "refreshToken")).toBe("r1");
  });

  it("signs out when Cognito refuses the refresh token", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const p = auth.getIdToken();
    cognito.calls[0]!.answer({ ok: false, code: "NotAuthorizedException" });
    expect(await settledError(p)).toBeInstanceOf(auth.NotSignedInError);
    expect(lastUser()).toBeNull();
    expect(stored("ana", "refreshToken")).toBeNull();
  });
});

describe("a refresh that outlives a sign-out", () => {
  it("keeps the new sign-in of the same user when the old refresh succeeds", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const old = auth.getIdToken();
    auth.signOut();
    const newId = idToken("ana@x.com", 60 * min, 2);
    storeSession("ana", "r2", newId);
    cognito.calls[0]!.answer({ ok: true, idToken: idToken("ana@x.com", 60 * min, 1) });
    const err = await settledError(old);
    expect(err).toBeInstanceOf(auth.StaleRefreshError);
    expect(err).not.toBeInstanceOf(auth.NotSignedInError);
    expect(lastUser()).toBe("ana");
    expect(stored("ana", "refreshToken")).toBe("r2");
    expect(stored("ana", "idToken")).toBe(newId);
    await expect(auth.getIdToken()).resolves.toBe(newId);
  });

  it("keeps the new sign-in when the old refresh is refused", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const old = auth.getIdToken();
    auth.signOut();
    storeSession("ana", "r2", idToken("ana@x.com", 60 * min, 2));
    cognito.calls[0]!.answer({ ok: false, code: "NotAuthorizedException" });
    expect(await settledError(old)).toBeInstanceOf(auth.StaleRefreshError);
    expect(lastUser()).toBe("ana");
    expect(stored("ana", "refreshToken")).toBe("r2");
  });

  it("keeps a different user who signed in since", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const old = auth.getIdToken();
    auth.signOut();
    storeSession("ben", "b1", idToken("ben@x.com", 60 * min));
    cognito.calls[0]!.answer({ ok: true, idToken: idToken("ana@x.com", 60 * min, 1) });
    expect(await settledError(old)).toBeInstanceOf(auth.StaleRefreshError);
    expect(lastUser()).toBe("ben");
    expect(stored("ben", "refreshToken")).toBe("b1");
    expect(stored("ana", "idToken")).toBeNull();
  });

  it("clears the old session if it is somehow stored again", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const old = auth.getIdToken();
    auth.signOut();
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    cognito.calls[0]!.answer({ ok: true, idToken: idToken("ana@x.com", 60 * min, 1) });
    expect(await settledError(old)).toBeInstanceOf(auth.StaleRefreshError);
    expect(lastUser()).toBeNull();
    expect(stored("ana", "refreshToken")).toBeNull();
  });

  it("stays signed out after a sign-out with no new sign-in", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const old = auth.getIdToken();
    auth.signOut();
    cognito.calls[0]!.answer({ ok: true, idToken: idToken("ana@x.com", 60 * min, 1) });
    expect(await settledError(old)).toBeInstanceOf(auth.StaleRefreshError);
    expect(lastUser()).toBeNull();
    expect(stored("ana", "idToken")).toBeNull();
  });
});

describe("a hung refresh", () => {
  it("uses the still-valid token after 12 seconds and frees the slot", async () => {
    const current = idToken("ana@x.com", 2 * min);
    storeSession("ana", "r1", current);
    const p = auth.getIdToken();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(cognito.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(current);
    void auth.getIdToken().catch(() => undefined);
    expect(cognito.calls).toHaveLength(2);
  });

  it("reports sign-in as unreachable when the token has lapsed", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", -1 * min));
    const p = settledError(auth.getIdToken());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await p).toBeInstanceOf(auth.SessionUnavailableError);
    expect(stored("ana", "refreshToken")).toBe("r1");
  });

  it("never reuses the refused token on a forced refresh", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 30 * min));
    const p = settledError(auth.getIdToken({ force: true }));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await p).toBeInstanceOf(auth.SessionUnavailableError);
  });

  it("saves a late answer when the session is unchanged", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const p = auth.getIdToken();
    await vi.advanceTimersByTimeAsync(12_000);
    await p;
    const fresh = idToken("ana@x.com", 60 * min, 1);
    cognito.calls[0]!.answer({ ok: true, idToken: fresh });
    expect(stored("ana", "idToken")).toBe(fresh);
    await expect(auth.getIdToken()).resolves.toBe(fresh);
  });

  it("ignores a late answer after a sign-out and a new sign-in", async () => {
    storeSession("ana", "r1", idToken("ana@x.com", 2 * min));
    const p = auth.getIdToken();
    await vi.advanceTimersByTimeAsync(12_000);
    await p;
    auth.signOut();
    const newId = idToken("ben@x.com", 60 * min);
    storeSession("ben", "b1", newId);
    cognito.calls[0]!.answer({ ok: true, idToken: idToken("ana@x.com", 60 * min, 1) });
    expect(lastUser()).toBe("ben");
    expect(stored("ana", "idToken")).toBeNull();
    expect(stored("ben", "idToken")).toBe(newId);
  });

  it("ignores a late refusal", async () => {
    const current = idToken("ana@x.com", 2 * min);
    storeSession("ana", "r1", current);
    const p = auth.getIdToken();
    await vi.advanceTimersByTimeAsync(12_000);
    await p;
    cognito.calls[0]!.answer({ ok: false, code: "NotAuthorizedException" });
    expect(lastUser()).toBe("ana");
    expect(stored("ana", "idToken")).toBe(current);
  });
});

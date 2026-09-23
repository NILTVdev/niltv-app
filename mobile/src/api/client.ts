import { ApiError } from "@niltv/types";

import { getIdToken } from "@/auth/cognito";
import { useAuthStore } from "@/auth/store";
import { config } from "@/config";

/**
 * Anything with zod's `parse` shape. Keeps this module (and the whole app)
 * free of a direct zod import — schemas come from `@niltv/types`.
 */
export interface Schema<T> {
  parse(input: unknown): T;
}

/** Pass where the response body doesn't matter (e.g. follow PUT/DELETE acks). */
export const Anything: Schema<unknown> = { parse: (input: unknown) => input };

/** Typed non-2xx (or no-session) failure thrown by {@link request}. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    /** parsed `{error}` code from the standard envelope, or "HTTP_ERROR" */
    readonly code: string,
    message?: string,
    readonly body?: unknown,
  ) {
    super(message ?? `${code} (HTTP ${status})`);
    this.name = "ApiRequestError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** JSON-serialized when present */
  body?: unknown;
  /**
   * true  → token required: throws ApiRequestError(401, "NO_SESSION") when signed out
   * false → never attach Authorization
   * unset → attach opportunistically when a session exists
   */
  auth?: boolean;
}

/**
 * Small fetch wrapper: prefixes `config.apiBase`, JSON headers, attaches
 * `Authorization: Bearer {idToken}` when a session exists, throws a typed
 * {@link ApiRequestError} on non-2xx, and zod-parses successful bodies.
 */
export async function request<T>(
  path: string,
  schema: Schema<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, auth } = options;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (auth !== false) {
    const signedIn = useAuthStore.getState().status === "signedIn";
    if (auth === true || signedIn) {
      const token = await getIdToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      } else if (auth === true) {
        throw new ApiRequestError(401, "NO_SESSION", "Sign in to continue.");
      }
    }
  }

  const res = await fetch(`${config.apiBase}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let payload: unknown;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = undefined;
    }
  }

  if (!res.ok) {
    const envelope = ApiError.safeParse(payload);
    throw new ApiRequestError(
      res.status,
      envelope.success ? envelope.data.error : "HTTP_ERROR",
      envelope.success ? envelope.data.message : undefined,
      payload,
    );
  }

  return schema.parse(payload);
}

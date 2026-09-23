/**
 * Typed fetch wrapper for the admin HTTP API. Every response is zod-parsed with
 * the `@niltv/types` contract; error bodies ({error, message}) surface as
 * ApiError with the server's message intact (e.g. the 409 NOT_READY reason).
 */
import {
  AdminContentListResponse,
  AdminContentStatusResponse,
  AdminContentUpsertRequest,
  AdminEntryUpsertRequest,
  AdminEventAuditResponse,
  AdminEventDetailResponse,
  AdminEventListResponse,
  AdminEventStatusRequest,
  AdminEventUpsertRequest,
  AdminProfileListResponse,
  AdminProfileUpsertRequest,
  AdminPublishResponse,
  AdminSubscriberListResponse,
  AdminUploadUrlResponse,
  ChannelsResponse,
  Content,
  Entry,
  EventEntity,
} from "@niltv/types";
import { z } from "zod";
import { getIdToken } from "./auth";
import { config } from "./config";

export { AdminContentStatusResponse };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  // input side pinned to `unknown` so T infers from the schema's OUTPUT type
  // (with .default()s applied), not the looser input type
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | null,
  body?: unknown,
): Promise<T> {
  if (!config.apiBase) throw new Error("VITE_ADMIN_API_BASE is not set.");
  const token = await getIdToken();
  const res = await fetch(config.apiBase + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 403) {
    throw new ApiError(403, "FORBIDDEN", "This account is not in the staff group.");
  }
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `Request failed (${res.status}).`;
    try {
      const parsed = (await res.json()) as { error?: string; message?: string };
      if (parsed.error) code = parsed.error;
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      /* non-JSON error body — keep the fallback message */
    }
    throw new ApiError(res.status, code, message);
  }

  if (!schema) return undefined as T;
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(res.status, "BAD_RESPONSE_SHAPE", `Unexpected ${path} response shape.`);
  }
  return parsed.data;
}

export const api = {
  listContent: () => request("GET", "/admin/content", AdminContentListResponse),
  upsertContent: (body: z.input<typeof AdminContentUpsertRequest>) =>
    request("POST", "/admin/content", Content, AdminContentUpsertRequest.parse(body)),
  uploadUrl: (id: string, contentType: string) =>
    request("POST", `/admin/content/${encodeURIComponent(id)}/upload-url`, AdminUploadUrlResponse, {
      contentType,
    }),
  contentStatus: (id: string) =>
    request("GET", `/admin/content/${encodeURIComponent(id)}/status`, AdminContentStatusResponse),
  publish: (id: string) =>
    request("POST", `/admin/content/${encodeURIComponent(id)}/publish`, AdminPublishResponse),
  /** Response shape unspecified in the contract — don't parse, just succeed/fail. */
  unpublish: (id: string) =>
    request<void>("POST", `/admin/content/${encodeURIComponent(id)}/unpublish`, null),
  listProfiles: () => request("GET", "/admin/profiles", AdminProfileListResponse),
  /** Response shape unspecified in the contract — refetch the list after. */
  upsertProfile: (body: z.input<typeof AdminProfileUpsertRequest>) =>
    request<void>("POST", "/admin/profiles", null, AdminProfileUpsertRequest.parse(body)),
  listChannels: () => request("GET", "/admin/channels", ChannelsResponse),
  listEvents: () => request("GET", "/admin/events", AdminEventListResponse),
  upsertEvent: (body: z.input<typeof AdminEventUpsertRequest>) =>
    request("POST", "/admin/events", EventEntity, AdminEventUpsertRequest.parse(body)),
  eventDetail: (id: string) =>
    request("GET", `/admin/events/${encodeURIComponent(id)}`, AdminEventDetailResponse),
  /** Break-glass manual transition (design §6.5) — refetch events after. */
  setEventStatus: (id: string, status: z.input<typeof AdminEventStatusRequest>["status"]) =>
    request<void>(
      "POST",
      `/admin/events/${encodeURIComponent(id)}/status`,
      null,
      AdminEventStatusRequest.parse({ status }),
    ),
  eventAudit: (id: string) =>
    request("GET", `/admin/events/${encodeURIComponent(id)}/audit`, AdminEventAuditResponse),
  upsertEntry: (eventId: string, body: z.input<typeof AdminEntryUpsertRequest>) =>
    request(
      "POST",
      `/admin/events/${encodeURIComponent(eventId)}/entries`,
      Entry,
      AdminEntryUpsertRequest.parse(body),
    ),
  deleteEntry: (eventId: string, entryId: string) =>
    request<void>(
      "DELETE",
      `/admin/events/${encodeURIComponent(eventId)}/entries/${encodeURIComponent(entryId)}`,
      null,
    ),
  listSubscribers: () => request("GET", "/admin/newsletter", AdminSubscriberListResponse),
};

/** Raw CSV export (design §6.7) — text body, so it bypasses the JSON request() path. */
export async function newsletterCsv(): Promise<string> {
  if (!config.apiBase) throw new Error("VITE_ADMIN_API_BASE is not set.");
  const token = await getIdToken();
  const res = await fetch(`${config.apiBase}/admin/newsletter?format=csv`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, `Export failed (${res.status}).`);
  return res.text();
}

/**
 * Presigned S3 PUT via XMLHttpRequest — fetch has no upload-progress events.
 * Content-Type must match what the URL was signed for.
 */
export function putToS3(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload to S3 failed (HTTP ${xhr.status}).`));
    xhr.onerror = () => reject(new Error("Upload to S3 failed (network or CORS error)."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(file);
  });
}

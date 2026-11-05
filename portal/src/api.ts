/**
 * Typed client for the portal API. Every request body is checked with its
 * `@niltv/types` contract schema before it leaves, and every response is
 * parsed with one before it reaches a screen. Error bodies ({error,
 * message}) surface as PortalApiError with the server's code and message.
 *
 * A 401 (or a session that can no longer refresh) calls the handler set
 * with onUnauthorized(), which signs the tab out.
 */
import {
  ApiError as ApiErrorBody,
  Availability,
  AvailabilityHeatmap,
  ConversationDetail,
  ConversationSummary,
  EventActionRequest,
  EventUpsertRequest,
  EventsResponse,
  GroupUpsertRequest,
  HelpRequest,
  HideMessageRequest,
  InboxResponse,
  MemberAddRequest,
  MemberListResponse,
  MemberUpdateRequest,
  MessagesResponse,
  MuteRequest,
  MyPostsResponse,
  OpenDeskRequest,
  PendingAthlete,
  PendingAthletesResponse,
  PendingLinkRequest,
  PeopleResponse,
  PortalEvent,
  PortalMeResponse,
  PortalMeUpdate,
  PortalMember,
  PortalMessage,
  PortalRequest,
  PortalRequestCreate,
  PortalRequestUpdate,
  PortalRequestsResponse,
  PortalSettings,
  Posting,
  PostingActionRequest,
  PostingUpsertRequest,
  PostingsResponse,
  Ask,
  AskActionRequest,
  AskUpsertRequest,
  AsksResponse,
  FileUrlResponse,
  SubmissionFile,
  UploadPartRequest,
  UploadStartRequest,
  UploadStartResponse,
  PushDevice,
  PushDevicesResponse,
  PushRemoveRequest,
  PushSubscribeRequest,
  ReadRequest,
  SendMessageRequest,
} from "@niltv/types";
import { z } from "zod";
import { getIdToken } from "./auth";
import { config } from "./config";
import { describeIssues } from "./lib/format";

export class PortalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PortalApiError";
  }
}

let unauthorizedHandler: (() => void) | undefined;

/** Called once by the app shell: what to do when the session is gone. */
export function onUnauthorized(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

const SESSION_ENDED = "Your session ended. Sign in again.";

/** Plain words for the codes the portal API returns without a message. */
function messageFor(status: number, code: string, serverMessage: string | undefined): string {
  if (serverMessage) return serverMessage;
  switch (code) {
    case "NOT_MEMBER":
      return "This account does not have portal access yet.";
    case "FORBIDDEN":
      return "Your role does not allow this.";
    case "STAFF_ONLY":
      return "Only staff post here.";
    case "NOT_FOUND":
      return "Not found. It may have been removed, or you no longer have access.";
    case "INVALID_REQUEST":
      return "Check the form and try again.";
    case "CONFLICT":
      return "Someone else changed this first. Refresh and try again.";
    default:
      return status >= 500 ? "Something went wrong on our side. Try again." : `Request failed (${status}).`;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Fetch with the bearer token; throws PortalApiError for any non-2xx. */
async function call(method: Method, path: string, body?: unknown): Promise<Response> {
  if (!config.apiBase) throw new PortalApiError(0, "NO_CONFIG", "VITE_PORTAL_API is not set.");
  let token: string;
  try {
    token = await getIdToken();
  } catch {
    unauthorizedHandler?.();
    throw new PortalApiError(401, "UNAUTHORIZED", SESSION_ENDED);
  }
  let res: Response;
  try {
    res = await fetch(config.apiBase + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new PortalApiError(0, "NETWORK", "Could not reach the portal. Check your connection and try again.");
  }
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new PortalApiError(401, "UNAUTHORIZED", SESSION_ENDED);
  }
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message: string | undefined;
    try {
      const parsed = ApiErrorBody.safeParse(await res.json());
      if (parsed.success) {
        code = parsed.data.error;
        message = parsed.data.message;
      }
    } catch {
      /* non-JSON error body: keep the fallback */
    }
    throw new PortalApiError(res.status, code, messageFor(res.status, code, message));
  }
  return res;
}

async function parse<T>(res: Response, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new PortalApiError(res.status, "BAD_RESPONSE", "The server sent something unexpected. Try again.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.warn(`portal: unexpected ${path} response`, parsed.error.issues);
    throw new PortalApiError(res.status, "BAD_RESPONSE_SHAPE", "The server sent something unexpected. Try again.");
  }
  return parsed.data;
}

/** Request with a parsed response. Input pinned to `unknown` so T is the schema's output type. */
async function request<T>(
  method: Method,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  body?: unknown,
): Promise<T> {
  return parse(await call(method, path, body), path, schema);
}

/** Request whose response has no contract shape ({status:"ok"}): success or a thrown error. */
async function requestOk(method: Method, path: string, body?: unknown): Promise<void> {
  await call(method, path, body);
}

/** Check an outgoing body against its contract schema; a readable error instead of a ZodError. */
function bodyOf<S extends z.ZodTypeAny>(schema: S, input: z.input<S>): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PortalApiError(0, "INVALID_INPUT", describeIssues(parsed.error.issues));
  return parsed.data;
}

const enc = encodeURIComponent;

export type SendResult = { message: PortalMessage; duplicate: false } | { duplicate: true };

export const api = {
  /* me */
  me: () => request("GET", "/v1/me", PortalMeResponse),
  updateMe: (input: z.input<typeof PortalMeUpdate>) =>
    request("PATCH", "/v1/me", PortalMeResponse, bodyOf(PortalMeUpdate, input)),

  /* push devices (POST is refused with 409 while the push switch is off) */
  pushDevices: () => request("GET", "/v1/push", PushDevicesResponse),
  subscribePush: (input: z.input<typeof PushSubscribeRequest>) =>
    request("POST", "/v1/push", PushDevice, bodyOf(PushSubscribeRequest, input)),
  /** This browser by endpoint, or a listed device by id. */
  removePush: (input: z.input<typeof PushRemoveRequest>) =>
    requestOk("POST", "/v1/push/remove", bodyOf(PushRemoveRequest, input)),

  /* members and settings */
  members: () => request("GET", "/v1/members", MemberListResponse),
  addMember: (input: z.input<typeof MemberAddRequest>) =>
    request("POST", "/v1/members", PortalMember, bodyOf(MemberAddRequest, input)),
  updateMember: (sub: string, input: z.input<typeof MemberUpdateRequest>) =>
    request("PATCH", `/v1/members/${enc(sub)}`, PortalMember, bodyOf(MemberUpdateRequest, input)),
  pendingAthletes: () => request("GET", "/v1/athletes/pending", PendingAthletesResponse),
  inviteAthlete: (applicationId: number) =>
    request("POST", `/v1/athletes/pending/${applicationId}/invite`, PendingAthlete),
  linkAthlete: (applicationId: number, input: z.input<typeof PendingLinkRequest>) =>
    request("POST", `/v1/athletes/pending/${applicationId}/link`, PortalMember, bodyOf(PendingLinkRequest, input)),
  settings: () => request("GET", "/v1/settings", PortalSettings),
  saveSettings: (input: z.input<typeof PortalSettings>) =>
    request("PUT", "/v1/settings", PortalSettings, bodyOf(PortalSettings, input)),

  /* messaging */
  inbox: () => request("GET", "/v1/inbox", InboxResponse),
  openDesk: (input: z.input<typeof OpenDeskRequest>) =>
    request("POST", "/v1/desks", ConversationSummary, bodyOf(OpenDeskRequest, input)),
  createGroup: (input: z.input<typeof GroupUpsertRequest>) =>
    request("POST", "/v1/groups", ConversationDetail, bodyOf(GroupUpsertRequest, input)),
  updateGroup: (id: string, input: z.input<typeof GroupUpsertRequest>) =>
    request("PUT", `/v1/groups/${enc(id)}`, ConversationDetail, bodyOf(GroupUpsertRequest, input)),
  conversation: (id: string) => request("GET", `/v1/conversations/${enc(id)}`, ConversationDetail),
  /** Who the @ list offers in a group or channel (desks: nobody). Up to 20. */
  people: (id: string, q: string) =>
    request("GET", `/v1/conversations/${enc(id)}/people?q=${enc(q)}`, PeopleResponse),
  /** Newest page (no cursor), older history (`before`), or the delta poll (`after`). */
  messages: (id: string, cursor: { before?: string; after?: string } = {}) => {
    const q = cursor.after ? `?after=${enc(cursor.after)}` : cursor.before ? `?before=${enc(cursor.before)}` : "";
    return request("GET", `/v1/conversations/${enc(id)}/messages${q}`, MessagesResponse);
  },
  /** 201 with the message, or 200 {duplicate:true} when this clientMsgId already landed. */
  sendMessage: async (id: string, input: z.input<typeof SendMessageRequest>): Promise<SendResult> => {
    const path = `/v1/conversations/${enc(id)}/messages`;
    const res = await call("POST", path, bodyOf(SendMessageRequest, input));
    if (res.status === 201) return { message: await parse(res, path, PortalMessage), duplicate: false };
    return { duplicate: true };
  },
  markRead: (id: string, seq: number) =>
    requestOk("POST", `/v1/conversations/${enc(id)}/read`, bodyOf(ReadRequest, { seq })),
  mute: (id: string, muted: boolean) =>
    requestOk("PUT", `/v1/conversations/${enc(id)}/mute`, bodyOf(MuteRequest, { muted })),
  hideMessage: (id: string, messageId: string, hidden: boolean) =>
    requestOk(
      "POST",
      `/v1/conversations/${enc(id)}/messages/${enc(messageId)}/hide`,
      bodyOf(HideMessageRequest, { hidden }),
    ),

  /* schedule */
  events: () => request("GET", "/v1/events", EventsResponse),
  createEvent: (input: z.input<typeof EventUpsertRequest>) =>
    request("POST", "/v1/events", PortalEvent, bodyOf(EventUpsertRequest, input)),
  updateEvent: (id: string, input: z.input<typeof EventUpsertRequest>) =>
    request("PUT", `/v1/events/${enc(id)}`, PortalEvent, bodyOf(EventUpsertRequest, input)),
  eventAction: (id: string, input: z.input<typeof EventActionRequest>) =>
    request("POST", `/v1/events/${enc(id)}/action`, PortalEvent, bodyOf(EventActionRequest, input)),
  availability: () => request("GET", "/v1/availability", Availability),
  saveAvailability: (input: z.input<typeof Availability>) =>
    request("PUT", "/v1/availability", Availability, bodyOf(Availability, input)),
  heatmap: (type: "everyone" | "campus" | "sport" | "group", value?: string) => {
    const q = `?type=${enc(type)}${value ? `&value=${enc(value)}` : ""}`;
    return request("GET", `/v1/availability/heatmap${q}`, AvailabilityHeatmap);
  },

  /* postings */
  postings: () => request("GET", "/v1/postings", PostingsResponse),
  createPosting: (input: z.input<typeof PostingUpsertRequest>) =>
    request("POST", "/v1/postings", Posting, bodyOf(PostingUpsertRequest, input)),
  updatePosting: (id: string, input: z.input<typeof PostingUpsertRequest>) =>
    request("PUT", `/v1/postings/${enc(id)}`, Posting, bodyOf(PostingUpsertRequest, input)),
  postingAction: (id: string, input: z.input<typeof PostingActionRequest>) =>
    requestOk("POST", `/v1/postings/${enc(id)}/action`, bodyOf(PostingActionRequest, input)),

  /* content hub */
  asks: () => request("GET", "/v1/asks", AsksResponse),
  createAsk: (input: z.input<typeof AskUpsertRequest>) =>
    request("POST", "/v1/asks", Ask, bodyOf(AskUpsertRequest, input)),
  updateAsk: (id: string, input: z.input<typeof AskUpsertRequest>) =>
    request("PUT", `/v1/asks/${enc(id)}`, Ask, bodyOf(AskUpsertRequest, input)),
  askAction: (id: string, input: z.input<typeof AskActionRequest>) =>
    requestOk("POST", `/v1/asks/${enc(id)}/action`, bodyOf(AskActionRequest, input)),
  startUpload: (id: string, input: z.input<typeof UploadStartRequest>) =>
    request("POST", `/v1/asks/${enc(id)}/uploads`, UploadStartResponse, bodyOf(UploadStartRequest, input)),
  uploadPart: (id: string, fileId: string, partNumber: number) =>
    request("POST", `/v1/asks/${enc(id)}/uploads/${enc(fileId)}/part`, FileUrlResponse, bodyOf(UploadPartRequest, { partNumber })),
  completeUpload: (id: string, fileId: string) =>
    request("POST", `/v1/asks/${enc(id)}/uploads/${enc(fileId)}/complete`, SubmissionFile),
  removeUpload: (id: string, fileId: string) => requestOk("DELETE", `/v1/asks/${enc(id)}/uploads/${enc(fileId)}`),
  fileUrl: (id: string, sub: string, fileId: string) =>
    request("GET", `/v1/asks/${enc(id)}/files/${enc(sub)}/${enc(fileId)}`, FileUrlResponse),

  /* requests and help */
  requests: () => request("GET", "/v1/requests", PortalRequestsResponse),
  createRequest: (input: z.input<typeof PortalRequestCreate>) =>
    request("POST", "/v1/requests", PortalRequest, bodyOf(PortalRequestCreate, input)),
  updateRequest: (id: string, input: z.input<typeof PortalRequestUpdate>) =>
    request("PATCH", `/v1/requests/${enc(id)}`, PortalRequest, bodyOf(PortalRequestUpdate, input)),
  help: (input: z.input<typeof HelpRequest>) => requestOk("POST", "/v1/help", bodyOf(HelpRequest, input)),

  /* my posts */
  myPosts: () => request("GET", "/v1/my-posts", MyPostsResponse),
};

/** Any thrown value as one readable line. */
export function errorText(err: unknown): string {
  if (err instanceof PortalApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Try again.";
}

export const isApiError = (err: unknown, code?: string): err is PortalApiError =>
  err instanceof PortalApiError && (code === undefined || err.code === code);

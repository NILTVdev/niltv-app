/**
 * Dashboard library sync contract: the body the ingest bridge POSTs to the
 * dashboard's `/api/library/sync` after each run.
 *
 * This mirrors the DASHBOARD's endpoint, not the app API, so it is snake_case
 * on purpose (the dashboard is a FastAPI service and owns the shape). Change it
 * only together with the dashboard's pydantic model. The dashboard ignores
 * unknown fields; list fields are always arrays, never null.
 */
import { z } from "zod";
import { IsoDate } from "./primitives";

/** Above this many items the dashboard answers 413; the sender skips the run instead. */
export const DASHBOARD_LIBRARY_SYNC_MAX_ITEMS = 5000;

/** An athlete credited on a clip, resolved from the app's profile rows. */
export const DashboardLibraryAthlete = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  handle: z.string().nullable(),
});
export type DashboardLibraryAthlete = z.infer<typeof DashboardLibraryAthlete>;

/** One content row with its labels. `content_id` is the app content id and the primary key. */
export const DashboardLibraryItem = z.object({
  content_id: z.string().min(1),
  /** Instagram media id when the clip came from Instagram; joins niltv_network_posts.post_id */
  ig_post_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  channel_name: z.string().nullable(),
  title: z.string(),
  caption: z.string().nullable(),
  summary: z.string().nullable(),
  keywords: z.array(z.string()),
  sport: z.string().nullable(),
  school: z.string().nullable(),
  content_type: z.string().nullable(),
  content_types: z.array(z.string()),
  categories: z.array(z.string()),
  sponsor: z.string().nullable(),
  athletes: z.array(DashboardLibraryAthlete),
  unresolved_handles: z.array(z.string()),
  /** app lifecycle status as stored, e.g. "published" or "withdrawn" */
  status: z.string(),
  /** app QC state, e.g. ready / needs-review / needs-tagging */
  qc_state: z.string().nullable(),
  /** public playback URLs only, never a bucket URL */
  poster_url: z.string().nullable(),
  video_url: z.string().nullable(),
  duration_sec: z.number().nullable(),
  posted_at: IsoDate.nullable(),
  updated_at: IsoDate.nullable(),
});
export type DashboardLibraryItem = z.infer<typeof DashboardLibraryItem>;

/** POST /api/library/sync body. `full: true` means rows missing from `items` are marked removed. */
export const DashboardLibrarySync = z.object({
  source: z.literal("niltv-app"),
  stage: z.enum(["dev", "prod"]),
  generated_at: IsoDate,
  full: z.boolean(),
  items: z.array(DashboardLibraryItem),
});
export type DashboardLibrarySync = z.infer<typeof DashboardLibrarySync>;

/** 200 response of POST /api/library/sync. */
export const DashboardLibrarySyncResponse = z.object({
  received: z.number().int().nonnegative(),
  upserted: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type DashboardLibrarySyncResponse = z.infer<typeof DashboardLibrarySyncResponse>;

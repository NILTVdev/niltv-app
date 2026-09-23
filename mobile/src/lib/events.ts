import type { EventCard } from "@niltv/types";

/**
 * An upcoming event still taking entries — stage 1 of the event arc
 * (the submissions stage). Home's hero, the NIL STAR hub, and the event
 * screen all branch on this to render SUBMISSIONS OPEN with a submit CTA
 * instead of the plain voting countdown.
 */
export function inSubmissions(event: Pick<EventCard, "status" | "submitUrl" | "entriesCloseAt">): boolean {
  return (
    event.status === "upcoming" &&
    event.submitUrl !== undefined &&
    event.entriesCloseAt !== undefined &&
    Date.parse(event.entriesCloseAt) > Date.now()
  );
}

/**
 * Poster frame for a mirrored intro reel, by convention: every
 * `/video/brand/<name>.mp4` has a `<name>-poster.jpg` uploaded beside it
 * (both stages). Keeps slides and cards from ever rendering black while a
 * video loads, with zero extra contract fields.
 */
export function introPosterUrl(videoUrl: string | undefined): string | undefined {
  return videoUrl?.endsWith(".mp4") ? videoUrl.replace(/\.mp4$/, "-poster.jpg") : undefined;
}

/** The best static art for an event card: season key art, else the reel's poster. */
export function eventArtUrl(
  event: Pick<EventCard, "heroImageUrl" | "introVideoUrl">,
): string | undefined {
  return event.heroImageUrl ?? introPosterUrl(event.introVideoUrl);
}

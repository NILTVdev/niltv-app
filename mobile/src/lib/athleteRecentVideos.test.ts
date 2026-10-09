import type { ContentCard } from "@niltv/types";
import { describe, expect, it } from "vitest";
import { athleteVideoRoute, recentAthleteVideos } from "./athleteRecentVideos";

const clip = (id: string, creatorId = "a-1"): ContentCard => ({
  id, creatorId, title: id, creatorName: "Athlete", creatorIsAmbassador: false,
  channelId: "channel-1", channelName: "NILTV",
});

describe("athlete recent videos", () => {
  it("keeps the newest-first API order and limits previews to three without mutating the response", () => {
    const items = [clip("newest"), clip("second"), clip("third"), clip("older")];
    expect(recentAthleteVideos(items, "a-1").map((item) => item.id)).toEqual(["newest", "second", "third"]);
    expect(items).toHaveLength(4);
  });

  it("leaves missing, empty, or failed results blank, including stale cached results", () => {
    expect(recentAthleteVideos(undefined, "a-1")).toEqual([]);
    expect(recentAthleteVideos([], "a-1")).toEqual([]);
    expect(recentAthleteVideos([clip("stale")], "a-1", true)).toEqual([]);
  });

  it("excludes other athletes and duplicate videos while keeping clips without thumbnails tappable", () => {
    expect(recentAthleteVideos([clip("other", "a-2"), clip("first"), clip("first"), clip("second")], "a-1")
      .map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("opens the selected video with the athlete feed as swipe context", () => {
    expect(athleteVideoRoute("video-2", "a-1")).toEqual({
      pathname: "/video/[contentId]", params: { contentId: "video-2", profileId: "a-1" },
    });
  });
});
import { describe, expect, it } from "vitest";
import { contentTombstone } from "../../lib/db";
import {
  buildLibraryCsv,
  channelAccountFor,
  CSV_NEWLINE_MARK,
  csvField,
  existingRowDisposition,
  libraryAccountLine,
  libraryRowFor,
  libraryRowForWithheld,
  networkPostToCandidate,
  networkPostToPost,
  sortLibraryRows,
  titleFromCaption,
} from "./ingest-social";

const post = (overrides: Record<string, unknown> = {}) => ({
  account: "niltv",
  ig_post_id: "18103458889939692",
  posted_at: "2026-08-25T18:00:04Z",
  media_type: "VIDEO",
  caption: "hello",
  permalink: "https://www.instagram.com/reel/DceN6YoptfT/",
  media_url: "https://cdn.example/x.mp4",
  thumbnail_url: null,
  ...overrides,
});

describe("csvField", () => {
  it("passes plain values through unquoted", () => {
    expect(csvField("hello world")).toBe("hello world");
  });

  it("quotes commas and doubles embedded quotes", () => {
    expect(csvField('a, "b"')).toBe('"a, ""b"""');
  });

  it("replaces raw newlines with the marker — IMPORTDATA splits rows on them even inside quotes", () => {
    const out = csvField("line one\r\nline two");
    expect(out).toBe(`"line one${CSV_NEWLINE_MARK}line two"`);
    expect(out).not.toContain("\n");
  });
});

describe("libraryAccountLine", () => {
  it("shows just the channel for owned posts", () => {
    expect(libraryAccountLine(post())).toBe("@niltv");
  });

  it("shows the original author with the channel for collab posts", () => {
    expect(libraryAccountLine(post({ source_author: "sample_athlete" }))).toBe("@sample_athlete (via niltv)");
  });
});

describe("libraryRowFor", () => {
  it("builds the public download URL and a date-only posted field", () => {
    const row = libraryRowFor(post(), "https://cdn.niltv.example");
    expect(row.downloadLink).toBe(
      "https://cdn.niltv.example/video/ig-18103458889939692/master.mp4",
    );
    expect(row.postLink).toBe("https://www.instagram.com/reel/DceN6YoptfT/");
    expect(row.posted).toBe("2026-08-25");
  });
});

describe("buildLibraryCsv", () => {
  it("emits the header, one line per row in order, and a trailing newline", () => {
    const csv = buildLibraryCsv([
      libraryRowFor(post({ caption: "first, with comma" }), "https://cdn"),
      libraryRowFor(post({ ig_post_id: "2", caption: "multi\nline" }), "https://cdn"),
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Post Link,Download Link,Account / Collaborators,Caption,Posted");
    expect(lines[1]).toContain('"first, with comma"');
    expect(lines[2]).toContain(`"multi${CSV_NEWLINE_MARK}line"`);
    expect(lines).toHaveLength(4); // header + 2 rows + trailing empty
    expect(lines[3]).toBe("");
  });
});

// Pre-existing helpers touched by the same handler — pin their behaviour.
describe("channelAccountFor", () => {
  it("prefers the campus channel over the flagship", () => {
    expect(channelAccountFor("niltv,starkvilletv")).toBe("starkvilletv");
    expect(channelAccountFor("niltv")).toBe("niltv");
  });

  it("never routes to an off-roster account", () => {
    // Off-roster accounts can sit in the dashboard pull but are NOT network
    // channels: a post tagged only to them must not create a channel...
    expect(channelAccountFor("extratv")).toBeUndefined();
    expect(channelAccountFor("sparetv,othercitytv")).toBeUndefined();
    // ...and one tagged to both routes to the rostered channel.
    expect(channelAccountFor("extratv,dorecitytv")).toBe("dorecitytv");
    expect(channelAccountFor("niltv,sparetv")).toBe("niltv");
    expect(channelAccountFor(null)).toBeUndefined();
  });
});

describe("titleFromCaption", () => {
  it("strips trailing hashtags and caps at 80 chars", () => {
    expect(titleFromCaption("Great win today #duke #soccer", "niltv")).toBe("Great win today");
    expect(titleFromCaption(null, "niltv")).toBe("New on NIL TV");
  });
});

describe("libraryRowForWithheld", () => {
  it("keeps the Instagram link and leaves the Download Link empty", () => {
    const row = libraryRowForWithheld(post({ media_url: null }) as never);
    expect(row.postLink).toBe("https://www.instagram.com/reel/DceN6YoptfT/");
    expect(row.downloadLink).toBe("");
    expect(row.posted).toBe("2026-08-25");
  });
});

describe("sortLibraryRows", () => {
  it("interleaves mirrored and link-only rows newest-first", () => {
    const a = libraryRowFor(post({ posted_at: "2026-08-20T00:00:00Z" }) as never, "https://cdn");
    const b = libraryRowForWithheld(post({ posted_at: "2026-08-26T00:00:00Z", media_url: null }) as never);
    const c = libraryRowFor(post({ posted_at: "2026-08-23T00:00:00Z" }) as never, "https://cdn");
    expect(sortLibraryRows([a, b, c]).map((r) => r.posted)).toEqual([
      "2026-08-26",
      "2026-08-23",
      "2026-08-20",
    ]);
  });
});

describe("existingRowDisposition", () => {
  it("absent when the existence GetCommand found no row", () => {
    expect(existingRowDisposition(undefined)).toBe("absent");
  });

  it("published for any live row (the projection only carries PK)", () => {
    expect(existingRowDisposition({ PK: "CONTENT#ig-1" })).toBe("published");
    expect(existingRowDisposition({ PK: "CONTENT#ig-1", removed: false })).toBe("published");
  });

  it("removed for a tombstone, so a staff-removed post is never re-mirrored", () => {
    expect(existingRowDisposition({ PK: "CONTENT#ig-1", removed: true })).toBe("removed");
    // Spread: the interface has no index signature, the helper takes a plain record.
    expect(existingRowDisposition({ ...contentTombstone("ig-1", "removed by staff") })).toBe("removed");
  });

  it("only a literal boolean true counts as removed", () => {
    expect(existingRowDisposition({ PK: "CONTENT#ig-1", removed: "true" })).toBe("published");
    expect(existingRowDisposition({ PK: "CONTENT#ig-1", removed: 1 })).toBe("published");
  });
});

describe("networkPostToPost vs networkPostToCandidate", () => {
  const net = (overrides: Record<string, unknown> = {}) => ({
    post_id: "18000000000000001",
    account_username: "athlete1",
    description: "great reel",
    publish_time: "2026-08-25T18:00:04Z",
    permalink: "https://www.instagram.com/reel/Dabc123/",
    post_type: "Reel",
    media_url: null,
    thumbnail_url: "https://cdn.example/t.jpg",
    collab_accounts: "niltv,dorecitytv",
    ...overrides,
  });

  it("a withheld reel still shapes as a post (for the sheet) but never as a candidate", () => {
    const shaped = networkPostToPost(net() as never);
    expect(shaped?.account).toBe("dorecitytv");
    expect(shaped?.media_url).toBeNull();
    expect(networkPostToCandidate(net() as never)).toBeUndefined();
  });

  it("a reel with media is both", () => {
    const withMedia = net({ media_url: "https://cdn.example/v.mp4" });
    expect(networkPostToPost(withMedia as never)?.media_url).toBe("https://cdn.example/v.mp4");
    expect(networkPostToCandidate(withMedia as never)?.ig_post_id).toBe("18000000000000001");
  });
});

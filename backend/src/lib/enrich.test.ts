import { describe, expect, it } from "vitest";
import {
  applyEnrichment,
  captionWord,
  deriveEditorial,
  LEGACY_FALLBACK_TITLE,
  TITLE_NEEDS_WRITING,
  titleFor,
  extractHandles,
  extractHashtags,
  inferContentType,
  inferSport,
  normalizeSport,
  profilesByHandle,
  qcFor,
  resolveAthletes,
  rightsDefaults,
} from "./enrich";

const NOW = new Date("2026-09-10T12:00:00Z");

const profiles = [
  { id: "ath-jordan", name: "Jordan Rivera", handle: "jordan.rivera", school: "Example State", sport: "Women's Soccer", previousHandles: ["jordan_r"] },
  { id: "ath-casey", name: "Casey Morgan", handle: "caseymorgan", school: "Example Tech", sport: "Basketball" },
  { id: "p-niltv", name: "NIL TV", handle: "niltv", school: "", sport: "" },
];
const byHandle = profilesByHandle(profiles);
const ownAccounts = new Set(["niltv", "truebluetv", "chapelhilltv"]);

describe("text extraction", () => {
  it("pulls handles and hashtags, lowercased, deduplicated, in order", () => {
    expect(extractHandles("Big day with @Jordan.Rivera and @caseymorgan. @jordan.rivera again")).toEqual(["jordan.rivera", "caseymorgan"]);
    expect(extractHandles("email me@example.com")).toEqual([]);
    expect(extractHashtags("Preseason vibes #Soccer #preseason #duke #soccer")).toEqual(["soccer", "preseason", "duke"]);
  });
});

describe("sport", () => {
  it("normalizes roster strings", () => {
    expect(normalizeSport("Women's Soccer")).toBe("soccer");
    expect(normalizeSport("Track & Field")).toBe("track-field");
    expect(normalizeSport("XC")).toBe("cross-country");
    expect(normalizeSport("Chess")).toBeUndefined();
  });

  it("prefers a sport hashtag, then caption words, then the athlete's roster sport as a weak hint", () => {
    expect(inferSport("#soccer", "Basketball")).toEqual({ sport: "soccer", confidence: 0.8, via: "hashtag" });
    expect(inferSport("Preseason vibes #soccer #duke")).toEqual({ sport: "soccer", confidence: 0.8, via: "hashtag" });
    expect(inferSport("first lacrosse practice of the fall")).toEqual({ sport: "lacrosse", confidence: 0.5, via: "caption" });
    expect(inferSport("day of my life in the summer", "Football")).toEqual({ sport: "football", confidence: 0.4, via: "athlete" });
    expect(inferSport("day of my life in the summer").sport).toBeUndefined();
  });
});

describe("content type", () => {
  it("scores hashtags above caption words and returns secondaries", () => {
    const haul = inferContentType("shoutout to examplebrand & jumpman23 ! #gearhaul #ad");
    expect(haul.contentType).toBe("gear-haul");
    expect(haul.secondary).toContain("brand-sponsored");
    expect(haul.confidence).toBe(0.9);
    expect(inferContentType("day of my life in the summer #explorepage").contentType).toBe("ditl-vlog");
    expect(inferContentType("Great question of the day today #baseball").contentType).toBe("team-qa");
    expect(inferContentType("Best tasting meal I make easily #cooking #food").contentType).toBe("what-i-eat");
    expect(inferContentType("Knee bend challenge!!").confidence).toBe(0);
  });
});

describe("editorial", () => {
  it("derives a clean title, description, summary and keywords from the caption", () => {
    const e = deriveEditorial("Preseason vibes 😓😴 #soccer #preseason #duke", "Jordan Rivera, Example State: Example State TV");
    expect(e.title).toBe("Preseason vibes");
    expect(e.description).toBe("Preseason vibes");
    expect(e.keywords).toEqual(["soccer", "preseason", "duke"]);
    expect(deriveEditorial("@nilstar", "Fallback Title").title).toBe("Fallback Title");
  });
});

describe("title ladder", () => {
  const base = { channelName: "Example State TV", accountSchool: "Example State" };

  it("uses the caption when two words survive, keeping a line whose first sentence is one word", () => {
    expect(titleFor({ ...base, caption: "Preseason vibes 😓 #soccer" })).toEqual({ title: "Preseason vibes", source: "caption" });
    expect(titleFor({ ...base, caption: "Consistency! Be consistent even when you don’t feel like it! 🫡\n#reels" }).title).toBe(
      "Consistency! Be consistent even when you don’t feel like it!",
    );
  });

  it("credits a complete athlete before any single-word caption", () => {
    expect(titleFor({ ...base, caption: "MVP.", athleteName: "Jordan Rivera", athleteSchool: "Example State" })).toEqual({
      title: "Jordan Rivera, Example State: Example State TV",
      source: "athlete",
    });
  });

  it("takes one real word of caption, spelling out creator shorthand", () => {
    expect(titleFor({ ...base, caption: "MVP." })).toEqual({ title: "MVP", source: "caption-word" });
    expect(titleFor({ ...base, caption: "Patience. \n\nShort term discomfort >> long term gains" }).title).toBe("Patience");
    expect(titleFor({ ...base, caption: "DITL 🧡\n\n#ditl #d1athlete" }).title).toBe("Day in the Life");
    expect(titleFor({ ...base, caption: "diml ⭐️\n\n#athlete #college" }).title).toBe("Day in My Life");
    expect(captionWord("3…..2….1…..😈😤⚾️")).toBeUndefined();
    expect(captionWord("@nilstar")).toBeUndefined();
  });

  it("names the creator by handle, with school and sport when known", () => {
    expect(titleFor({ ...base, caption: "😍😍\n\n#volleyball #explore", creatorHandle: "sam.jay", school: "Example State", sport: "volleyball" })).toEqual({
      title: "@sam.jay, Example State Volleyball",
      source: "creator",
    });
    expect(titleFor({ channelName: "NIL TV", caption: "#bts #photoshoot", creatorHandle: "sam.jay" }).title).toBe("@sam.jay");
  });

  it("falls to school, sport and format, then to the channel's people", () => {
    expect(titleFor({ ...base, caption: "💙 #mediaday #soccer", school: "Duke", sport: "soccer", contentType: "media-day" })).toEqual({
      title: "Duke Soccer Media Day",
      source: "school-sport",
    });
    expect(titleFor({ ...base, caption: "#duke #snowstorm", school: "Duke", accountSchool: "Duke", sport: "none-visible" })).toEqual({
      title: "Duke’s Athletes",
      source: "channel",
    });
    expect(titleFor({ channelName: "NIL TV", caption: "" }).title).toBe("NIL TV Athletes");
  });

  it("never produces a generic 'New on' title", () => {
    const cases = ["", "@nilstar", "😈💙", "#duke #d1", "3…2…1…", "MVP."];
    for (const caption of cases) {
      for (const inputs of [{ ...base, caption }, { channelName: "NIL TV", caption }, { ...base, caption, creatorHandle: "sam.jay" }]) {
        expect(titleFor(inputs).title).not.toMatch(LEGACY_FALLBACK_TITLE);
      }
    }
  });
});

describe("people", () => {
  it("credits the author, adds mentions, matches previous handles, skips our own accounts, queues strangers", () => {
    const r = resolveAthletes({ authorHandle: "jordan_r", caption: "with @caseymorgan and @niltv and @someone.new" }, byHandle, ownAccounts);
    expect(r.athleteId).toBe("ath-jordan");
    expect(r.featuredAthleteIds).toEqual(["ath-jordan", "ath-casey"]);
    expect(r.unresolvedHandles).toEqual(["someone.new"]);
  });
});

describe("rights defaults", () => {
  it("sets status and music defaults by origin", () => {
    expect(rightsDefaults("instagram-owned")).toEqual({ status: "owned", music: "none" });
    expect(rightsDefaults("instagram-collab")).toEqual({ status: "licensed", music: "none" });
    expect(rightsDefaults("upload")).toEqual({ status: "owned", music: "none" });
    expect(rightsDefaults("youtube")).toEqual({ status: "owned", music: "none" });
  });
});

describe("applyEnrichment", () => {
  const ctx = { profilesByHandle: byHandle, ownAccounts, channelName: "Example State TV", accountSchool: "Example State", schoolPolicy: { blockedSchools: ["Example Tech"] }, now: NOW };
  const row = {
    id: "ig-1",
    title: "iykyk (the bench knows) 😂 #soccer #preseason @jordan.rivera",
    description: "iykyk (the bench knows) 😂 #soccer #preseason @jordan.rivera",
    channelId: "ch-examplestatetv",
    athleteId: "p-examplestatetv",
    transcodeStatus: "published",
    publishedAt: "2026-07-12T23:59:12Z",
    playbackPath: "/video/ig-1/master.mp4",
    thumbPath: "/video/ig-1/poster.jpg",
    source: { kind: "instagram-collab", account: "examplestatetv", authorHandle: "jordan.rivera", caption: "iykyk (the bench knows) 😂 #soccer #preseason @jordan.rivera" },
  };

  it("derives everything from source and credits the real athlete over the pseudo-profile", () => {
    const out = applyEnrichment(row, ctx);
    expect(out["athleteId"]).toBe("ath-jordan");
    expect(out["featuredAthleteIds"]).toEqual(["ath-jordan"]);
    expect(out["sport"]).toBe("soccer");
    expect(out["school"]).toBe("Example State");
    expect(out["contentType"]).toBe("skit-humor");
    expect(out["title"]).toBe("iykyk (the bench knows)");
    expect(out["rights"]).toMatchObject({ status: "licensed", music: "none", logoCleared: true });
    expect(out["source"]).toEqual(row.source);
    expect((out["qc"] as { partners: string }).partners).toBe("ready");
  });

  it("never touches an overridden field, rights included, and recomputes rights nobody overrode", () => {
    const edited = { ...row, title: "Jordan's preseason skit", sport: "basketball", overrides: ["title", "sport", "rights.status", "rights.music"], rights: { status: "restricted", logoCleared: false, music: "platform", territory: ["US"] } };
    const out = applyEnrichment(edited, ctx);
    expect(out["title"]).toBe("Jordan's preseason skit");
    expect(out["sport"]).toBe("basketball");
    // status and music were a person's call and stay; marks were not and follow policy; territory is never derived
    expect(out["rights"]).toMatchObject({ status: "restricted", music: "platform", logoCleared: true, territory: ["US"] });
    expect((out["qc"] as { partners: string }).partners).toBe("needs-rights");
  });

  it("keeps the channel credit while a resolved profile is incomplete, but still records the person", () => {
    const thin = new Map(byHandle);
    thin.set("sam.jay", { id: "ath-sam", name: "J a y", handle: "sam.jay", school: "", sport: "" });
    const out = applyEnrichment({ ...row, source: { ...row.source, authorHandle: "sam.jay", caption: "3 football and 1 volleyball" } }, { ...ctx, profilesByHandle: thin });
    expect(out["athleteId"]).toBe("p-examplestatetv");
    expect(out["featuredAthleteIds"]).toEqual(["ath-sam"]);
    expect(out["incompleteProfile"]).toBe("ath-sam");
    expect((out["qc"] as { reasons: string[] }).reasons).toContain("athlete profile incomplete");
  });

  it("marks are cleared unless the school opted out; no school means no marks question", () => {
    const duke = applyEnrichment({ ...row, source: { ...row.source, kind: "instagram-owned", authorHandle: undefined, caption: "clinic day #duketennis" } }, { ...ctx, accountSchool: "Duke", channelName: "TrueBlueTV" });
    expect((duke["rights"] as { logoCleared: boolean }).logoCleared).toBe(true);
    expect(duke["sport"]).toBe("tennis");
    const blocked = applyEnrichment({ ...row, source: { ...row.source, kind: "instagram-owned", authorHandle: undefined, caption: "media day on campus" } }, { ...ctx, accountSchool: "Example Tech" });
    expect((blocked["rights"] as { logoCleared: boolean }).logoCleared).toBe(false);
    const none = applyEnrichment({ ...row, source: { ...row.source, kind: "instagram-owned", authorHandle: undefined, caption: "game night with athletes from five schools" } }, { ...ctx, accountSchool: undefined });
    expect(none["school"]).toBeUndefined();
    expect((none["rights"] as { logoCleared: boolean }).logoCleared).toBe(true);
  });

  it("titles a hashtag-only collab from its creator and queues it for a person", () => {
    const out = applyEnrichment({ ...row, title: "New on Example State TV", description: "", source: { ...row.source, authorHandle: "sam.jay", caption: "😍😍😍\n\n#volleyball #explore #studentathlete" } }, ctx);
    expect(out["title"]).toBe("@sam.jay, Example State Volleyball");
    expect(out["titleSource"]).toBe("creator");
    expect((out["qc"] as { reasons: string[] }).reasons).toContain(TITLE_NEEDS_WRITING);
  });

  it("skips our own accounts and team handles as creators", () => {
    const own = applyEnrichment({ ...row, source: { ...row.source, kind: "instagram-owned", authorHandle: "truebluetv", caption: "💙😈 #duke #soccer" } }, { ...ctx, accountSchool: "Duke", channelName: "TrueBlue TV" });
    expect(own["title"]).toBe("Duke Soccer");
    const team = applyEnrichment({ ...row, source: { ...row.source, authorHandle: "dukewlax", caption: "🔥🔥" } }, { ...ctx, accountSchool: "Duke", channelName: "TrueBlue TV" });
    expect(team["title"]).toBe("Duke’s Athletes");
  });

  it("does not read an old 'New on' title back as a caption", () => {
    const legacy = { ...row, title: "New on Example State TV", description: "", source: { kind: "instagram-owned", account: "examplestatetv" } };
    const out = applyEnrichment(legacy, ctx);
    expect(out["title"]).toBe("Example State’s Athletes");
    expect(out["titleSource"]).toBe("channel");
  });

  it("keeps a staff title, marks it as theirs and leaves it out of the queue", () => {
    const out = applyEnrichment({ ...row, title: "Media day with the volleyball team", overrides: ["title"], source: { ...row.source, authorHandle: "sam.jay", caption: "😍 #volleyball" } }, ctx);
    expect(out["title"]).toBe("Media day with the volleyball team");
    expect(out["titleSource"]).toBe("staff");
    expect((out["qc"] as { reasons: string[] }).reasons).not.toContain(TITLE_NEEDS_WRITING);
  });

  it("leaves a caption title out of the queue", () => {
    const out = applyEnrichment(row, ctx);
    expect(out["titleSource"]).toBe("caption");
    expect((out["qc"] as { reasons: string[] }).reasons).not.toContain(TITLE_NEEDS_WRITING);
  });
});

describe("qcFor", () => {
  it("keeps the app and site on today's rule and lists partner reasons", () => {
    const qc = qcFor({ id: "x", transcodeStatus: "published", publishedAt: "2026-09-01T00:00:00Z", playbackPath: "/video/x/master.mp4", thumbPath: "/video/x/poster.jpg", title: "@nilstar", rights: { status: "owned", logoCleared: true, music: "none" }, sport: "soccer", contentType: "skit-humor" }, { now: NOW });
    expect(qc.app).toBe("ready");
    expect(qc.site).toBe("needs-tagging");
    expect(qc.partners).toBe("ready");
    expect(qc.reasons).toContain("title under two words");
  });

  it("holds a clip with no poster off every surface", () => {
    const qc = qcFor({ id: "x", transcodeStatus: "published", publishedAt: "2026-09-01T00:00:00Z", playbackPath: "/video/x/master.mp4", title: "Duke wins the ACC", rights: { status: "owned", logoCleared: true, music: "none" }, sport: "baseball", contentType: "game-day" }, { now: NOW });
    expect(qc.app).toBe("needs-review");
    expect(qc.site).toBe("needs-review");
    expect(qc.reasons).toContain("no poster");
  });

  it("queues a rule-made title until a person overrides it", () => {
    const clip = { id: "x", transcodeStatus: "published", publishedAt: "2026-09-01T00:00:00Z", playbackPath: "/video/x/master.mp4", thumbPath: "/video/x/poster.jpg", title: "Duke’s Athletes", titleSource: "channel" };
    expect(qcFor(clip, { now: NOW }).reasons).toContain(TITLE_NEEDS_WRITING);
    expect(qcFor({ ...clip, title: "Snow day practice", overrides: ["title"] }, { now: NOW }).reasons).not.toContain(TITLE_NEEDS_WRITING);
  });
});

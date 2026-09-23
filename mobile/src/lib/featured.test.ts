import { describe, expect, it } from "vitest";

import { featuredSlides, nilStarAuditionsBillboard, nilStarBillboard } from "./featured";

const CDN = "https://cdn.example.test";

describe("featuredSlides", () => {
  it("is the site hero's three horizontal episodes, in site order, without the NIL Star reel", () => {
    expect(featuredSlides(CDN).map((s) => s.title)).toEqual([
      "Sweat It Out",
      "Big Noon Kickoff",
      "UCA Nationals 2026",
    ]);
    // No 9:16 reel on the app hero, so it renders at compact height.
    expect(featuredSlides(CDN).every((s) => s.aspect === "16:9")).toBe(true);
  });

  it("builds every url off the stage cdn it is given", () => {
    for (const s of featuredSlides(CDN)) {
      expect(s.loopUrl.startsWith(`${CDN}/video/`)).toBe(true);
      expect(s.posterUrl.startsWith(`${CDN}/video/`)).toBe(true);
      if (s.watch.kind === "theater") {
        expect(s.watch.src.startsWith(`${CDN}/video/`)).toBe(true);
        expect(s.watch.poster).toBe(s.posterUrl);
      }
    }
    // Same keys in both buckets: swapping the cdn swaps every url.
    const prod = featuredSlides("https://prod.example.test");
    expect(prod[0]?.loopUrl).toBe("https://prod.example.test/video/hz-sweat-it-out/hero-loop.mp4");
    expect(prod[1]?.posterUrl).toBe("https://prod.example.test/video/hz-big-noon-kickoff/poster.jpg");
  });

  it("hz episodes are 16:9 muted loops whose Watch opens the full cut in the theater", () => {
    const [sweat, bigNoon, uca] = featuredSlides(CDN);
    for (const s of [sweat, bigNoon, uca]) {
      expect(s?.aspect).toBe("16:9");
      expect(s?.hasAudio).toBe(false);
      expect(s?.loopUrl).toMatch(/\/hero-loop\.mp4$/);
      expect(s?.watch.kind).toBe("theater");
    }
    expect(sweat?.watch).toEqual({
      kind: "theater",
      src: `${CDN}/video/hz-sweat-it-out/master-fs.mp4`,
      poster: `${CDN}/video/hz-sweat-it-out/poster.jpg`,
      title: "Sweat It Out with Bull City Pepper Co.",
      kicker: "Sweat It Out",
    });
    expect(uca?.watch).toMatchObject({ title: "UCA Nationals 2026, Cincinnati", kicker: "Cheer" });
  });
});

describe("nilStarBillboard", () => {
  it("is the site's Season 1 billboard: 9:16 reel with audio, Watch in the vertical player", () => {
    const star = nilStarBillboard(CDN);
    expect(star.title).toBe("NIL Star");
    expect(star.kicker).toBe("Season 1 Champion Crowned");
    expect(star.aspect).toBe("9:16");
    expect(star.hasAudio).toBe(true);
    expect(star.loopUrl).toBe(`${CDN}/video/ig-18106275875112509/master.mp4`);
    expect(star.watch).toEqual({ kind: "content", contentId: "ig-18106275875112509", channelId: "ch-nilstar" });
  });
});

describe("nilStarAuditionsBillboard", () => {
  it("is a 16:9 hz slide off the given cdn whose Watch opens the full cut in the theater", () => {
    const cut = nilStarAuditionsBillboard(CDN);
    expect(cut.key).toBe("hz-nilstar-auditions");
    expect(cut.aspect).toBe("16:9");
    expect(cut.hasAudio).toBe(false);
    expect(cut.kicker).toBe("Audition Compilation");
    expect(cut.title).toBe("NIL Singing Star Finalists");
    expect(cut.loopUrl).toBe(`${CDN}/video/hz-nilstar-auditions/hero-loop.mp4`);
    expect(cut.posterUrl).toBe(`${CDN}/video/hz-nilstar-auditions/poster.jpg`);
    expect(cut.watch).toEqual({
      kind: "theater",
      src: `${CDN}/video/hz-nilstar-auditions/master-fs.mp4`,
      poster: `${CDN}/video/hz-nilstar-auditions/poster.jpg`,
      title: "NIL Singing Star Finalists: The Auditions",
      kicker: "Audition Compilation",
    });
    // Same keys in both buckets: swapping the cdn swaps every url.
    expect(nilStarAuditionsBillboard("https://prod.example.test").posterUrl).toBe(
      "https://prod.example.test/video/hz-nilstar-auditions/poster.jpg",
    );
  });
});

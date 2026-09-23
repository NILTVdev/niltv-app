/**
 * Seed fixtures — parsed through the entity schemas at module load, so defaults
 * apply and drift from the contract fails fast.
 *
 * Two kinds of data live here, and the difference matters:
 *
 * - Channels, profiles and content are the vision demo's fictional placeholders
 *   (the vision demo page) — no real athlete appears among them. They
 *   stay fictional until the roster import.
 * - `fixtureEvents` is REAL. It carries the one competition NIL TV has
 *   actually run, mirroring niltv.com: the completed NIL STAR Season 1 recap
 *   (champion Bella Calvanese + the Top 20). The site is the source of truth.
 *   Only competitions that exist belong here, so the app never advertises an
 *   event that is not real.
 */
import { z } from "zod";
import { AppConfig, Channel, Content, Entry, EventEntity, Profile } from "./entities";

/** Public Mux test stream — lets the dev player actually play before real transcodes exist. */
export const DEV_HLS_URL = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

export const fixtureChannels = z.array(Channel).parse([
  { id: "ch-trueblue", name: "TrueBlue TV", kind: "trueblue", color: "#003087", about: "The Duke cornerstone channel." },
  { id: "ch-niltv", name: "NIL TV", kind: "niltv", color: "#C2A030", about: "The flagship NILTV channel." },
]);

/**
 * Demo ambassador flags: indices [2,0,4,1,7,3,6,8] of the finalist list, in rank order
 * (vision.html:459). Marcus Lee and Isaiah Carter stay plain "collaborated athletes".
 */
export const fixtureProfiles = z.array(Profile).parse([
  { id: "ath-camila-garza", name: "Camila Garza", handle: "@camilagarza", school: "Duke", sport: "Lacrosse", followers: 184_000, totalViews: 2_300_000, statuses: ["athlete", "ambassador"], ambassadorRank: 2, bio: "Two-time All-American bringing lacrosse to a new audience, one highlight at a time." },
  { id: "ath-jordan-banks", name: "Jordan Banks", handle: "@jbanks", school: "UNC", sport: "Basketball", followers: 312_000, totalViews: 5_100_000, statuses: ["athlete", "ambassador"], ambassadorRank: 4, bio: "Point guard with a mixtape game and a community-first mindset." },
  { id: "ath-maya-robinson", name: "Maya Robinson", handle: "@mayarobinson", school: "UCLA", sport: "Gymnastics", followers: 521_000, totalViews: 9_400_000, statuses: ["athlete", "ambassador"], ambassadorRank: 1, bio: "Viral floor routines and a story about coming back from injury." },
  { id: "ath-tyler-brooks", name: "Tyler Brooks", handle: "@tylerbrooks", school: "Ohio State", sport: "Football", followers: 268_000, totalViews: 4_000_000, statuses: ["athlete", "ambassador"], ambassadorRank: 6, bio: "QB1 energy on and off the field — built different." },
  { id: "ath-sofia-nguyen", name: "Sofia Nguyen", handle: "@sofian", school: "Stanford", sport: "Soccer", followers: 142_000, totalViews: 1_800_000, statuses: ["athlete", "ambassador"], ambassadorRank: 3, bio: "Engineering major by day, golazo machine on weekends." },
  { id: "ath-marcus-lee", name: "Marcus Lee", handle: "@marcuslee", school: "Texas", sport: "Track", followers: 98_000, totalViews: 1_200_000, statuses: ["athlete"], bio: "Sub-10 sprinter chasing gold and a bigger platform." },
  { id: "ath-ava-thompson", name: "Ava Thompson", handle: "@avathompson", school: "LSU", sport: "Volleyball", followers: 176_000, totalViews: 2_100_000, statuses: ["athlete", "ambassador"], ambassadorRank: 7, bio: "Front-row firepower with a personality fans can't get enough of." },
  { id: "ath-diego-ramirez", name: "Diego Ramirez", handle: "@dramirez", school: "Florida", sport: "Baseball", followers: 121_000, totalViews: 1_500_000, statuses: ["athlete", "ambassador"], ambassadorRank: 5, bio: "Power-hitting shortstop turning every at-bat into content." },
  { id: "ath-hannah-cole", name: "Hannah Cole", handle: "@hannahcole", school: "Oregon", sport: "Swimming", followers: 87_000, totalViews: 990_000, statuses: ["athlete", "ambassador"], ambassadorRank: 8, bio: "Distance swimmer making the pool look like must-see TV." },
  { id: "ath-isaiah-carter", name: "Isaiah Carter", handle: "@icarter", school: "Michigan", sport: "Wrestling", followers: 64_000, totalViews: 720_000, statuses: ["athlete"], bio: "Mat technician with a grind-it-out story fans rally behind." },
]);

/**
 * S1 recap media, mirrored off VideoPress into the media bucket under
 * `video/brand/recap-s1/` in both stages — we serve nothing we do not own.
 * Stored as domain-less paths; event-detail composes the CDN URL per stage
 * (design §6.8), so the same row is correct in dev and prod.
 */
const RECAP_S1 = (slug: string) => `/video/brand/recap-s1/${slug}`;

/**
 * The Top 20 as posted on niltv.com/nilstar, in site order. Bella is the
 * champion and carries the hero video, so she is omitted from the grid below —
 * the site's own recap hides her duplicate card on mobile for the same reason.
 * Each photo is that athlete's audition-reel poster frame; the reels
 * themselves land when entry video reaches the app.
 *
 * Two slugs carry `-amp-` because they were mirrored from the site's
 * HTML-escaped `&amp;` — the bucket keys read that way, so these must match.
 */
const NILSTAR_S1_FINALISTS = [
  ["Simon Lioznyansky", "University of Pennsylvania", "Fencing", "simon-lioznyansky"],
  ["Chihiro Bringman", "Stonehill College", "Swim & Dive", "chihiro-bringman"],
  ["Colin Coffey", "Alma College", "Football", "colin-coffey"],
  ["Jaylin Lott", "Thomas Jefferson University", "Volleyball", "jaylin-lott"],
  ["Eliana Geva", "Temple University", "Fencing", "eliana-geva"],
  ["Drew Collins", "University of Louisville", "Swimming", "drew-collins"],
  ["Keely Eslinger", "Liberty University", "Soccer", "keely-eslinger"],
  ["Zander Vasquez", "UC San Diego", "Fencing", "zander-vasquez"],
  ["Mia Girgis", "UMass Lowell", "Soccer", "mia-girgis"],
  ["Keagan Cunningham", "Texas Christian University", "Football", "keagan-cunningham"],
  ["Grace & Taylor Hasselbeck", "Vanderbilt & Wyoming", "Lacrosse & Football", "grace-amp-taylor-hasselbeck"],
  ["Aleithia Wilson", "Wheeling University", "Volleyball", "aleithia-wilson"],
  ["Jasmine Connor", "American University", "Lacrosse", "jasmine-connor"],
  ["Kayliah Love", "DePaul University", "Track & Field", "kayliah-love"],
  ["Miguel Hall", "Abilene Christian University", "Track & Field", "miguel-hall"],
  ["Kali Boychuk", "Saint Michael's College", "Ice Hockey", "kali-boychuk"],
  ["Charlie Moore", "Colby College", "Ice Hockey", "charlie-moore"],
  ["Anna & Tom Lardner", "Middlebury & Bowdoin", "Tennis & Football", "anna-amp-tom-lardner"],
  ["Taylee Chirrick", "Montana State University", "Basketball", "taylee-chirrick"],
].map(([name, school, sport, slug]) => ({
  name,
  school,
  sport,
  photoPath: RECAP_S1(`${slug}.jpg`),
  // Mirrored audition reels (std renditions off the site) — the grid plays.
  videoPath: RECAP_S1(`${slug}.mp4`),
}));

/**
 * The real NIL TV competition slate: the completed NIL STAR Season 1 recap.
 * Dates come from the site's S1 recap page.
 *
 * The status enum tracks the VOTING window (upcoming → live → ended). S1 sits
 * at `ended` and renders from its `showcase`. The next competition is added
 * here only once its dates are official on the site.
 */
export const fixtureEvents = z.array(EventEntity).parse([
  {
    id: "evt-nilstar-s1",
    type: "vote",
    title: "NIL STAR · Season 1",
    status: "ended",
    // The final voting round: opened Jul 13, ballot locked 11:59 PM ET Jul 19.
    startsAt: "2026-07-13T04:00:00Z",
    endsAt: "2026-07-20T03:59:00Z",
    prize: "$10,000",
    // No partners on the site recap page, so none here.
    partners: [],
    blurb: "Champion: Bella Calvanese",
    // Season arc for the recap's "Road to the Crown" episode rail.
    milestones: [
      { date: "Jul 7", label: "Round One · Nationwide entries open" },
      { date: "Jul 13–19", label: "Round Two · The nationwide fan vote" },
      { date: "Jul 22", label: "Finale · The first NIL STAR is crowned" },
    ],
    showcase: {
      heading: "$10,000 grand prize · Crowned July 2026",
      winner: {
        name: "Bella Calvanese",
        school: "Sacred Heart University",
        sport: "Lacrosse",
        videoPath: RECAP_S1("winner.mp4"),
        // Hero art: the campaign screenshot, not the video frame.
        posterPath: RECAP_S1("bella-hero.png"),
        postUrl: "https://www.instagram.com/p/DbHFwh4MbJz/",
      },
      finalists: NILSTAR_S1_FINALISTS,
    },
  },
]);

/**
 * No app-side entries. S1 renders from its `showcase` (display-only — those
 * finalists are not profile records), so nothing here needs an Entry row.
 *
 * Load-testing and vote-flow rehearsal seed their own event and entries with
 * maintainer tooling.
 */
export const fixtureEntries = z.array(Entry).parse([]);

const clip = (
  id: string,
  title: string,
  channelId: string,
  athleteId: string,
  durationSec: number,
  publishedAt: string,
): z.input<typeof Content> => ({
  id,
  title,
  channelId,
  athleteId,
  provider: "hls",
  playbackUrl: DEV_HLS_URL,
  duration: durationSec,
  transcodeStatus: "published",
  rightsConfirmed: true,
  publishedAt,
  views: 1200 + durationSec * 37,
  likes: 120 + durationSec * 3,
});

/** Demo clip titles/durations (vision.html:482) spread across channels + creators. */
export const fixtureContent = z.array(Content).parse([
  clip("c-audition-camila", "Camila's audition drops", "ch-niltv", "ath-camila-garza", 192, "2026-07-13T12:00:00Z"),
  clip("c-founding-five", "Founding Five: the story", "ch-niltv", "ath-jordan-banks", 340, "2026-07-10T12:00:00Z"),
  clip("c-behind-highlight", "Behind the highlight", "ch-trueblue", "ath-camila-garza", 192, "2026-07-06T12:00:00Z"),
  clip("c-day-in-life", "Day in the life", "ch-trueblue", "ath-jordan-banks", 340, "2026-07-05T12:00:00Z"),
  clip("c-game-winner", "Game winner reaction", "ch-trueblue", "ath-maya-robinson", 68, "2026-07-04T12:00:00Z"),
  clip("c-training-grind", "Training grind", "ch-trueblue", "ath-tyler-brooks", 265, "2026-07-03T12:00:00Z"),
  clip("c-meet-freshman", "Meet the freshman", "ch-niltv", "ath-sofia-nguyen", 170, "2026-07-02T12:00:00Z"),
  clip("c-micd-up", "Postgame mic'd up", "ch-niltv", "ath-marcus-lee", 213, "2026-07-01T12:00:00Z"),
  clip("c-floor-routine", "The comeback floor routine", "ch-niltv", "ath-maya-robinson", 145, "2026-06-30T12:00:00Z"),
  clip("c-pool-day", "Distance day", "ch-trueblue", "ath-hannah-cole", 188, "2026-06-24T12:00:00Z"),
  clip("c-mat-work", "Mat work Monday", "ch-niltv", "ath-isaiah-carter", 224, "2026-06-22T12:00:00Z"),
]);

export const fixtureBrands = [
  "Hellmann's", "ESPN", "H&R Block", "Dick's", "Garmin", "Therabody",
  "ACC Network", "LMNT", "Family Dollar", "Big 12", "Oofos", "Champs Sports",
];

export const fixtureConfig = AppConfig.parse({
  // S1 is the only event, so it is the active one. selectHero renders an
  // ended active event as the recap hero.
  activeEventId: "evt-nilstar-s1",
  flags: { liveSegment: false, ambassadorDirectory: false },
  minAppVersion: "0.1.0",
});

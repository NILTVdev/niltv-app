/**
 * Enrichment (content foundation) — the pure functions that turn what a
 * source said into what we show and how we classify it. Every function here
 * is deterministic over the row's `source` group plus the context it is
 * handed (profiles, policy), so the whole pass can be re-run at any time.
 *
 * Two rules make re-running safe:
 *   1. `source` is never written here. Adapters write it once.
 *   2. A field named in `row.overrides` is never touched. A person set it.
 *
 * Runs at ingest (ingest-social, the archive importer, uploads) and in the
 * library backfill. The LLM classifier (enrich-llm.ts) is an optional second
 * opinion the caller can merge in when rules are not confident.
 */
import { ContentQc, ContentRights, type ContentType, type Sport, TITLE_NEEDS_WRITING } from "@niltv/types";
import type { Item } from "./shape";
import { baseEligibility, cleanDescription, cleanTitle, resolveSyndicationFiles, titleCandidate, titleWords } from "./syndication";

/* ── Text extraction ──────────────────────────────────────────────────────── */

const HANDLE = /(?:^|[^\w.])@([a-z0-9][a-z0-9._]{0,29})/gi;
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

/** Lowercased handles mentioned in a caption, without the @, deduplicated, in order. */
export function extractHandles(text: string | undefined): string[] {
  const out: string[] = [];
  for (const match of (text ?? "").matchAll(HANDLE)) {
    const handle = (match[1] ?? "").toLowerCase().replace(/\.+$/, "");
    if (handle && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/** Lowercased hashtags without the #, deduplicated, in order. */
export function extractHashtags(text: string | undefined): string[] {
  const out: string[] = [];
  for (const match of (text ?? "").matchAll(HASHTAG)) {
    const tag = (match[1] ?? "").toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/* ── Sport ────────────────────────────────────────────────────────────────── */

/** Roster strings ("Women's Soccer", "Track & Field", "XC") → vocabulary. */
const SPORT_ALIASES: Array<[Sport, RegExp]> = [
  ["baseball", /\bbaseball\b/i],
  ["softball", /\bsoftball\b/i],
  ["basketball", /\bbasketball\b|\b[wm]bb\b|\bhoops\b/i],
  ["football", /\bfootball\b/i],
  ["soccer", /\bsoccer\b|\bfutbol\b/i],
  ["lacrosse", /\blacrosse\b|\blax\b/i],
  ["volleyball", /\bvolleyball\b/i],
  ["track-field", /\btrack\b|\bfield\b.*\btrack\b|\bsprint(er|s)?\b|\bhurdle|\bjavelin|\bpole ?vault|\bt&f\b|\btrackandfield/i],
  ["cross-country", /\bcross[- ]?country\b|\bxc\b/i],
  ["swim-dive", /\bswim|\bdiv(e|ing)\b/i],
  ["tennis", /\btennis\b/i],
  ["golf", /\bgolf\b/i],
  ["fencing", /\bfencing\b|\bfencer\b/i],
  ["cheer-dance", /\bcheer|\bdance\b/i],
  ["ice-hockey", /\bice hockey\b|\bhockey\b(?![- ]?field)/i],
  ["field-hockey", /\bfield hockey\b/i],
  ["rowing", /\browing\b|\bcrew\b/i],
  ["gymnastics", /\bgymnast/i],
  ["wrestling", /\bwrestl/i],
  ["ultimate-frisbee", /\bultimate\b|\bfrisbee\b/i],
  ["esports", /\besports?\b|\bgaming\b/i],
];

/** A roster sport string → vocabulary value, or undefined when it matches nothing. */
export function normalizeSport(value: string | undefined): Sport | undefined {
  if (!value) return undefined;
  for (const [sport, re] of SPORT_ALIASES) if (re.test(value)) return sport;
  return undefined;
}

/** Hashtags → sport. Only tags that name the sport count; team hashtags carry too much noise. */
const SPORT_TAGS: Array<[Sport, RegExp]> = [
  ["baseball", /^(baseball|collegebaseball|ncaabaseball|d1baseball)$/],
  ["softball", /^(softball|collegesoftball|ncaasoftball)$/],
  ["basketball", /^(basketball|collegebasketball|ncaabasketball|wbb|mbb|hoops|ncaawbb|ncaambb)$/],
  ["football", /^(football|collegefootball|cfb|ncaafootball)$/],
  ["soccer", /^(soccer|collegesoccer|ncaasoccer|soccergirl|soccerboy|womenssoccer|menssoccer)$/],
  ["lacrosse", /^(lacrosse|lax|collegelacrosse|ncaalax|ncaalacrosse|womenslacrosse|menslacrosse)$/],
  ["volleyball", /^(volleyball|collegevolleyball|ncaavolleyball)$/],
  ["track-field", /^(track|trackandfield|tracknation|sprinter|hurdles|d1track|ncaatrack|running)$/],
  ["cross-country", /^(crosscountry|xc|xcrunning|d1xc)$/],
  ["swim-dive", /^(swim|swimming|swimmer|diving|collegeswimming)$/],
  ["tennis", /^(tennis|collegetennis|ncaatennis|\w+tennis)$/],
  ["golf", /^(golf|collegegolf|ncaagolf)$/],
  ["fencing", /^(fencing|fencer|ncaafencing)$/],
  ["cheer-dance", /^(cheer|cheerleading|dance|danceteam)$/],
  ["ice-hockey", /^(hockey|icehockey|collegehockey)$/],
  ["field-hockey", /^(fieldhockey)$/],
  ["rowing", /^(rowing|crew)$/],
  ["gymnastics", /^(gymnastics|gymnast)$/],
  ["wrestling", /^(wrestling|wrestler)$/],
];

export interface SportVerdict {
  sport?: Sport;
  /** 0.8 = sport hashtag, 0.5 = caption words, 0.4 = the credited athlete's roster sport, 0 = nothing */
  confidence: number;
  via: "hashtag" | "caption" | "athlete" | "none";
}

/**
 * `sport` means the sport on screen, which is what the taxonomy labels and
 * what a viewer filters by. A hashtag or the caption says that directly; the
 * credited athlete's roster sport is only a hint (a football player's
 * meal-prep vlog shows no sport at all), so it ranks last and low. The
 * athlete's own sport is always available from the profile for facets that
 * want it.
 */
export function inferSport(caption: string | undefined, athleteSport?: string): SportVerdict {
  for (const tag of extractHashtags(caption)) {
    for (const [sport, re] of SPORT_TAGS) if (re.test(tag)) return { sport, confidence: 0.8, via: "hashtag" };
  }
  const words = (caption ?? "").replace(HASHTAG, " ");
  const fromWords = normalizeSport(words);
  if (fromWords) return { sport: fromWords, confidence: 0.5, via: "caption" };
  const fromAthlete = normalizeSport(athleteSport);
  if (fromAthlete) return { sport: fromAthlete, confidence: 0.4, via: "athlete" };
  return { confidence: 0, via: "none" };
}

/* ── Content type ─────────────────────────────────────────────────────────── */

/** Signals per type: [hashtag pattern, caption pattern]. Hashtags outweigh words. */
const TYPE_SIGNALS: Array<[ContentType, RegExp, RegExp]> = [
  ["gear-haul", /^(gearhaul|haul|unboxing|gear)$/, /\b(gear haul|unboxing|new gear|shoutout to .* for the)\b/i],
  ["what-i-eat", /^(whatieat|whatieatinaday|mealprep|fuel|foodie|cooking)$/, /\bwhat i eat\b|\bmeal prep\b|\bbest tasting meal\b/i],
  ["ditl-vlog", /^(ditl|dayinthelife|dayinmylife|vlog|dailyvlog|dayinthelifevlog)$/, /\bday in (my|the) life\b|\bvlog\b|\bday of my life\b/i],
  ["training-workout", /^(training|workout|grind|lift|liftingweights|gym|practice|drills|conditioning)$/, /\b(workout|training|practice|lift(ing)?|grind|drills|conditioning|reps|stacking good days)\b/i],
  ["recovery", /^(recovery|recoveryday|icebath|mobility|rehab|physicaltherapy)$/, /\b(recovery|ice bath|mobility|rehab|physical therapy)\b/i],
  ["game-day", /^(gameday|matchday|raceday|meetday)$/, /\b(game ?day|match ?day|race ?day|meet ?day)\b/i],
  ["media-day", /^(mediaday|photoshoot|mediaday\d*)$/, /\bmedia day\b|\bphoto ?shoot\b/i],
  ["grwm-fitcheck", /^(grwm|fitcheck|ootd|outfit|getreadywithme)$/, /\bget ready with me\b|\bfit check\b|\boutfit\b/i],
  ["hype-announcement", /^(announcement|welcome|committed|signed|newmember|hype|letsgo|comingsoon|dropping)$/, /\b(welcome|announc|excited to|proud to|committed|signing|coming soon|stay tuned|dropping)\b/i],
  ["celebration-highlight", /^(highlights?|champions?|winner|victory|clutch|goal|homerun|touchdown|pr|personalrecord)$/, /\b(highlight|champion|we won|victory|clutch|personal record|new pr|game winner)\b/i],
  ["interview-podcast", /^(podcast|interview|episode|conversation|qanda)$/, /\b(podcast|interview|episode \d+|sit(s)? down with)\b/i],
  ["team-qa", /^(qanda|q&a|teamqa|askme|questionoftheday)$/, /\bq ?& ?a\b|\bquestion of the day\b|\bask(ing)? (the|my) (team|teammates)\b/i],
  ["singing-audition", /^(singing|audition|cover|nilstar|rapstar|karaoke|acoustic)$/, /\b(singing|audition|cover of|karaoke|acoustic|sing)\b/i],
  ["skit-humor", /^(skit|comedy|funny|humor|pov|relatable|meme)$/, /\bpov\b|\bskit\b|\bwhen (your|the) (coach|teammate)\b|\brelatable\b|\biykyk\b/i],
  ["travel-road", /^(roadtrip|travel|awaygame|ontheroad|busride|flight)$/, /\b(road trip|away game|on the road|bus ride|travel day)\b/i],
  ["micd-up", /^(micdup|micd|wired)$/, /\bmic'?d up\b|\bmicd up\b/i],
  ["bts", /^(bts|behindthescenes|onset)$/, /\bbehind the scenes\b|\bon set\b/i],
  ["brand-sponsored", /^(ad|sponsored|partner|ambassador|brandpartner|collab|paidpartnership)$/, /\bpaid partnership\b|\b#ad\b|\bsponsored\b|\buse code\b|\bpromo code\b|\bthank(s| you) to .* for\b/i],
];

export interface TypeVerdict {
  contentType?: ContentType;
  secondary: ContentType[];
  /** 0.9 hashtag hit, 0.6 caption hit, 0 nothing; more hits do not raise it */
  confidence: number;
}

export function inferContentType(caption: string | undefined): TypeVerdict {
  const tags = extractHashtags(caption);
  const words = (caption ?? "").replace(HASHTAG, " ");
  const scores = new Map<ContentType, number>();
  for (const [type, tagRe, wordRe] of TYPE_SIGNALS) {
    let score = 0;
    if (tags.some((tag) => tagRe.test(tag))) score += 0.9;
    if (wordRe.test(words)) score += 0.6;
    if (score > 0) scores.set(type, score);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { secondary: [], confidence: 0 };
  const [top, topScore] = ranked[0]!;
  return {
    contentType: top,
    secondary: ranked.slice(1, 3).map(([type]) => type),
    confidence: topScore >= 0.9 ? 0.9 : 0.6,
  };
}

/* ── Editorial ────────────────────────────────────────────────────────────── */

export interface Editorial {
  title: string;
  description: string;
  summary: string;
  keywords: string[];
}

/** Title, description, summary and keywords from the raw caption. Pure; overridable. */
export function deriveEditorial(caption: string | undefined, fallbackTitle: string): Editorial {
  const title = cleanTitle(caption ?? "", fallbackTitle);
  const description = cleanDescription(caption ?? "");
  const summary = description.length > 160 ? `${description.slice(0, 157).replace(/\s+\S*$/, "")}…` : description;
  return { title, description, summary: summary || title, keywords: extractHashtags(caption).slice(0, 10) };
}

/* ── Title ladder ─────────────────────────────────────────────────────────── */

/**
 * Where a derived title came from. `caption` is the creator's own line;
 * `staff` is a person's title (an override). Every other source is a rule's
 * best guess, and the clip waits in the staff queue until someone writes one.
 */
export type TitleSource = "caption" | "athlete" | "caption-word" | "creator" | "school-sport" | "channel" | "staff";

/** Title sources that a rule produced, not a person or the caption. */
export const RULE_TITLE_SOURCES: ReadonlySet<string> = new Set(["athlete", "caption-word", "creator", "school-sport", "channel"]);

/** The QC reason that puts a rule-made title in the staff queue (defined in the contract). */
export { TITLE_NEEDS_WRITING };

/**
 * The generic fallback earlier versions of the pass wrote. It claims a clip
 * is new whatever its age, so it is never produced now and never read back
 * as if it were a caption.
 */
export const LEGACY_FALLBACK_TITLE = /^new on\b/i;

/** Creator shorthand that reads as a title once spelled out. */
const SHORTHAND: Readonly<Record<string, string>> = {
  bts: "Behind the Scenes",
  diml: "Day in My Life",
  ditl: "Day in the Life",
  grwm: "Get Ready With Me",
  ootd: "Outfit of the Day",
  qotd: "Question of the Day",
  wieiad: "What I Eat in a Day",
};

/** Sports as they read in a title ("Duke Swim & Dive"). Classifier buckets have no name. */
const SPORT_TITLE: Readonly<Partial<Record<Sport, string>>> = {
  baseball: "Baseball",
  basketball: "Basketball",
  "cheer-dance": "Cheer & Dance",
  "cross-country": "Cross Country",
  esports: "Esports",
  fencing: "Fencing",
  "field-hockey": "Field Hockey",
  football: "Football",
  golf: "Golf",
  gymnastics: "Gymnastics",
  "ice-hockey": "Hockey",
  lacrosse: "Lacrosse",
  rowing: "Rowing",
  soccer: "Soccer",
  softball: "Softball",
  "swim-dive": "Swim & Dive",
  tennis: "Tennis",
  "track-field": "Track & Field",
  "ultimate-frisbee": "Ultimate",
  volleyball: "Volleyball",
  wrestling: "Wrestling",
};

/** Content types that name a recognisable format. Skits, hype and sponsored posts say nothing on a card. */
const TYPE_TITLE: Readonly<Partial<Record<ContentType, string>>> = {
  bts: "Behind the Scenes",
  "celebration-highlight": "Highlights",
  "ditl-vlog": "Day in the Life",
  "game-day": "Game Day",
  "gear-haul": "Gear Haul",
  "grwm-fitcheck": "Fit Check",
  "interview-podcast": "Interview",
  "media-day": "Media Day",
  "micd-up": "Mic'd Up",
  recovery: "Recovery",
  "singing-audition": "Audition",
  "team-qa": "Q&A",
  "training-workout": "Training",
  "travel-road": "On the Road",
  "what-i-eat": "What I Eat",
};

/**
 * A caption whose first line is one real word ("MVP.", "gainz", "DITL 🧡"):
 * that word, with creator shorthand spelled out. Undefined when the line has
 * more words, or the word has fewer than two letters ("3…2…1…").
 */
export function captionWord(caption: string | undefined): string | undefined {
  const words = titleWords(titleCandidate(caption ?? ""));
  if (words.length !== 1) return undefined;
  const word = (words[0] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if ((word.match(/\p{L}/gu) ?? []).length < 2 || word.length > 40) return undefined;
  return SHORTHAND[word.toLowerCase()] ?? word;
}

export interface TitleInputs {
  /** the source caption (or the row's description when the source has none) */
  caption?: string;
  /** the credited athlete, only when the profile is complete */
  athleteName?: string;
  athleteSchool?: string;
  /** the post's author when it is a person: not one of our accounts, not a team handle */
  creatorHandle?: string;
  school?: string;
  sport?: string;
  contentType?: string;
  channelName: string;
  /** the campus channel's school ("Duke" for TrueBlue TV); absent on network channels */
  accountSchool?: string;
}

/**
 * The title for a clip, from the most specific thing we know:
 *   1. the caption's first line when two or more words survive cleanup
 *   2. the credited athlete: "Jordan Rivera, Example State: Example State TV"
 *   3. a one-word caption: "MVP", "Day in the Life" (from "DITL")
 *   4. the creator's handle, with school and sport: "@jordan.rivera, Duke Soccer"
 *   5. school, sport and format: "Duke Soccer Media Day"
 *   6. the channel's people: "Duke’s Athletes", or "NIL TV Athletes"
 * Every rung but the first is flagged for a person to write a real title.
 */
export function titleFor(inputs: TitleInputs): { title: string; source: TitleSource } {
  const line = titleCandidate(inputs.caption ?? "");
  if (titleWords(line).length >= 2) return { title: line, source: "caption" };
  if (inputs.athleteName) {
    const credit = inputs.athleteSchool ? `${inputs.athleteName}, ${inputs.athleteSchool}` : inputs.athleteName;
    return { title: `${credit}: ${inputs.channelName}`, source: "athlete" };
  }
  const word = captionWord(inputs.caption);
  if (word) return { title: word, source: "caption-word" };
  const sport = inputs.sport ? SPORT_TITLE[inputs.sport as Sport] : undefined;
  const format = inputs.contentType ? TYPE_TITLE[inputs.contentType as ContentType] : undefined;
  if (inputs.creatorHandle) {
    const label = [inputs.school, sport].filter(Boolean).join(" ");
    return { title: label ? `@${inputs.creatorHandle}, ${label}` : `@${inputs.creatorHandle}`, source: "creator" };
  }
  if (inputs.school && (sport || format)) return { title: [inputs.school, sport, format].filter(Boolean).join(" "), source: "school-sport" };
  return { title: inputs.accountSchool ? `${inputs.accountSchool}’s Athletes` : `${inputs.channelName} Athletes`, source: "channel" };
}

/* ── People ───────────────────────────────────────────────────────────────── */

export interface AthleteResolution {
  /** the primary credit, when a real profile matched */
  athleteId?: string;
  featuredAthleteIds: string[];
  unresolvedHandles: string[];
}

/**
 * Handles that are not people and must never reach the review queue: team
 * and programme accounts, coaches, athletics departments. A policy list
 * (ctx.ignoreHandles) extends this; the pattern catches the common shapes
 * ("dukebase", "dukewlax", "coachsmith12", "unc_athletics").
 */
const NON_PERSON_HANDLE =
  /coach|athletics|official|university|college|media|network|brands?$|gear|apparel|nutrition|sports$|_tv$|tv$|^(duke|unc|ncsu|nd|wake|vandy|vu|msu|tamu|baylor|cuse|syracuse|bu|aggie|tarheel|bluedevil|wolfpack|irish|commodore|bulldog|bear|orange|deacon)s?[._-]?(base|softball|w?lax|m?lax|lacrosse|w?bb|m?bb|hoops|fb|football|w?soc|m?soc|soccer|track|xc|w?ten|m?ten|tennis|w?golf|m?golf|vb|volleyball|swim|dive|fencing|rowing|crew|wrestling|gym|cheer|dance|hockey|fh)[._-]?(ball|team|official)?$/i;

export const isPersonHandle = (handle: string, ignore?: ReadonlySet<string>): boolean =>
  !(ignore?.has(handle) ?? false) && !NON_PERSON_HANDLE.test(handle);

/**
 * Author handle first, then caption mentions, matched against real profiles
 * by current or previous handle. Our own account handles are never people,
 * and neither are team, programme or coach handles (see isPersonHandle).
 */
export function resolveAthletes(
  source: { authorHandle?: string; caption?: string },
  profilesByHandle: ReadonlyMap<string, Item>,
  ownAccounts: ReadonlySet<string>,
  ignoreHandles?: ReadonlySet<string>,
): AthleteResolution {
  const candidates: string[] = [];
  if (source.authorHandle) candidates.push(source.authorHandle.toLowerCase());
  for (const handle of extractHandles(source.caption)) if (!candidates.includes(handle)) candidates.push(handle);
  const featured: string[] = [];
  const unresolved: string[] = [];
  for (const handle of candidates) {
    if (ownAccounts.has(handle)) continue;
    // A known profile is a person whatever its handle looks like; only
    // unknown handles are screened before they reach the queue.
    if (!profilesByHandle.has(handle) && !isPersonHandle(handle, ignoreHandles)) continue;
    const profile = profilesByHandle.get(handle);
    if (profile && typeof profile["id"] === "string") {
      if (!featured.includes(profile["id"])) featured.push(profile["id"]);
    } else {
      unresolved.push(handle);
    }
  }
  return { ...(featured[0] ? { athleteId: featured[0] } : {}), featuredAthleteIds: featured, unresolvedHandles: unresolved };
}

/**
 * A profile the app may show as the creator credit: a real name (not a
 * stylized "J a y"), a school and a sport. The roster sync creates rows with
 * whatever the dashboard has, and an incomplete row must not replace the
 * channel credit on a card until it is finished — the person is still
 * recorded in featuredAthleteIds, and the gap is a queue reason.
 */
export function isCompleteProfile(profile: Item | undefined): boolean {
  if (!profile) return false;
  const name = typeof profile["name"] === "string" ? profile["name"].trim() : "";
  const spacedLetters = /^(\S\s)+\S$/.test(name);
  return name.length >= 3 && !spacedLetters && typeof profile["school"] === "string" && profile["school"].length > 0 && typeof profile["sport"] === "string" && profile["sport"].length > 0;
}

/** Index profiles by every handle they have carried, lowercased. */
export function profilesByHandle(profiles: readonly Item[]): Map<string, Item> {
  const map = new Map<string, Item>();
  for (const profile of profiles) {
    const handle = typeof profile["handle"] === "string" ? profile["handle"].toLowerCase().replace(/^@/, "") : "";
    if (handle) map.set(handle, profile);
    if (Array.isArray(profile["previousHandles"])) {
      for (const prev of profile["previousHandles"] as unknown[]) {
        if (typeof prev === "string" && prev && !map.has(prev.toLowerCase())) map.set(prev.toLowerCase(), profile);
      }
    }
  }
  return map;
}

/* ── Rights ───────────────────────────────────────────────────────────────── */

/**
 * School marks count as cleared unless the school is on `blockedSchools`, the
 * opt-out list on POLICY#schools. A row with no school association has no
 * marks question at all.
 */
export interface SchoolPolicy {
  /** display names of schools whose marks are blocked from syndication */
  blockedSchools: string[];
}

/**
 * Rights defaults by origin:
 * - instagram-owned, archive, upload, youtube: status `owned`, music `none`.
 * - instagram-collab: status `licensed`, music `none`.
 * - anything else: no defaults.
 */
export function rightsDefaults(kind: string | undefined): Partial<ContentRights> {
  switch (kind) {
    case "instagram-owned":
    case "archive":
    case "upload":
    case "youtube":
      return { status: "owned", music: "none" };
    case "instagram-collab":
      return { status: "licensed", music: "none" };
    default:
      return {};
  }
}

export const schoolCleared = (school: string | undefined, policy: SchoolPolicy): boolean =>
  !school || !policy.blockedSchools.some((s) => s.toLowerCase() === school.toLowerCase());

/* ── The pass ─────────────────────────────────────────────────────────────── */

export interface EnrichContext {
  profilesByHandle: ReadonlyMap<string, Item>;
  /** our account handles (niltv, truebluetv, …) — never resolved as people */
  ownAccounts: ReadonlySet<string>;
  /** staff-maintained handles that are not people (POLICY#handles.ignore) */
  ignoreHandles?: ReadonlySet<string>;
  /** display name of the row's channel, for the title fallback */
  channelName: string;
  /** the account's school when the channel is a campus node ("Duke" for truebluetv) */
  accountSchool?: string;
  schoolPolicy: SchoolPolicy;
  /** the series row, for inherited rights and the partner rule */
  series?: Item;
  now?: Date;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Recompute every derived field from `source`, honouring overrides, and stamp
 * the per-surface QC. Returns a new row; the input is not mutated. Fields the
 * pass does not own (files, paths, publish state, GSI keys) pass through.
 */
export function applyEnrichment(row: Item, ctx: EnrichContext): Item {
  const source = isRecord(row["source"]) ? row["source"] : {};
  const overrides = new Set(Array.isArray(row["overrides"]) ? (row["overrides"] as string[]) : []);
  const owned = (field: string) => !overrides.has(field);
  const next: Item = { ...row };

  // People — resolve first; sport and school inherit from the credited athlete.
  const people = resolveAthletes(
    { authorHandle: str(source["authorHandle"]), caption: str(source["caption"]) },
    ctx.profilesByHandle,
    ctx.ownAccounts,
    ctx.ignoreHandles,
  );
  const currentAthlete = str(row["athleteId"]);
  const leadProfile = people.athleteId ? findProfile(ctx, people.athleteId) : undefined;
  const creditReady = isCompleteProfile(leadProfile);
  const pseudoId = str(source["account"]) ? `p-${str(source["account"])}` : undefined;
  if (owned("athleteId")) {
    if (people.athleteId && creditReady) next["athleteId"] = people.athleteId;
    // A credit that resolved to an incomplete profile (or none) falls back to
    // the channel pseudo-profile — including a real id stamped by an earlier
    // run, so a profile that loses its school never leaves a bare name on a card.
    else if (currentAthlete && (currentAthlete.startsWith("p-") || !pseudoId)) next["athleteId"] = currentAthlete;
    else if (pseudoId) next["athleteId"] = pseudoId;
  }
  if (owned("featuredAthleteIds")) next["featuredAthleteIds"] = people.featuredAthleteIds;
  next["unresolvedHandles"] = people.unresolvedHandles;
  next["incompleteProfile"] = people.athleteId && !creditReady ? people.athleteId : undefined;
  const lead = creditReady ? leadProfile : undefined;

  // Classification first: the title ladder reads the school, sport and type.
  const leadName = str(lead?.["name"]);
  const leadSchool = str(lead?.["school"]);
  const school = leadSchool ?? ctx.accountSchool;
  if (owned("school") && school) next["school"] = school;
  const sport = inferSport(str(source["caption"]), str(lead?.["sport"]));
  if (owned("sport") && sport.sport) next["sport"] = sport.sport;
  const type = inferContentType(str(source["caption"]));
  if (owned("contentType")) {
    if (type.contentType) next["contentType"] = type.contentType;
    next["contentTypes"] = type.secondary;
    next["contentTypeConfidence"] = type.confidence;
  }

  // Editorial. A row with no source caption falls back to its description,
  // then its title, but never to an old generic "New on …" title, which
  // would otherwise pass for a caption and stick forever.
  const previousTitle = str(row["title"]);
  const captionText = str(source["caption"]) ?? str(row["description"]) ?? (previousTitle && !LEGACY_FALLBACK_TITLE.test(previousTitle) ? previousTitle : undefined);
  const author = str(source["authorHandle"])?.toLowerCase();
  const ladder = titleFor({
    caption: captionText,
    athleteName: leadName,
    athleteSchool: leadSchool,
    creatorHandle: author && !ctx.ownAccounts.has(author) && isPersonHandle(author, ctx.ignoreHandles) ? author : undefined,
    school: str(next["school"]),
    sport: str(next["sport"]),
    contentType: str(next["contentType"]),
    channelName: ctx.channelName,
    accountSchool: ctx.accountSchool,
  });
  const editorial = deriveEditorial(captionText, ladder.title);
  if (owned("title")) {
    next["title"] = ladder.title;
    next["titleSource"] = ladder.source;
  } else {
    next["titleSource"] = "staff";
  }
  if (owned("description")) next["description"] = editorial.description;
  if (owned("summary")) next["summary"] = editorial.summary;
  if (owned("keywords")) next["keywords"] = editorial.keywords;

  // Rights: status, music and marks are rules over the origin and the school
  // policy, recomputed on every pass like any other derived field, unless a
  // person decided (admin and import-overrides record `rights.<field>`).
  // Territory, expiry and credit line are only ever set by people and are kept.
  const rights: Record<string, unknown> = isRecord(row["rights"]) ? { ...row["rights"] } : {};
  const defaults = rightsDefaults(str(source["kind"]));
  for (const [key, value] of Object.entries(defaults)) if (owned(`rights.${key}`)) rights[key] = value;
  if (owned("rights.logoCleared")) rights["logoCleared"] = schoolCleared(str(next["school"]), ctx.schoolPolicy);
  next["rights"] = ContentRights.parse(rights);

  next["qc"] = qcFor(next, ctx);
  return next;
}

function findProfile(ctx: EnrichContext, id: string): Item | undefined {
  for (const profile of ctx.profilesByHandle.values()) if (profile["id"] === id) return profile;
  return undefined;
}

/* ── QC ───────────────────────────────────────────────────────────────────── */

/** Per-surface verdicts. The app and site keep today's rule; partners use the syndication rule; reasons feed the queue. */
export function qcFor(row: Item, ctx: Pick<EnrichContext, "series" | "now">): ContentQc {
  const now = ctx.now ?? new Date();
  const reasons: string[] = [];
  const published = row["transcodeStatus"] === "published" && typeof row["publishedAt"] === "string";
  const hasFile = Boolean(resolveSyndicationFiles(row)) || typeof row["playbackPath"] === "string" || typeof row["playbackUrl"] === "string";
  // A card with no poster renders as a blank tile on every surface, so a
  // missing one is a hold, not a cosmetic note.
  const hasPoster = typeof row["thumbPath"] === "string" || typeof row["thumbUrl"] === "string";
  const app: ContentQc["app"] = published && hasFile && hasPoster ? "ready" : "needs-review";
  if (!published) reasons.push("not published");
  if (!hasFile) reasons.push("no playable file");
  if (!hasPoster) reasons.push("no poster");

  const titleWordCount = String(row["title"] ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const site: ContentQc["site"] = app === "ready" && titleWordCount >= 2 ? "ready" : app === "ready" ? "needs-tagging" : app;
  if (titleWordCount < 2) reasons.push("title under two words");
  // A title a rule made up (from a handle, the channel, one word of caption)
  // waits for a person until someone writes one; a staff title is an override.
  const overrides = Array.isArray(row["overrides"]) ? (row["overrides"] as string[]) : [];
  if (typeof row["titleSource"] === "string" && RULE_TITLE_SOURCES.has(row["titleSource"]) && !overrides.includes("title")) {
    reasons.push(TITLE_NEEDS_WRITING);
  }

  const tagging: string[] = [];
  if (typeof row["incompleteProfile"] === "string") tagging.push("athlete profile incomplete");
  if (!row["sport"]) tagging.push("sport unknown");
  if (!row["contentType"]) tagging.push("content type unknown");
  if (Array.isArray(row["unresolvedHandles"]) && (row["unresolvedHandles"] as string[]).length > 0) tagging.push("unresolved handles");
  const base = baseEligibility(row, ctx.series, now);
  const rightsReasons = base.reasons.filter((r) => /rights|music|marks|expired|available/.test(r));
  let partners: ContentQc["partners"] = "ready";
  if (!base.eligible) partners = rightsReasons.length > 0 ? "needs-rights" : "needs-review";
  if (partners === "ready" && tagging.length > 0) partners = "needs-tagging";
  reasons.push(...base.reasons.filter((r) => r !== "not published"), ...tagging);

  const youtube: ContentQc["youtube"] = row["assetType"] === "episode" ? (hasFile ? "ready" : "needs-review") : undefined;
  return ContentQc.parse({
    app,
    site,
    partners,
    ...(youtube ? { youtube } : {}),
    reasons: [...new Set(reasons)],
    at: now.toISOString(),
  });
}

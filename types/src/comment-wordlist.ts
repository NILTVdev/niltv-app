/**
 * What the comment filter (comment-filter.ts) adds on top of the `obscenity`
 * library. obscenity's English dataset supplies the profanity, slur and sexual
 * terms (with leetspeak, repeated-letter and Scunthorpe handling), so this
 * file no longer lists those. It holds only the two things the library lacks:
 *
 *   MILD_WORDS     dataset words that are ordinary swearing rather than slurs
 *                  or sexual content. Allowed for adults, held for staff
 *                  review when the author is a minor. Every OTHER word the
 *                  dataset knows is rejected outright. Values are the
 *                  dataset's `originalWord`, so an unknown name here is
 *                  harmless (and comment-filter.test.ts checks they exist).
 *   THREAT_PHRASES threats and self-harm baiting, matched as phrases.
 */
export const MILD_WORDS: ReadonlySet<string> = new Set([
  "ass",
  "arse",
  "bastard",
  "bitch",
  "boob",
  "cock",
  "dick",
  "fuck",
  "piss",
  "prick",
  "sex",
  "shit",
  "tit",
  "turd",
]);

export const THREAT_PHRASES: readonly string[] = [
  "kill yourself",
  "kill urself",
  "kys",
  "go die",
  "hope you die",
  "i will kill you",
  "ill kill you",
  "i will find you",
  "send nudes",
  "dick pic",
];

/** "{verb} {target}" is a threat; the filter builds its pattern from these. */
export const THREAT_VERBS: readonly string[] = ["kill", "murder", "shoot", "stab", "hurt"];
export const THREAT_TARGETS: readonly string[] = ["you", "u", "yourself", "urself", "him", "her", "them"];

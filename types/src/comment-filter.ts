/**
 * Objectionable-content filter for comments (App Store guideline 1.2).
 * Pure and synchronous. Imported as `@niltv/types/comment-filter`, a separate
 * entry point so the contract itself stays free of the obscenity dependency.
 * The backend runs it on every post and edit (the authority); the app runs the
 * same code in the composer so explicit text can't even be sent.
 *
 * Verdicts:
 *   reject  the comment is refused outright (slurs, threats, sexual content).
 *   hold    stored as `pending`, hidden from everyone but its author until
 *           staff approve it: contact details and links for everyone, and
 *           mild profanity when the author is a minor.
 *   allow   published.
 *
 * This is a baseline keyword filter, not a complete defence. Reports,
 * blocking and the staff queue are the real safety net.
 */
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
import { MILD_WORDS, THREAT_PHRASES, THREAT_TARGETS, THREAT_VERBS } from "./comment-wordlist";

export type FilterVerdict = "allow" | "hold" | "reject";

export interface FilterResult {
  verdict: FilterVerdict;
  /** internal only: never sent to the client (it would tell people which rule to dodge) */
  reason?: "slur_or_sexual" | "threat" | "contact_or_link" | "profanity_minor";
}

/** Contact details and links: an easy way to pull a minor off-platform. */
const CONTACT_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(com|net|org|io|co|me|gg|ly|tv|app|xyz|link)\b/i,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /(?:\+?\d[\s().-]*){10,}/, // phone-number-like digit run
  /(^|\s)@[a-z0-9_.]{2,}/i, // @handle
  /\b(snap(chat)?|insta(gram)?|ig|kik|whatsapp|telegram|discord|tiktok)\b\s*[:@-]?\s*\S{3,}/i,
];

/** Any run of a repeated character becomes one, so "kiiill" and "kill" compare equal. Used on both sides of phrase matching. */
const squeeze = (text: string): string => text.replace(/(.)\1+/gs, "$1");

const THREAT_PATTERN = new RegExp(
  ` (${THREAT_VERBS.map(squeeze).join("|")}) (${THREAT_TARGETS.map(squeeze).join("|")}) `,
);
const THREAT_PHRASES_SQUEEZED = THREAT_PHRASES.map((p) => ` ${squeeze(p)} `);

/**
 * Built once per Lambda container. The English dataset comes with its own
 * whitelist ("assess", "class", "Scunthorpe"…) and the recommended
 * transformers (leetspeak, confusable characters, repeated letters).
 */
const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

/** "n i g g e r" / "f.u.c.k" → "nigger" / "fuck": join runs of single letters split by separators. */
function joinSpelledOut(text: string): string {
  return text.replace(/\b(?:[a-z][\s.\-_*]+){2,}[a-z]\b/gi, (run) => run.replace(/[\s.\-_*]+/g, ""));
}

/** "fuuuuck" → "fuck": runs of three or more of the same character shrink to one. Real double letters stay. */
const collapseLongRuns = (text: string): string => text.replace(/(.)\1{2,}/gs, "$1");

/** Lowercase letters and spaces only, for phrase matching. */
function phraseForm(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()} `;
}

/** The dataset words found in the text, by their canonical spelling. */
function matchedWords(text: string): Set<string> {
  const found = new Set<string>();
  const joined = joinSpelledOut(text);
  for (const view of [text, joined, collapseLongRuns(joined)]) {
    for (const match of matcher.getAllMatches(view)) {
      const word = englishDataset.getPayloadWithPhraseMetadata(match).phraseMetadata?.originalWord;
      if (word) found.add(word);
    }
  }
  return found;
}

export function screenComment(body: string, opts: { minor: boolean }): FilterResult {
  const words = matchedWords(body);
  // Anything the dataset knows that is not plain swearing: slurs, sexual terms.
  for (const word of words) {
    if (!MILD_WORDS.has(word)) return { verdict: "reject", reason: "slur_or_sexual" };
  }

  const phrased = squeeze(phraseForm(joinSpelledOut(body)));
  if (THREAT_PHRASES_SQUEEZED.some((p) => phrased.includes(p))) {
    return { verdict: "reject", reason: "threat" };
  }
  if (THREAT_PATTERN.test(phrased)) {
    return { verdict: "reject", reason: "threat" };
  }

  // Contact/link patterns run on the raw text (digits and @ matter there).
  if (CONTACT_PATTERNS.some((re) => re.test(body))) return { verdict: "hold", reason: "contact_or_link" };

  if (opts.minor && words.size > 0) return { verdict: "hold", reason: "profanity_minor" };
  return { verdict: "allow" };
}

export { MILD_WORDS, THREAT_PHRASES, THREAT_TARGETS, THREAT_VERBS } from "./comment-wordlist";

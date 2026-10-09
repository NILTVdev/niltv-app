/**
 * Test inputs are derived at run time from the obscenity dataset and from
 * comment-wordlist.ts, so this file contains no offensive text of its own.
 */
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
import { describe, expect, it } from "vitest";
import { MILD_WORDS, THREAT_PHRASES, THREAT_TARGETS, THREAT_VERBS, screenComment } from "@niltv/types/comment-filter";

const adult = { minor: false };
const minor = { minor: true };

/** Every canonical word in the dataset. */
function datasetWords(): string[] {
  const words = new Set<string>();
  for (const term of englishDataset.build().blacklistedTerms) {
    const word = englishDataset.getPayloadWithPhraseMetadata({
      termId: term.id,
      startIndex: 0,
      endIndex: 0,
      matchLength: 0,
    }).phraseMetadata?.originalWord;
    if (word) words.add(word);
  }
  return [...words];
}

/** Single-token words long enough for the disguise transforms to be meaningful. */
const singleWord = (w: string) => /^[a-z]{4,}$/.test(w);
const libraryMatcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const candidates = datasetWords().filter((w) => !MILD_WORDS.has(w) && singleWord(w));
/** Words the library recognises in their own plain spelling; a handful in its dataset do not. */
const severe = candidates.filter((w) => libraryMatcher.hasMatch(w));
const mild = [...MILD_WORDS];

const LEET: Record<string, string> = { a: "4", e: "3", i: "1", o: "0", s: "5" };
const leet = (w: string) => [...w].map((c) => LEET[c] ?? c).join("");
const spaced = (w: string) => [...w].join(" ");
const dotted = (w: string) => [...w].join(".");
/** One letter stretched, the way people actually disguise a word ("fuuuuck"). */
const stretched = (w: string) => w[0] + w[1]!.repeat(4) + w.slice(2);

describe("screenComment", () => {
  it("allows ordinary comments, including words that contain short bad words", () => {
    for (const text of [
      "Great game! Go Blue Devils",
      "What a class act",
      "I assess this was a clean assist",
      "Scunthorpe and Essex are towns",
      "Hello from Dallas, that was a hell of a shot",
      "Cockburn and Dickens",
    ]) {
      expect(screenComment(text, minor).verdict, text).toBe("allow");
    }
  });

  it("has a non-trivial dataset to test against, and the library misses almost nothing of its own", () => {
    expect(severe.length).toBeGreaterThan(30);
    expect(mild.length).toBeGreaterThan(5);
    // Library quirk: a few dataset words do not match their own plain spelling.
    // This caps it so an upgrade that makes it worse is noticed.
    expect(candidates.length - severe.length).toBeLessThanOrEqual(3);
  });

  it("rejects every severe dataset word, plain and inside a sentence, for adults and minors", () => {
    for (const w of severe) {
      for (const who of [adult, minor]) {
        expect(screenComment(w, who).verdict, `plain #${severe.indexOf(w)}`).toBe("reject");
        expect(screenComment(`you are a ${w}`, who).verdict, `sentence #${severe.indexOf(w)}`).toBe("reject");
      }
    }
  });

  it("still rejects severe words disguised with leetspeak, repeats or spacing", () => {
    for (const [i, w] of severe.entries()) {
      expect(screenComment(leet(w), adult).verdict, `leet #${i}`).toBe("reject");
      expect(screenComment(stretched(w), adult).verdict, `stretched #${i}`).toBe("reject");
      expect(screenComment(spaced(w), adult).verdict, `spaced #${i}`).toBe("reject");
      expect(screenComment(dotted(w), adult).verdict, `dotted #${i}`).toBe("reject");
    }
  });

  it("rejects every listed threat phrase and every verb/target pair", () => {
    for (const [i, p] of THREAT_PHRASES.entries()) {
      expect(screenComment(p, adult).verdict, `phrase #${i}`).toBe("reject");
      expect(screenComment(`${p}!!`, minor).verdict, `phrase+punct #${i}`).toBe("reject");
    }
    for (const verb of THREAT_VERBS) {
      for (const target of THREAT_TARGETS) {
        expect(screenComment(`i will ${verb} ${target}`, adult).verdict, `${verb}/${target}`).toBe("reject");
      }
    }
  });

  it("holds links, emails, phone numbers and handles for everyone", () => {
    for (const text of [
      "check out https://example.com/x",
      "visit niltv.xyz now",
      "email me me@example.org",
      "call 555 123 4567",
      "add me @someone",
      "snap: coolguy99",
    ]) {
      expect(screenComment(text, adult).verdict, text).toBe("hold");
      expect(screenComment(text, minor).verdict, text).toBe("hold");
    }
  });

  it("allows mild words for adults and holds them for minors", () => {
    for (const w of mild) {
      expect(screenComment(`that was ${w} great`, adult).verdict, `adult #${mild.indexOf(w)}`).toBe("allow");
      const result = screenComment(`that was ${w} great`, minor);
      expect(result.verdict, `minor #${mild.indexOf(w)}`).toBe("hold");
      expect(result.reason).toBe("profanity_minor");
    }
  });

  it("does not hold a minor's clean comment", () => {
    expect(screenComment("Amazing dunk!", minor).verdict).toBe("allow");
  });

  it("reject outranks hold", () => {
    expect(screenComment(`${THREAT_PHRASES[0]} https://x.com`, adult).verdict).toBe("reject");
    expect(screenComment(`${severe[0]} https://x.com`, adult).verdict).toBe("reject");
  });

  it("every MILD word is a real word in the dataset (guards against a rename on upgrade)", () => {
    const known = new Set(datasetWords());
    for (const w of MILD_WORDS) expect(known.has(w), w).toBe(true);
  });
});

/**
 * @mentions in groups and channels. Typing "@" at the start of a word opens
 * the people list; picking someone writes "@Full Name " into the message.
 * On send, only the picked people whose "@Full Name" is still in the text
 * count. Pure, so the rules are unit tested.
 */
import { MENTION_LIMIT } from "@niltv/types";

export interface Mention {
  sub: string;
  name: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Up to three words of a name; a space may trail while the next word is typed. */
const QUERY = /^[\p{L}\p{N}'’.-]*(?: [\p{L}\p{N}'’.-]*){0,2}$/u;
const MAX_QUERY = 40;

/** The "@name" being typed at the caret: where its "@" is and what follows it. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  // "@" inside a word (an email address) does not open the list.
  if (start > 0 && WORD_CHAR.test(before.charAt(start - 1))) return null;
  const query = before.slice(start + 1);
  if (query.length > MAX_QUERY || !QUERY.test(query)) return null;
  return { start, query };
}

/** Swap the "@query" from start to the caret for "@Full Name ". */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  const after = text.slice(caret).replace(/^ /, "");
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Subs of the picked people whose "@Full Name" is still in the body, at most
 * `limit`. Longer names match first, so "@Ann Lee" does not also count "Ann".
 */
export function mentionsIn(body: string, picked: readonly Mention[], limit: number = MENTION_LIMIT): string[] {
  const out: string[] = [];
  const found = new Set<string>();
  let rest = body;
  for (const p of [...picked].sort((a, b) => b.name.length - a.name.length)) {
    if (out.length >= limit) break;
    const name = p.name.trim();
    if (!name || out.includes(p.sub)) continue;
    if (!found.has(name)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "gu");
      const next = rest.replace(re, "$1");
      if (next === rest) continue;
      rest = next;
      found.add(name);
    }
    // Two people with the same name, both picked: both count.
    out.push(p.sub);
  }
  return out;
}

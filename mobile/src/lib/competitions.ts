/**
 * The Competitions tab's shelves, mirrored from the site's /competitions/
 * page. The site builds those shelves from
 * webapp/scripts/builders/build-sections.py: SEASON1_FINALISTS is its TOP20
 * (announcement order, champion first) and AUDITION_IDS is its AUDITION_IDS
 * (the 24-card cap; finalist originals sit at the back). Edit the two in
 * lockstep with the builder, never on their own. Content has no eventId, so
 * these ids ARE the scope; the app fetches each one through /v1/content/{id}
 * (useContentByIds) and prints the finalist NAME as the card title, the way
 * the site captions the Season 1 shelf.
 */

export interface Season1Finalist {
  /** Content id of the finalist's NIL Star edit on the flagship account. */
  id: string;
  /** Card caption. Finalists are named, not titled (site rule). */
  name: string;
  /** The one champion cell; the site tags it "Season 1 Champion". */
  champion?: true;
}

export const SEASON1_FINALISTS: readonly Season1Finalist[] = [
  { id: "ig-18090687326638212", name: "Bella Calvanese", champion: true },
  { id: "ig-18032459951649287", name: "Taylee Chirrick" },
  { id: "ig-17885005557669640", name: "Anna & Tom Lardner" },
  { id: "ig-18005583791944416", name: "Charlie Moore" },
  { id: "ig-18105514307111514", name: "Kali Boychuk" },
  { id: "ig-18148933864451059", name: "Kayliah Love" },
  { id: "ig-18088349483186091", name: "Miguel Hall" },
  { id: "ig-17968578101935272", name: "Jasmine Connor" },
  { id: "ig-17879255838614337", name: "Aleithia Wilson" },
  { id: "ig-18085956953359667", name: "Grace & Taylor Hasselbeck" },
  { id: "ig-18407599015157352", name: "Keagan Cunningham" },
  { id: "ig-18021282023853993", name: "Mia Girgis" },
  { id: "ig-18604893316048710", name: "Zander Vasquez" },
  { id: "ig-18217919269327952", name: "Keely Eslinger" },
  { id: "ig-18059364485762372", name: "Drew Collins" },
  { id: "ig-17960315856137760", name: "Eliana Geva" },
  { id: "ig-17997167144792706", name: "Jaylin Lott" },
  { id: "ig-17992218497811714", name: "Colin Coffey" },
  { id: "ig-18116745598768277", name: "Chihiro Bringman" },
  { id: "ig-17960395157963864", name: "Simon Lioznyansky" },
];

/**
 * "The Auditions": the open-call entries, then the finalists' own full
 * auditions (different footage from their Season 1 edits). Cards print the
 * API title.
 */
export const AUDITION_IDS: readonly string[] = [
  "ig-18539419810078105",
  "ig-17919562527182213",
  "ig-17897946027496513",
  "ig-18180934726405773",
  "ig-18094567163165109",
  "ig-18113933899902354",
  "ig-17884755516665461",
  "ig-17918818842181668",
  "ig-18085619087451279",
  "ig-18158019676419817",
  "ig-17884869510414822",
  "ig-18066609356375167",
  "ig-17959556736138023",
  "ig-18166221412439513",
  "ig-18025761827840117",
  "ig-18085637768097206",
  "ig-18112296895940804",
  "ig-17959643186965122",
  "ig-18120209332665246",
  "ig-18114673171680811",
  "ig-18132846328607840",
  "ig-17863728654632876",
  "ig-17851262943695464",
  "ig-18594161446025211",
];

/** Shelf titles, the site's exact strings. */
export const SEASON1_SHELF_TITLE = "NIL Singing Star Season 1";
export const AUDITIONS_SHELF_TITLE = "The Auditions";

/**
 * Card title for a finalist cell. Card has no tag slot, so the champion
 * is the plain name: the site hides every tile tag, including the champion's
 * "Season 1 Champion", so the app matches. The flag stays on the
 * data for anything that wants to mark the winner later.
 */
export function finalistTitle(f: Season1Finalist): string {
  return f.name;
}

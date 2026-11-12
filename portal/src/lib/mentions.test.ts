import { describe, expect, it } from "vitest";
import { insertMention, mentionAt, mentionsIn } from "./mentions";

const ann = { sub: "u-ann", name: "Ann Lee" };
const bo = { sub: "u-bo", name: "Bo Diaz" };

describe("the @ being typed", () => {
  it("opens at the start of a word", () => {
    expect(mentionAt("hi @an", 6)).toEqual({ start: 3, query: "an" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("(@bo", 4)).toEqual({ start: 1, query: "bo" });
  });

  it("stays shut inside a word, across a line break and past three words", () => {
    expect(mentionAt("mail a@b", 8)).toBeNull();
    expect(mentionAt("@ann\nnext", 9)).toBeNull();
    expect(mentionAt("@one two three four", 19)).toBeNull();
    expect(mentionAt("no at sign", 10)).toBeNull();
  });

  it("follows the caret, not the end of the text", () => {
    expect(mentionAt("@an and more", 3)).toEqual({ start: 0, query: "an" });
  });

  it("keeps a trailing space while the next word is typed", () => {
    expect(mentionAt("@Ann ", 5)).toEqual({ start: 0, query: "Ann " });
  });
});

describe("picking someone", () => {
  it("writes @Full Name and a space, caret after it", () => {
    expect(insertMention("hi @an", 3, 6, "Ann Lee")).toEqual({ text: "hi @Ann Lee ", caret: 12 });
  });

  it("does not double the space before text that follows", () => {
    expect(insertMention("hi @an there", 3, 6, "Ann Lee")).toEqual({ text: "hi @Ann Lee there", caret: 12 });
  });
});

describe("mentions on send", () => {
  it("counts picked people whose @name is still in the body", () => {
    expect(mentionsIn("Thanks @Ann Lee and @Bo Diaz", [ann, bo])).toEqual(["u-ann", "u-bo"]);
    expect(mentionsIn("Thanks @Bo Diaz", [ann, bo])).toEqual(["u-bo"]);
    expect(mentionsIn("@Ann Lee", [])).toEqual([]);
  });

  it("ignores a name inside a longer word or an email address", () => {
    expect(mentionsIn("@Ann Leeson is here", [ann])).toEqual([]);
    expect(mentionsIn("write to x@Ann Lee", [ann])).toEqual([]);
    expect(mentionsIn("@Ann Lee, see this", [ann])).toEqual(["u-ann"]);
  });

  it("does not count a shorter name inside a longer one", () => {
    const annOnly = { sub: "u-ann2", name: "Ann" };
    expect(mentionsIn("hi @Ann Lee", [annOnly, ann])).toEqual(["u-ann"]);
    expect(mentionsIn("hi @Ann Lee and @Ann", [annOnly, ann]).sort()).toEqual(["u-ann", "u-ann2"]);
  });

  it("keeps both people who share a name, once each", () => {
    const twin = { sub: "u-ann-2", name: "Ann Lee" };
    expect(mentionsIn("@Ann Lee", [ann, twin, ann])).toEqual(["u-ann", "u-ann-2"]);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ sub: `u${i}`, name: `Person ${i}` }));
    const body = many.map((p) => `@${p.name}`).join(" ");
    expect(mentionsIn(body, many)).toHaveLength(20);
    expect(mentionsIn(body, many, 3)).toHaveLength(3);
  });

  it("takes names with regex characters literally", () => {
    const odd = { sub: "u-odd", name: "J.R. (Jr)" };
    expect(mentionsIn("hey @J.R. (Jr)", [odd])).toEqual(["u-odd"]);
    expect(mentionsIn("hey @JxRx (Jr)", [odd])).toEqual([]);
  });
});

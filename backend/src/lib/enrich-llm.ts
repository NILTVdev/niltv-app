/**
 * Claude classifier (content foundation) — the second opinion for clips the
 * rule-based pass is not confident about. Runs in the backfill and, when an
 * API key is configured, at ingest. Structured output against our own
 * vocabularies, so nothing outside the enums can come back.
 *
 * Batches of captions go in one request (the vocabulary definitions are the
 * cached prefix); the reply is one verdict per id. A verdict is only applied
 * to a field the rule pass left empty or scored below its threshold — a
 * hashtag that names the sport still beats the model, and a person's
 * override beats both.
 *
 * The SDK's structured-output helper speaks Zod v4, so the response schema
 * is built with `zod/v4` from the same enum values the contract exports.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ContentType, Sport } from "@niltv/types";
import * as z from "zod/v4";

export const MODEL = "claude-opus-5";

const SportV4 = z.enum(Sport.options);
const ContentTypeV4 = z.enum(ContentType.options);

const Verdict = z.object({
  id: z.string(),
  sport: SportV4.nullable(),
  contentType: ContentTypeV4,
  secondary: z.array(ContentTypeV4),
  /** brand or company the clip promotes, when it clearly does; else null */
  sponsor: z.string().nullable(),
  /** 0–1: how sure the model is of contentType */
  confidence: z.number().min(0).max(1),
});
export type LlmVerdict = z.infer<typeof Verdict>;
const Batch = z.object({ items: z.array(Verdict) });

export interface CaptionInput {
  id: string;
  caption: string;
  /** hints the model may lean on: the account, the credited athlete's sport, the school */
  account?: string;
  athleteSport?: string;
  school?: string;
}

const SYSTEM = `You classify short-form college sports videos for NIL TV from their Instagram captions. Answer only in the vocabularies given. Choose "none-visible" for sport when no sport is on screen or named (a skit, a vlog, a meal). Choose the content type that best describes what the video IS, not what it mentions. Confidence is your own certainty about contentType.

sport values: ${Sport.options.join(", ")}
contentType values and meanings:
- hype-announcement: welcomes, signings, commitments, teasers, launches
- training-workout: practice, lifting, drills, conditioning, grind
- skit-humor: comedy, POV, relatable bits
- singing-audition: singing, covers, NIL Star auditions
- interview-podcast: sit-down conversations, podcast clips
- ditl-vlog: day in the life, vlog, routine
- celebration-highlight: wins, plays, records, celebrations
- team-qa: questions to teammates, question of the day
- brand-sponsored: paid partnerships, product promotion, promo codes
- what-i-eat: meals, nutrition, cooking
- travel-road: travel days, away games, bus and flight content
- gear-haul: gear, unboxing, shoutouts to brands for product
- game-day: game day itself, pregame, on-field or courtside
- media-day: media day, photo shoots
- grwm-fitcheck: getting ready, outfits
- recovery: recovery, rehab, ice baths, mobility
- micd-up: mic'd up during play or practice
- bts: behind the scenes of a shoot
- other: none of the above`;

let client: Anthropic | undefined;
const getClient = (): Anthropic => (client ??= new Anthropic());

/** True when a key is configured; callers skip the model otherwise. */
export const llmAvailable = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);

/** Classify up to ~25 captions in one call. Returns verdicts keyed by id; ids the model dropped are simply absent. */
export async function classifyWithClaude(inputs: readonly CaptionInput[]): Promise<Map<string, LlmVerdict>> {
  const out = new Map<string, LlmVerdict>();
  if (inputs.length === 0) return out;
  const lines = inputs.map((c) => {
    const hints = [c.account ? `account=${c.account}` : "", c.athleteSport ? `athlete sport=${c.athleteSport}` : "", c.school ? `school=${c.school}` : ""]
      .filter(Boolean)
      .join(", ");
    return `id: ${c.id}${hints ? ` (${hints})` : ""}\ncaption: ${c.caption.replace(/\s+/g, " ").slice(0, 600)}`;
  });
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: zodOutputFormat(Batch) },
    messages: [
      {
        role: "user",
        content: `Classify each of the following ${inputs.length} clips. Return one item per id, in the same order.\n\n${lines.join("\n\n")}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return out;
  for (const item of response.parsed_output.items) out.set(item.id, item);
  return out;
}

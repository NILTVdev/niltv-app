/**
 * Content Hub rows and rules, shared by the API and its tests.
 *
 * One partition per ask: ASK#{id} holds the META row, a CLAIM#{sub} row per
 * athlete and a FILE#{sub}#{fileId} row per file, so one query reads it all.
 */
import { AskAudience, type ClaimStatus, ClaimStatus as ClaimStatusSchema, type SubmissionFile } from "@niltv/types";
import { z } from "zod";

export const StoredAsk = z.object({
  id: z.string(),
  title: z.string(),
  format: z.enum(["short", "long"]),
  description: z.string().default(""),
  audience: AskAudience,
  audienceLabel: z.string(),
  requiresApproval: z.boolean().default(false),
  status: z.enum(["open", "closed"]),
  createdBySub: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type StoredAsk = z.infer<typeof StoredAsk>;

export const StoredClaim = z.object({
  sub: z.string(),
  status: ClaimStatusSchema,
  at: z.string(),
  note: z.string().default(""),
  reviewNote: z.string().default(""),
});
export type StoredClaim = z.infer<typeof StoredClaim>;

export const StoredFile = z.object({
  sub: z.string(),
  id: z.string(),
  name: z.string(),
  size: z.number(),
  type: z.string(),
  key: z.string(),
  /** the open multipart upload; gone once the file has landed */
  uploadId: z.string().optional(),
  state: z.enum(["uploading", "ready"]),
  at: z.string(),
});
export type StoredFile = z.infer<typeof StoredFile>;

/** Where a claim can go from, by what is being done to it. */
export const CLAIM_FROM = {
  approve: ["requested", "declined"],
  decline: ["requested"],
  submit: ["claimed", "changes"],
  review: ["submitted"],
  release: ["requested", "claimed", "changes"],
} as const satisfies Record<string, readonly ClaimStatus[]>;

/** Files can be added and removed while the athlete still holds the work. */
export const canChangeFiles = (status: ClaimStatus): boolean => status === "claimed" || status === "changes";

/** Only letters, numbers and a few marks reach the storage key and the download name. */
export const safeFileName = (name: string): string => {
  const clean = name
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120);
  return clean || "file";
};

export const fileKey = (askId: string, sub: string, fileId: string, name: string): string =>
  `submissions/${askId}/${sub}/${fileId}/${safeFileName(name)}`;

export const presentFile = (f: StoredFile): SubmissionFile => ({ id: f.id, name: f.name, size: f.size, type: f.type, at: f.at });

/** Do the parts that arrived make up the file the athlete said they were sending? */
export function partsMatch(parts: readonly { size: number }[], expectedParts: number, expectedBytes: number): boolean {
  return parts.length === expectedParts && parts.reduce((sum, p) => sum + p.size, 0) === expectedBytes;
}

/** Split the rows of an ask's partition into claims and landed files. */
export function readPartition(items: readonly Record<string, unknown>[]): {
  claims: StoredClaim[];
  files: Map<string, StoredFile[]>;
  uploading: StoredFile[];
} {
  const claims: StoredClaim[] = [];
  const files = new Map<string, StoredFile[]>();
  const uploading: StoredFile[] = [];
  for (const item of items) {
    const sk = String(item["SK"] ?? "");
    if (sk.startsWith("CLAIM#")) {
      const claim = StoredClaim.safeParse(item);
      if (claim.success) claims.push(claim.data);
    } else if (sk.startsWith("FILE#")) {
      const file = StoredFile.safeParse(item);
      if (!file.success) continue;
      if (file.data.state === "uploading") uploading.push(file.data);
      else files.set(file.data.sub, [...(files.get(file.data.sub) ?? []), file.data]);
    }
  }
  for (const list of files.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return { claims, files, uploading };
}

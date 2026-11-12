/**
 * Audit trail for access and moderation changes: one JSON line per write in
 * the handler's CloudWatch log group (one-month retention, like every portal
 * log). The log metric filters and Logs Insights queries key on
 * `"audit":"portal"`.
 *
 * When both `before` and `after` are objects, only the fields that changed
 * are kept, so a member edit logs `{ role: { before, after } }` and not the
 * whole row twice. `updatedAt` is never logged as a change. A new row
 * (an object with no `before`) is diffed against an empty row the same way.
 *
 * Contact details and long text never reach the log: those fields show as
 * `"<changed>"`, so the line still says that they changed.
 */

export interface AuditChange {
  before?: unknown;
  after?: unknown;
}

export const REDACTED = "<changed>";

/** Fields logged only as `"<changed>"`: personal details, payment state, addresses and long text. */
const UNLOGGED = new Set([
  "email",
  "name",
  "school",
  "sport",
  "year",
  "instagram",
  "profileId",
  "applicationId",
  "stripe",
  "note",
  "timezone",
  "notify",
  "deskEmails",
  "supportEmail",
  "about",
  "details",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Field-level diff of two rows: `{ field: { before, after } }` for each field that differs. */
export function auditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, AuditChange | typeof REDACTED> {
  const out: Record<string, AuditChange | typeof REDACTED> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "updatedAt") continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    out[key] = UNLOGGED.has(key) ? REDACTED : { before: before[key], after: after[key] };
  }
  return out;
}

/** The line `audit` writes, without the timestamp. Exported for tests. */
export function auditEntry(actor: string, action: string, target: string, change: AuditChange = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = { audit: "portal", actor, action, target };
  const { before, after } = change;
  const rows = (isRecord(before) || before === undefined) && (isRecord(after) || after === undefined);
  if (rows && (isRecord(before) || isRecord(after))) entry.changes = auditDiff(before ?? {}, after ?? {});
  else {
    if (change.before !== undefined) entry.before = change.before;
    if (change.after !== undefined) entry.after = change.after;
  }
  return entry;
}

/** Write one audit line. Never throws: a logging failure must not fail the write it records. */
export function audit(actor: string, action: string, target: string, change?: AuditChange): void {
  try {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...auditEntry(actor, action, target, change) }));
  } catch (err) {
    console.error("portal: audit line failed", action, target, err);
  }
}

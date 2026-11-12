/**
 * Audit trail for access and moderation changes: one JSON line per write in
 * the handler's CloudWatch log group (one-month retention, like every portal
 * log). The log metric filters and Logs Insights queries key on
 * `"audit":"portal"`.
 *
 * When both `before` and `after` are objects, only the fields that changed
 * are kept, so a member edit logs `{ role: { before, after } }` and not the
 * whole row twice. `updatedAt` is never logged as a change.
 */

export interface AuditChange {
  before?: unknown;
  after?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Field-level diff of two rows: `{ field: { before, after } }` for each field that differs. */
export function auditDiff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, AuditChange> {
  const out: Record<string, AuditChange> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "updatedAt") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { before: before[key], after: after[key] };
  }
  return out;
}

/** The line `audit` writes, without the timestamp. Exported for tests. */
export function auditEntry(actor: string, action: string, target: string, change: AuditChange = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = { audit: "portal", actor, action, target };
  if (isRecord(change.before) && isRecord(change.after)) entry.changes = auditDiff(change.before, change.after);
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

/**
 * The applicant list on Athletes: every niltv.com athlete application that
 * is still in play, with what each one is missing before portal access.
 *
 * The dashboard owns onboarding (staff review, the agreement, Stripe). The
 * portal adds two facts it alone knows: whether a confirmed niltv.com account
 * matches the application email, and whether the roster sync has made the
 * athlete a member yet. Nothing here writes.
 */
import { ListUsersCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import {
  type ApplicantStage,
  CAMPUS_CHANNELS,
  type PortalApplicant,
  type PortalMember,
  firstSafeName,
} from "@niltv/types";
import { nameFromEmail } from "./accounts";

/** The fields read from GET /api/applications/ (dashboard ApplicationOut). */
export interface DashboardApplication {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  university: string | null;
  sport: string | null;
  campus_channel: string | null;
  international: boolean | null;
  status: string;
  created_at?: string | null;
}

/** Dashboard status → stage. `applicant` is the dashboard's word for a new, unreviewed application. */
const STAGE: Record<string, ApplicantStage> = {
  applicant: "applied",
  approved: "approved",
  agreement_sent: "agreement_sent",
  signed: "signed",
  stripe_pending: "stripe_pending",
  accepted: "accepted",
};

export async function fetchApplications(baseUrl: string, apiKey: string): Promise<DashboardApplication[]> {
  const res = await fetch(`${baseUrl}/api/applications/?status=all&limit=2000`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`dashboard applications: HTTP ${res.status}`);
  return (await res.json()) as DashboardApplication[];
}

let cognito: CognitoIdentityProviderClient | undefined;

/**
 * Lower-cased emails of every confirmed, enabled account with a verified
 * email. One pass over the pool: it is small, and one list beats a lookup
 * per applicant.
 */
export async function verifiedAccountEmails(): Promise<Set<string>> {
  const poolId = process.env.USER_POOL_ID;
  if (!poolId) throw new Error("USER_POOL_ID unset");
  cognito ??= new CognitoIdentityProviderClient({});
  const emails = new Set<string>();
  let token: string | undefined;
  do {
    const out = await cognito.send(
      new ListUsersCommand({
        UserPoolId: poolId,
        AttributesToGet: ["email", "email_verified"],
        Limit: 60,
        ...(token ? { PaginationToken: token } : {}),
      }),
    );
    for (const user of out.Users ?? []) {
      if (user.Enabled === false || user.UserStatus !== "CONFIRMED") continue;
      const attrs = new Map((user.Attributes ?? []).map((a) => [a.Name ?? "", a.Value ?? ""]));
      const email = attrs.get("email");
      if (email && attrs.get("email_verified") === "true") emails.add(email.trim().toLowerCase());
    }
    token = out.PaginationToken;
  } while (token);
  return emails;
}

/** The dashboard sends naive UTC timestamps; read them as UTC. */
function appliedAt(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Join applications with accounts and members. Declined and unknown statuses drop out. */
export function buildApplicants(
  apps: readonly DashboardApplication[],
  accountEmails: ReadonlySet<string>,
  members: readonly PortalMember[],
): PortalApplicant[] {
  const byApp = new Map(members.filter((m) => m.applicationId !== undefined).map((m) => [m.applicationId!, m]));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const out: PortalApplicant[] = [];
  for (const app of apps) {
    const stage = STAGE[app.status];
    if (!stage || typeof app.email !== "string" || !app.email.includes("@")) continue;
    const email = app.email.trim().toLowerCase();
    // The application id wins: an admin may have linked an account on another address.
    const member = byApp.get(app.id) ?? (byEmail.get(email)?.applicationId === undefined ? byEmail.get(email) : undefined);
    const athlete = member?.role === "athlete" ? member : undefined;
    const name = [app.first_name, app.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
    const campus = app.campus_channel && CAMPUS_CHANNELS[app.campus_channel] ? app.campus_channel : undefined;
    out.push({
      applicationId: app.id,
      name: firstSafeName([name, nameFromEmail(email)]),
      email,
      ...(campus ? { campus } : {}),
      ...(app.university ? { school: app.university } : {}),
      ...(app.sport ? { sport: app.sport } : {}),
      ...(appliedAt(app.created_at) ? { appliedAt: appliedAt(app.created_at) } : {}),
      stage,
      international: app.international === true,
      hasAccount: member !== undefined || accountEmails.has(email),
      ...(athlete ? { memberSub: athlete.sub, memberStatus: athlete.status } : {}),
    });
  }
  return out;
}

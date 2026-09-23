/**
 * Partner webhook URL policy (partner content API). Staff type these in, but
 * the deliverer runs inside our account and POSTs wherever the row says, so
 * the row must never point somewhere a browser-facing form would not be
 * allowed to: https only, a real host name (no IP literals), and none of the
 * loopback/link-local/private names that would turn the deliverer into a
 * server-side request forgery primitive. Checked on write (admin upsert) and
 * again on send (webhook-deliver), so a row edited out of band is still refused.
 */

const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/** Reason a URL is refused, or undefined when it is acceptable. */
export function webhookUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not carry credentials";
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "host is not allowed";
  }
  // IPv4 / IPv6 literals: partners give us names, and a literal is how
  // link-local and private ranges would sneak in.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return "IP literals are not allowed";
  if (!host.includes(".")) return "host must be a fully qualified name";
  return undefined;
}

export const isSafeWebhookUrl = (value: string): boolean => webhookUrlProblem(value) === undefined;

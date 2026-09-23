/**
 * Send-provider forwarding for confirmed newsletter subscribers (design §6.7:
 * "wire via a forwarding Lambda when ready"). Inert until BEEHIIV_API_KEY +
 * BEEHIIV_PUBLICATION_ID are set; failures are logged, never surfaced — the
 * table already holds the signup. Called only AFTER double opt-in confirms
 * ownership of the address: forwarding an unconfirmed
 * address would let anyone enroll victims into the provider's sends.
 */
export async function forwardToProvider(email: string, source: string): Promise<void> {
  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !publicationId) return;
  try {
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ email, utm_source: `niltv-app-${source}` }),
      },
    );
    if (!res.ok) console.error(`Beehiiv forward failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("Beehiiv forward failed", err);
  }
}

/** Payments: payouts run through Stripe; this page points there and to the Payments desk. */
import { errorText } from "../api";
import { STRIPE_STATUS } from "../lib/format";
import { useOpenDesk } from "../queries";
import { PageHead, Pill } from "../ui/bits";
import { useMe } from "../ui/me";

export function Payments() {
  const { member } = useMe();
  const openDesk = useOpenDesk();
  const stripe = member.stripe ? STRIPE_STATUS[member.stripe] : undefined;

  return (
    <>
      <PageHead
        title="Payments"
        sub="NIL TV pays through Stripe. Your bank details and tax forms live in your Stripe account, not here."
        access="Only you and admins"
      />
      <div className="split">
        <section className="panel stack" aria-labelledby="stripe-h">
          <div className="row">
            <h3 id="stripe-h">Stripe</h3>
            {stripe ? <Pill tone={stripe.tone}>{stripe.label}</Pill> : null}
          </div>
          <p className="note">
            Payouts land in the bank account you added in Stripe, usually within two business days. Stripe sends your
            tax form.
          </p>
          <div className="row">
            <a className="btn" href="https://connect.stripe.com/express_login" target="_blank" rel="noopener noreferrer">
              Open my Stripe account
            </a>
          </div>
          <p className="note muted">To change your bank account, open Stripe. NIL TV staff never see your bank details.</p>
        </section>
        <section className="panel stack" aria-labelledby="pay-q-h">
          <h3 id="pay-q-h">Questions about a payout?</h3>
          <p className="note">The Payments desk answers in Messages. Only admins can read it.</p>
          {openDesk.error ? (
            <p className="err" role="alert">
              {errorText(openDesk.error)}
            </p>
          ) : null}
          <div className="row">
            <button
              type="button"
              className="btn ghost"
              disabled={openDesk.isPending}
              onClick={() => openDesk.mutate({ desk: "payments" })}
            >
              {openDesk.isPending ? "Opening…" : "Message the Payments desk"}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

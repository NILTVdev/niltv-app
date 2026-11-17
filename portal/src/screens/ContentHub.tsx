/**
 * Content Hub: asks from the team. Athletes claim one, film it and send it
 * here; staff decide on claims and accept the work or send it back.
 */
import { ASK_FORMAT_LABELS, type Ask } from "@niltv/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { CLAIM, splitAsks } from "../lib/hub";
import { formatShortDate } from "../lib/time";
import type { ScreenProps } from "../Portal";
import { qk, useAsks } from "../queries";
import { Empty, ErrorNote, Loading, PageHead, Pill, Tabs } from "../ui/bits";
import { Markdown } from "../ui/Markdown";
import { useMe } from "../ui/me";
import { useToast } from "../ui/Toast";
import { useFlash } from "../ui/useFlash";
import { StaffHub } from "./hub/StaffHub";
import { Submit } from "./hub/Submit";

export function ContentHub({ id }: ScreenProps) {
  const { member } = useMe();
  return member.role === "athlete" ? <AthleteHub id={id} /> : <StaffHub id={id} />;
}

type Tab = "open" | "mine" | "done";

function AthleteHub({ id }: { id?: string }) {
  const asks = useAsks();
  const [tab, setTab] = useState<Tab>("open");
  const { open, mine, done } = splitAsks(asks.data ?? []);
  const target = id ? asks.data?.find((a) => a.id === id) : undefined;
  useFlash(target ? `ask-${target.id}` : undefined, Boolean(target));

  // A link to one ask lands on the tab that holds it.
  useEffect(() => {
    if (!target) return;
    const status = target.myClaim?.status;
    setTab(!status ? "open" : status === "delivered" ? "done" : "mine");
  }, [target]);

  const list = tab === "open" ? open : tab === "mine" ? mine : done;
  return (
    <>
      <PageHead
        title="Content Hub"
        sub="Content the NIL TV team is looking for. Claim what you want to make, film it, and send it in here."
        access="You and staff"
      />
      {id && asks.data && !target ? <p className="err">That ask is closed or no longer listed.</p> : null}
      {asks.isPending ? <Loading /> : null}
      <ErrorNote error={asks.error} onRetry={() => void asks.refetch()} />
      {asks.data ? (
        <>
          <Tabs
            idBase="hub"
            label="Asks"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "open", label: "Open asks", count: open.length },
              { key: "mine", label: "My claims", count: mine.length },
              { key: "done", label: "Delivered", count: done.length },
            ]}
          />
          <div id="hub-panel" role="tabpanel" aria-labelledby={`hub-${tab}`}>
            {list.length ? (
              <div className="grid">
                {list.map((a) => (
                  <AskCard key={a.id} ask={a} />
                ))}
              </div>
            ) : (
              <Empty>Nothing here yet.</Empty>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

function AskCard({ ask }: { ask: Ask }) {
  const { zone, member } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const status = ask.myClaim?.status;
  const action = useMutation({
    mutationFn: (kind: "claim" | "release") => api.askAction(ask.id, { action: kind }),
    onSuccess: (_, kind) => {
      void qc.invalidateQueries({ queryKey: qk.asks });
      toast(kind === "release" ? "Given back." : ask.requiresApproval ? "Requested. Staff will decide." : "Claimed. It's under My claims.");
    },
  });
  const working = status === "claimed" || status === "changes";

  return (
    <article className="card" id={`ask-${ask.id}`} aria-labelledby={`ask-h-${ask.id}`}>
      <div className="card-top">
        <span className="row tight">
          <span className={`fmt${ask.format === "long" ? " long" : ""}`}>{ASK_FORMAT_LABELS[ask.format]}</span>
          <span className="tgt">{ask.audienceLabel}</span>
        </span>
        {status ? <Pill tone={CLAIM[status].tone}>{CLAIM[status].label}</Pill> : null}
      </div>
      <h3 id={`ask-h-${ask.id}`}>{ask.title}</h3>
      {ask.description ? <Markdown text={ask.description} images={ask.images} /> : null}
      {status === "changes" && ask.myClaim?.reviewNote ? (
        <p className="note">
          <b>What to change:</b> {ask.myClaim.reviewNote}
        </p>
      ) : null}
      <div className="meta">Posted {formatShortDate(ask.createdAt, zone)}</div>
      {action.error ? (
        <p className="err" role="alert">
          {errorText(action.error)}
        </p>
      ) : null}
      {submitting && working ? (
        <Submit ask={ask} sub={member.sub} onDone={() => setSubmitting(false)} />
      ) : (
        <div className="foot row">
          {!status ? (
            <>
              <button type="button" className="btn" disabled={action.isPending} onClick={() => action.mutate("claim")}>
                {ask.requiresApproval ? "Request to claim" : "Claim this"}
              </button>
              {ask.requiresApproval ? <span className="note">Staff approve this one first.</span> : null}
            </>
          ) : working ? (
            <>
              <button type="button" className="btn" onClick={() => setSubmitting(true)}>
                {status === "changes" ? "Send new content" : "Submit content"}
              </button>
              <button type="button" className="btn ghost" disabled={action.isPending} onClick={() => action.mutate("release")}>
                Give it back
              </button>
            </>
          ) : status === "requested" ? (
            <>
              <span className="note">Waiting for staff to approve.</span>
              <button type="button" className="btn ghost" disabled={action.isPending} onClick={() => action.mutate("release")}>
                Withdraw
              </button>
            </>
          ) : status === "submitted" ? (
            <span className="note">With the team for review.</span>
          ) : status === "declined" ? (
            <span className="note">Not approved this time.</span>
          ) : (
            <span className="note">Delivered and accepted.</span>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Newsletter subscribers (design §6.7): the table is the system of record and
 * staff export from here until a send provider exists — Download CSV pulls
 * the server-rendered text/csv verbatim.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, newsletterCsv } from "./api";

export function NewsletterPage() {
  const subsQ = useQuery({ queryKey: ["newsletter"], queryFn: api.listSubscribers });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downloadCsv() {
    setExporting(true);
    setError(null);
    try {
      const csv = await newsletterCsv();
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "niltv-newsletter.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const items = subsQ.data?.items ?? [];

  return (
    <section>
      <h2>
        Newsletter subscribers ({items.length}){" "}
        <button className="btn" onClick={() => void downloadCsv()} disabled={exporting}>
          {exporting ? "Exporting…" : "Download CSV"}
        </button>
      </h2>
      {error ? <div className="error-banner">{error}</div> : null}
      {subsQ.isPending ? <p className="hint">Loading subscribers…</p> : null}
      {subsQ.isError ? <div className="error-banner">Couldn&apos;t load subscribers.</div> : null}
      {!subsQ.isPending && items.length === 0 ? <p className="hint">No signups yet.</p> : null}
      {items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Phone</th>
              <th>Sources</th>
              <th>Signed up</th>
            </tr>
          </thead>
          <tbody>
            {items.map((sub) => (
              <tr key={sub.email}>
                <td>{sub.email}</td>
                <td>{sub.phone ?? "—"}</td>
                <td>{[...new Set(sub.sources)].join(", ")}</td>
                <td>{new Date(sub.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

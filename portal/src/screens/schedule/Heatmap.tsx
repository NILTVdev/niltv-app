/** Staff: when people are usually free, as a 7 x 4 heatmap for an audience. */
import { DAY_BLOCK_LABELS, DAY_BLOCKS, PORTAL_SPORTS, WEEKDAYS } from "@niltv/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { CAMPUS_OPTIONS, plural } from "../../lib/format";
import { bestSlots, heatShade, slotKey, WEEKDAY_LABELS } from "../../lib/heat";
import { qk, useInbox } from "../../queries";
import { ErrorNote, Loading } from "../../ui/bits";
import { BLOCK_HELP } from "./AvailabilityGrid";

type HeatType = "everyone" | "campus" | "sport" | "group";

const slotLabel = (slot: string): string => {
  const [d, b] = slot.split("-") as [keyof typeof WEEKDAY_LABELS, keyof typeof DAY_BLOCK_LABELS];
  return `${WEEKDAY_LABELS[d] ?? d} ${(DAY_BLOCK_LABELS[b] ?? b).toLowerCase()}`;
};

export function Heatmap() {
  const [type, setType] = useState<HeatType>("everyone");
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const inbox = useInbox();
  const groups = (inbox.data ?? []).filter((c) => c.kind === "group").sort((a, b) => a.title.localeCompare(b.title));

  const enabled = type === "everyone" || value !== "";
  const heat = useQuery({
    queryKey: qk.heatmap(type, value),
    queryFn: () => api.heatmap(type, type === "everyone" ? undefined : value),
    enabled,
  });

  const cells = new Map((heat.data?.cells ?? []).map((c) => [c.slot, c]));
  const responded = heat.data?.responded ?? 0;
  const best = bestSlots(heat.data?.cells ?? []);
  const sel = selected ? cells.get(selected) : undefined;

  return (
    <div className="panel stack">
      <div className="two">
        <div className="field">
          <label htmlFor="hm-type">Whose availability</label>
          <select
            id="hm-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as HeatType);
              setValue("");
              setSelected(null);
            }}
          >
            <option value="everyone">Every athlete</option>
            <option value="campus">One campus</option>
            <option value="sport">One sport</option>
            <option value="group">A group</option>
          </select>
        </div>
        {type !== "everyone" ? (
          <div className="field">
            <label htmlFor="hm-value">{type === "campus" ? "Campus" : type === "sport" ? "Sport" : "Group"}</label>
            <select
              id="hm-value"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSelected(null);
              }}
            >
              <option value="">Pick one</option>
              {type === "campus"
                ? CAMPUS_OPTIONS.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))
                : type === "sport"
                  ? PORTAL_SPORTS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))
                  : groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
            </select>
          </div>
        ) : null}
      </div>

      {!enabled ? <p className="note">Pick who to look at.</p> : null}
      {enabled && heat.isPending ? <Loading /> : null}
      <ErrorNote error={heat.error} onRetry={() => void heat.refetch()} />
      {heat.data ? (
        <>
          <p className="note">
            <b>
              {heat.data.responded} of {plural(heat.data.invited, "person", "people")}
            </b>{" "}
            responded. Darker means more people are free. Hover or tap a cell for names.
          </p>
          <div className="avail" role="group" aria-label="Availability heatmap">
            <span />
            {WEEKDAYS.map((d) => (
              <span key={d} className="h" aria-hidden="true">
                {WEEKDAY_LABELS[d]}
              </span>
            ))}
            {DAY_BLOCKS.map((b) => (
              <div key={b} style={{ display: "contents" }}>
                <span className="rl" aria-hidden="true">
                  {DAY_BLOCK_LABELS[b]}
                </span>
                {WEEKDAYS.map((d) => {
                  const key = slotKey(d, b);
                  const cell = cells.get(key);
                  const count = cell?.count ?? 0;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`cell${selected === key ? " sel" : ""}`}
                      style={heatShade(count, responded)}
                      title={cell?.names.length ? cell.names.join(", ") : "Nobody"}
                      aria-label={`${slotLabel(key)}: ${plural(count, "person", "people")} free`}
                      aria-pressed={selected === key}
                      onClick={() => setSelected(selected === key ? null : key)}
                    >
                      {count}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div aria-live="polite">
            {selected ? (
              <p className="note">
                <b>{slotLabel(selected)}:</b> {sel?.names.length ? sel.names.join(", ") : "Nobody is free."}
              </p>
            ) : null}
          </div>
          {best.length ? (
            <p className="note">
              Best times:{" "}
              {best.map((c, i) => (
                <span key={c.slot}>
                  {i > 0 ? ", " : ""}
                  <b>{slotLabel(c.slot)}</b> ({c.count})
                </span>
              ))}
              .
            </p>
          ) : null}
          <p className="meta">{BLOCK_HELP} Each person sets the blocks in their own time zone.</p>
        </>
      ) : null}
    </div>
  );
}

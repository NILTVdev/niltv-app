/**
 * The message box under a thread. Enter sends, Shift+Enter adds a line.
 * In groups and channels, "@" at the start of a word opens the people list
 * (GET .../people?q= about 200 ms after the last key): up and down move,
 * Enter picks, Escape closes, and a click works too. Staff in Announcements
 * also get the Important box.
 */
import type { PortalPerson } from "@niltv/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "../../api";
import { campusName, plural, ROLE_LABELS } from "../../lib/format";
import { insertMention, type Mention, mentionAt, mentionsIn } from "../../lib/mentions";
import { draftFor, saveDraft } from "../../lib/outbox";
import { qk } from "../../queries";
import { Avatar, Check } from "../../ui/bits";
import { useMe } from "../../ui/me";
import type { Draft } from "./useThread";

const MAX_BODY = 4000;
const SEARCH_DELAY_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const personLine = (p: PortalPerson): string =>
  [ROLE_LABELS[p.role], p.role === "athlete" ? campusName(p.campus) : "", p.role === "athlete" ? p.sport : ""]
    .filter(Boolean)
    .join(" · ");

export function Composer({
  convId,
  placeholder,
  hint,
  lockedNote,
  mentions,
  importantBox,
  top,
  onSend,
}: {
  convId: string;
  placeholder: string;
  hint?: string;
  /** set: the composer is disabled and this says why */
  lockedNote?: string;
  /** groups and channels: "@" opens the people list */
  mentions: boolean;
  /** staff in Announcements: "Important: email everyone now" */
  importantBox: boolean;
  /** a card above the box (the notification prompt) */
  top?: ReactNode;
  onSend: (draft: Draft) => void;
}) {
  const { member, notifications } = useMe();
  // Text typed here before leaving the thread comes back on return.
  const [saved] = useState(() => draftFor(convId));
  const [text, setText] = useState(saved?.text ?? "");
  const [caret, setCaret] = useState(saved?.text.length ?? 0);
  const [focused, setFocused] = useState(false);
  const [picked, setPicked] = useState<Mention[]>(saved?.picked ?? []);
  /** the "@" (by position) whose list was closed by Escape or a pick; a new "@" opens again */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [important, setImportant] = useState(saved?.important ?? false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nextCaret = useRef<number | null>(null);
  const blurTimer = useRef<number | undefined>(undefined);
  const listId = useId();

  const body = text.trim();
  const tooLong = body.length > MAX_BODY;
  const locked = lockedNote !== undefined;

  const trigger = mentions && !locked ? mentionAt(text, caret) : null;
  const listOpen = trigger !== null && trigger.start !== dismissed && focused;
  const q = useDebounced(trigger && listOpen ? trigger.query.trim() : "", SEARCH_DELAY_MS);
  const found = useQuery({
    queryKey: qk.people(convId, q),
    queryFn: () => api.people(convId, q),
    enabled: listOpen,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const people = listOpen ? (found.data?.people ?? []).filter((p) => p.sub !== member.sub).slice(0, 5) : [];
  const activeIndex = Math.min(active, Math.max(0, people.length - 1));
  const showList = people.length > 0;
  const noMatch = listOpen && !showList && q !== "" && found.data !== undefined && !found.isFetching;

  useEffect(() => {
    setActive(0);
  }, [q]);

  useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  useEffect(() => saveDraft(convId, { text, picked, important }), [convId, text, picked, important]);

  // Put the caret after an inserted "@Full Name ".
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  }, [text]);

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    const t = mentionAt(value, at);
    if (!t || t.start !== dismissed) setDismissed(null);
  };

  const pick = (p: PortalPerson) => {
    if (!trigger) return;
    const next = insertMention(text, trigger.start, caret, p.name);
    setText(next.text);
    setCaret(next.caret);
    nextCaret.current = next.caret;
    setDismissed(trigger.start);
    setPicked((list) => (list.some((m) => m.sub === p.sub) ? list : [...list, { sub: p.sub, name: p.name }]));
    inputRef.current?.focus();
  };

  const submit = () => {
    if (locked || !body || tooLong) return;
    onSend({ body, mentions: mentions ? mentionsIn(body, picked) : [], important: importantBox && important });
    setText("");
    setCaret(0);
    setPicked([]);
    setDismissed(null);
    setImportant(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (listOpen && trigger) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(trigger.start);
        return;
      }
      if (showList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setActive((people.length + activeIndex + (e.key === "ArrowDown" ? 1 : -1)) % people.length);
        return;
      }
      const choice = people[activeIndex];
      if (choice && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        pick(choice);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      {top}
      {showList ? (
        <div className="mentions" id={listId} role="listbox" aria-label="People to mention">
          {people.map((p, i) => (
            <div
              key={p.sub}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className="person"
              // Keep focus in the box, so the list stays open and the caret stays put.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
            >
              <Avatar name={p.name} role={p.role} />
              <span className="nm">{p.name}</span>
              <span className="muted">{personLine(p)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {noMatch ? (
        <div className="mentions">
          <p className="muted">Nobody by that name here.</p>
        </div>
      ) : null}
      <span className="sr-only" role="status">
        {showList
          ? `${plural(people.length, "person", "people")} to mention. Up and down to choose, Enter to pick.`
          : noMatch
            ? "Nobody by that name here."
            : ""}
      </span>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          ref={inputRef}
          id="composer-input"
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          value={text}
          placeholder={placeholder}
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            window.clearTimeout(blurTimer.current);
            setFocused(true);
          }}
          // A short delay so a tap on a name lands before the list closes.
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setFocused(false), 150);
          }}
          aria-describedby="composer-hint"
          aria-autocomplete={mentions ? "list" : undefined}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          disabled={locked}
        />
        <button className="btn" type="submit" disabled={locked || !body || tooLong}>
          Send
        </button>
      </form>
      {importantBox && !locked ? (
        <Check checked={important} onChange={setImportant}>
          Important: email everyone now
          <span className="help">
            {notifications.activityEmails
              ? "Use it rarely. It skips the summary and emails every athlete right away."
              : "Emails are off for now, so this only marks the post as important."}
          </span>
        </Check>
      ) : null}
      <span id="composer-hint" className="note">
        {locked ? (
          lockedNote
        ) : (
          <>
            {tooLong ? `Too long by ${body.length - MAX_BODY} characters. ` : ""}
            {hint ? `${hint} ` : ""}
            {mentions ? "Type @ to mention someone. " : ""}Enter sends. Shift+Enter adds a line.
          </>
        )}
      </span>
    </div>
  );
}

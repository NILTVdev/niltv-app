/**
 * A pick-one box you can type in or scroll through. The list opens on focus
 * showing everything, and typing narrows it. It renders into <main> at fixed
 * coordinates so a clipped table row cannot cut it off, and it keeps the
 * white look <main> sets.
 */
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ComboOption, matchOptions } from "../lib/combo";

const GAP = 4;
const MAX_HEIGHT = 260;
const MIN_ROOM = 150;

interface Place {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function ComboBox({
  id,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboOption[];
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);

  const label = options.find((o) => o.value === value)?.label ?? value;
  const list = matchOptions(options, query ?? "");
  const listId = `${id}-list`;

  const close = () => {
    setOpen(false);
    setQuery(null);
  };

  const pick = (option: ComboOption) => {
    onChange(option.value);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = inputRef.current?.getBoundingClientRect();
      if (!box) return;
      const view = window.visualViewport?.height ?? window.innerHeight;
      const below = view - box.bottom - GAP * 2;
      const above = box.top - GAP * 2;
      setPlace(
        below >= MIN_ROOM || below >= above
          ? { left: box.left, width: box.width, top: box.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) }
          : { left: box.left, width: box.width, bottom: window.innerHeight - box.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) },
      );
    };
    measure();
    // The page moved under a fixed list: follow it. The list's own scroll is not that.
    const onScroll = (e: Event) => {
      if (e.target !== listRef.current) measure();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (list.length ? (i + step + list.length) % list.length : 0));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      const option = list[active];
      if (option) pick(option);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  };

  const host = typeof document === "undefined" ? null : (document.querySelector("main") ?? document.body);

  return (
    <div className="combo">
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && list[active] ? `${id}-o${active}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={query ?? label}
        onFocus={(e) => {
          e.target.select();
          setActive(Math.max(0, options.findIndex((o) => o.value === value)));
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKey}
        onBlur={close}
      />
      {open && place && host
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              className="combo-list"
              style={place}
              // Keep focus in the box, so a tap or a scrollbar drag does not close the list first.
              onMouseDown={(e) => e.preventDefault()}
            >
              {list.length === 0 ? <li className="combo-none">No matches</li> : null}
              {list.map((o, i) => (
                <li
                  key={o.value}
                  id={`${id}-o${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-picked={o.value === value || undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  {o.label}
                </li>
              ))}
            </ul>,
            host,
          )
        : null}
    </div>
  );
}

/**
 * The frame around every screen: sidebar on desktop; on phones a top bar,
 * a bottom tab bar and a More sheet for the rest of the menu.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { campusName } from "../lib/format";
import { type NavItem, type Screen, moreItems, navFor } from "../lib/nav";
import { pathFor } from "../lib/router";
import { Avatar } from "./bits";
import { Mark } from "./Brand";
import { Icon, type IconName } from "./Icon";
import { Link } from "./Link";
import { useMe } from "./me";

const ICON: Record<Screen, IconName> = {
  home: "home",
  hub: "hub",
  messages: "messages",
  schedule: "schedule",
  postings: "postings",
  posts: "posts",
  page: "page",
  payments: "payments",
  account: "account",
  refer: "refer",
  help: "help",
  athletes: "athletes",
  guests: "guests",
  requests: "requests",
  payouts: "payouts",
  access: "access",
};

export function Shell({ screen, children }: { screen: Screen; children: ReactNode }) {
  const { member, unread } = useMe();
  const nav = navFor(member.role);
  const extra = moreItems(member.role);
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstScreen = useRef(true);

  // A new screen: close the sheet, start at the top, move focus to the content.
  useEffect(() => {
    setMoreOpen(false);
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [screen]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMoreOpen(false);
        moreBtnRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!sheetRef.current?.contains(target) && !moreBtnRef.current?.contains(target)) setMoreOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [moreOpen]);

  const badge = (key: Screen) =>
    key === "messages" && unread > 0 ? (
      <>
        <span className="badge hot" aria-hidden="true">
          {unread > 99 ? "99+" : unread}
        </span>
        <span className="sr-only">, {unread} unread</span>
      </>
    ) : null;

  const navLink = (i: NavItem) => (
    <Link key={i.key} to={pathFor(i.key)} aria-current={screen === i.key ? "page" : undefined}>
      <Icon name={ICON[i.key]} />
      <span className="lab">{i.label}</span>
      {badge(i.key)}
    </Link>
  );

  const role = member.role;
  const sub =
    role === "athlete"
      ? [campusName(member.campus), member.sport].filter(Boolean).join(" · ") || "Athlete"
      : role === "guest"
        ? member.note
          ? `Guest · ${member.note}`
          : "Guest"
        : `${role === "admin" ? "Admin" : "Staff"} · NIL TV team`;

  const bottomItems = nav.bottom
    .map((k) => [...nav.groups.flatMap((g) => g.items), ...nav.footer].find((i) => i.key === k))
    .filter((i): i is NavItem => Boolean(i));
  const moreActive = extra.some((i) => i.key === screen);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="mtop">
        <Mark />
        <Link to={pathFor("account")} className="avlink" aria-label={role === "guest" ? "Profile" : "Account"}>
          <Avatar name={member.name} role={role} />
        </Link>
      </div>
      <div className="shell">
        <aside className="side">
          <Mark />
          <div className="me">
            <Avatar name={member.name} role={role} />
            <div>
              <div className="t">{member.name}</div>
              <div className="s">{sub}</div>
            </div>
          </div>
          <nav className="nav" aria-label="Main">
            {nav.groups.map((g, gi) => (
              <div key={g.title ?? `g${gi}`} style={{ display: "contents" }}>
                {g.title ? <div className="grp">{g.title}</div> : null}
                {g.items.map(navLink)}
              </div>
            ))}
          </nav>
          {nav.footer.length ? (
            <nav className="navfoot" aria-label="More">
              {nav.footer.map(navLink)}
            </nav>
          ) : null}
        </aside>
        <main id="main" ref={mainRef} tabIndex={-1}>
          {children}
        </main>
      </div>
      {moreOpen ? (
        <div className="sheet" id="more-sheet" ref={sheetRef}>
          {extra.map(navLink)}
        </div>
      ) : null}
      <nav className="bnav" aria-label="Tabs">
        {bottomItems.map((i) => (
          <Link key={i.key} to={pathFor(i.key)} aria-current={screen === i.key && !moreOpen ? "page" : undefined}>
            <Icon name={ICON[i.key]} size={22} />
            <span>{i.short}</span>
            {i.key === "messages" && unread > 0 ? (
              <>
                <span className="bdot" aria-hidden="true">
                  {unread > 99 ? "99+" : unread}
                </span>
                <span className="sr-only">, {unread} unread</span>
              </>
            ) : null}
          </Link>
        ))}
        {extra.length ? (
          <button
            ref={moreBtnRef}
            type="button"
            aria-expanded={moreOpen}
            aria-controls="more-sheet"
            aria-current={moreActive && !moreOpen ? "page" : undefined}
            onClick={() => setMoreOpen((o) => !o)}
          >
            <Icon name="more" size={22} />
            <span>More</span>
          </button>
        ) : null}
      </nav>
    </>
  );
}

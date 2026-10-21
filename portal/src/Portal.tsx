/**
 * The signed-in portal: reads the path, refuses screens the role may not
 * open (same permission table as the server), and renders the screen in
 * the shell. Screens load on demand so staff-only code stays out of the
 * athlete's first load. The unread count rides in the tab title and on
 * the installed app's icon.
 */
import { type ComponentType, lazy, Suspense, useEffect } from "react";
import { unreadTitle } from "./lib/format";
import { canOpen, navItem, type Screen, startScreen } from "./lib/nav";
import { showAppBadge } from "./lib/push";
import { go, parsePath, usePathname } from "./lib/router";
import { Empty, Loading } from "./ui/bits";
import { useMe } from "./ui/me";
import { Shell } from "./ui/Shell";
import { usePushSetup } from "./ui/usePush";

export interface ScreenProps {
  /** the id segment of a deep link (/messages/{id}) */
  id?: string;
}

const screen = <K extends string>(load: () => Promise<Record<K, ComponentType<ScreenProps>>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));

const SCREENS: Record<Screen, ComponentType<ScreenProps>> = {
  home: screen(() => import("./screens/Home"), "Home"),
  hub: screen(() => import("./screens/ContentHub"), "ContentHub"),
  messages: screen(() => import("./screens/Messages"), "Messages"),
  schedule: screen(() => import("./screens/Schedule"), "Schedule"),
  postings: screen(() => import("./screens/Postings"), "Postings"),
  posts: screen(() => import("./screens/MyPosts"), "MyPosts"),
  page: screen(() => import("./screens/MyPage"), "MyPage"),
  payments: screen(() => import("./screens/Payments"), "Payments"),
  account: screen(() => import("./screens/Account"), "Account"),
  refer: screen(() => import("./screens/Refer"), "Refer"),
  help: screen(() => import("./screens/Help"), "Help"),
  athletes: screen(() => import("./screens/Athletes"), "Athletes"),
  guests: screen(() => import("./screens/Guests"), "Guests"),
  requests: screen(() => import("./screens/Requests"), "Requests"),
  payouts: screen(() => import("./screens/Payouts"), "Payouts"),
  access: screen(() => import("./screens/Team"), "Team"),
};

export function Portal() {
  const { member, unread } = useMe();
  const role = member.role;
  const route = parsePath(usePathname());
  const start = startScreen(role);
  // Unknown paths, and Home for a guest, go to the role's start screen.
  const redirect = route.screen === null || (route.screen === "home" && !canOpen(role, "home"));
  const current: Screen = redirect || !route.screen ? start : route.screen;
  const allowed = canOpen(role, current);

  useEffect(() => {
    if (redirect) go(start, undefined, { replace: true });
  }, [redirect, start]);

  const label = navItem(role, current)?.label ?? "Portal";
  useEffect(() => {
    document.title = unreadTitle(`${label} | NIL TV Portal`, unread);
  }, [label, unread]);

  useEffect(() => showAppBadge(unread), [unread]);
  // Signed out: no count left on the icon.
  useEffect(() => () => showAppBadge(0), []);
  usePushSetup();

  const View = SCREENS[current];
  return (
    <Shell screen={current}>
      {allowed ? (
        <Suspense fallback={<Loading />}>
          <View key={current} id={redirect ? undefined : route.id} />
        </Suspense>
      ) : (
        <>
          <header className="head">
            <h1>Not available</h1>
          </header>
          <Empty>Your role does not include this page. Use the menu to pick another one.</Empty>
        </>
      )}
    </Shell>
  );
}

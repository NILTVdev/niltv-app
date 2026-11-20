/**
 * Navigation by role, exactly as the approved mockup lays it out, then
 * filtered through PORTAL_PERMISSIONS (portalCan) so the menu and the
 * route guard read the same table as the server.
 */
import { type PortalPermission, type PortalRole, portalCan } from "@niltv/types";

export type Screen =
  | "home"
  | "hub"
  | "messages"
  | "schedule"
  | "postings"
  | "posts"
  | "page"
  | "payments"
  | "account"
  | "refer"
  | "help"
  | "athletes"
  | "guests"
  | "requests"
  | "payouts"
  | "access";

export interface NavItem {
  key: Screen;
  label: string;
  /** label under the icon in the phone tab bar */
  short: string;
}

export interface NavGroup {
  title: string | null;
  items: NavItem[];
}

export interface RoleNav {
  groups: NavGroup[];
  footer: NavItem[];
  /** the phone tab bar; anything else lands under More */
  bottom: Screen[];
}

/** Screens whose access maps to one permission in the contract table. */
export const SCREEN_PERMISSION: Partial<Record<Screen, PortalPermission>> = {
  hub: "viewHub",
  postings: "viewPostings",
  posts: "athleteTools",
  page: "requestPageChange",
  payments: "athleteTools",
  refer: "athleteTools",
  athletes: "viewRoster",
  guests: "manageGuests",
  requests: "manageRequests",
  payouts: "viewPayouts",
  access: "manageAccess",
};

const item = (key: Screen, label: string, short = label): NavItem => ({ key, label, short });

const HOME = item("home", "Home");
const HUB = item("hub", "Content Hub", "Hub");
const MESSAGES = item("messages", "Messages");
const SCHEDULE = item("schedule", "Schedule");
const POSTINGS = item("postings", "Internal Postings", "Postings");
const ACCOUNT = item("account", "Account");

function baseNav(role: PortalRole): RoleNav {
  switch (role) {
    case "athlete":
      return {
        groups: [
          { title: null, items: [HOME, HUB, MESSAGES, SCHEDULE, POSTINGS] },
          {
            title: "You",
            items: [item("posts", "My posts"), item("page", "My athlete page", "My page"), item("payments", "Payments"), ACCOUNT],
          },
        ],
        footer: [item("refer", "Refer friends", "Refer"), item("help", "Help")],
        bottom: ["home", "hub", "messages", "schedule"],
      };
    case "guest":
      return {
        groups: [{ title: null, items: [MESSAGES, SCHEDULE, item("account", "Profile")] }],
        footer: [item("help", "Help")],
        bottom: ["messages", "schedule", "account", "help"],
      };
    case "staff":
    case "admin": {
      const groups: NavGroup[] = [
        {
          title: null,
          items: [
            HOME,
            HUB,
            MESSAGES,
            SCHEDULE,
            POSTINGS,
            item("athletes", "Athletes"),
            item("guests", "Guests"),
            item("requests", "Requests"),
          ],
        },
      ];
      if (role === "admin") {
        groups.push({ title: "Admin", items: [item("payouts", "Payouts"), item("access", "Team & access", "Team")] });
      }
      groups.push({ title: "You", items: [ACCOUNT] });
      return { groups, footer: [], bottom: ["home", "hub", "messages", "schedule"] };
    }
  }
}

const allowed = (role: PortalRole, key: Screen): boolean => {
  const permission = SCREEN_PERMISSION[key];
  return permission ? portalCan(role, permission) : true;
};

export function navFor(role: PortalRole): RoleNav {
  const nav = baseNav(role);
  const groups = nav.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed(role, i.key)) }))
    .filter((g) => g.items.length > 0);
  const footer = nav.footer.filter((i) => allowed(role, i.key));
  const visible = new Set([...groups.flatMap((g) => g.items), ...footer].map((i) => i.key));
  return { groups, footer, bottom: nav.bottom.filter((k) => visible.has(k)) };
}

/** Every screen this role may open: on its menu, and allowed by the permission table. */
export function screensFor(role: PortalRole): Set<Screen> {
  const nav = navFor(role);
  return new Set([...nav.groups.flatMap((g) => g.items), ...nav.footer].map((i) => i.key));
}

export const canOpen = (role: PortalRole, screen: Screen): boolean => screensFor(role).has(screen);

/** Where a role lands: Home, except guests, who have no Home. */
export const startScreen = (role: PortalRole): Screen => (role === "guest" ? "messages" : "home");

/** Menu items that are not in the tab bar: the phone's More sheet. */
export function moreItems(role: PortalRole): NavItem[] {
  const nav = navFor(role);
  const bottom = new Set(nav.bottom);
  return [...nav.groups.flatMap((g) => g.items), ...nav.footer].filter((i) => !bottom.has(i.key));
}

/** The menu entry for a screen (for labels). */
export function navItem(role: PortalRole, key: Screen): NavItem | undefined {
  const nav = navFor(role);
  return [...nav.groups.flatMap((g) => g.items), ...nav.footer].find((i) => i.key === key);
}

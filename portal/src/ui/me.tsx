/** The signed-in member, their time zone and sign-out, for every screen. */
import { type PortalMember, type PortalPermission, portalCan } from "@niltv/types";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { browserZone, validZone } from "../lib/time";

export interface MeValue {
  member: PortalMember;
  unread: number;
  /** the zone every time renders in: the account setting, else the browser */
  zone: string;
  can: (permission: PortalPermission) => boolean;
  signOut: () => void;
}

const MeContext = createContext<MeValue | null>(null);

export function MeProvider({
  member,
  unread,
  signOut,
  children,
}: {
  member: PortalMember;
  unread: number;
  signOut: () => void;
  children: ReactNode;
}) {
  const value = useMemo<MeValue>(
    () => ({
      member,
      unread,
      zone: validZone(member.timezone, browserZone()),
      can: (permission) => portalCan(member.role, permission),
      signOut,
    }),
    [member, unread, signOut],
  );
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeValue {
  const value = useContext(MeContext);
  if (!value) throw new Error("useMe outside MeProvider");
  return value;
}

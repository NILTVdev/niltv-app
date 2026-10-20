/** Schedule: staff manage events; everyone else answers polls, RSVPs and sets availability. */
import type { ScreenProps } from "../Portal";
import { useMe } from "../ui/me";
import { MemberSchedule } from "./schedule/MemberSchedule";
import { StaffSchedule } from "./schedule/StaffSchedule";

export function Schedule({ id }: ScreenProps) {
  const { can } = useMe();
  return can("manageEvents") ? <StaffSchedule id={id} /> : <MemberSchedule id={id} />;
}

/** Line icons from the approved mockup (24px grid, stroke = currentColor). */
const PATHS = {
  home: "M3 10.5 12 3l9 7.5V21H3z M9 21v-6h6v6",
  hub: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  messages: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  schedule: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  postings: "M3 7h18v13H3z M9 7V4h6v3 M3 13h18",
  posts: "M5 3h14v18H5z M10 9l5 3-5 3z",
  page: "M4 4h16v16H4z M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M7 18c1-3 3-4 5-4s4 1 5 4",
  payments: "M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6",
  athletes: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21c1-4 4-6 7-6s6 2 7 6 M16 3a4 4 0 0 1 0 8 M22 21c-.5-2.5-2-4.5-4-5.5",
  guests: "M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21c1-4 4-6 8-6s7 2 8 6 M19 8v6 M16 11h6",
  requests: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  payouts: "M3 10h18 M12 3l9 5H3z M5 10v8 M9.5 10v8 M14.5 10v8 M19 10v8 M3 21h18",
  access: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  refer: "M7 17L17 7 M9 7h8v8",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7 M12 17h.01",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  back: "M15 18l-6-6 6-6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

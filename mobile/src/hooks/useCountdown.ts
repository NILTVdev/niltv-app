import { useEffect, useState } from "react";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Client-side ticking countdown to an ISO timestamp (design §3.2: server sends
 * endsAt, the client renders the clock — no polling for time). Ticks every
 * second while `endsAt` is set; returns null when unset/invalid, "0m 00s"-style
 * text otherwise ("Ended" once past).
 */
export function useCountdown(endsAt?: string): string | null {
  const target = endsAt ? new Date(endsAt).getTime() : Number.NaN;
  const active = !Number.isNaN(target);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // First tick lands async (setState in an effect body must stay out of the
    // render commit); the interval then keeps the clock honest every second.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active, target]);

  if (!active) return null;
  const remainingMs = target - now;
  if (remainingMs <= 0) return "Ended";

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

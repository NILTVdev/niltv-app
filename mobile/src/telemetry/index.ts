/**
 * Telemetry client (design §11): a tiny in-memory queue batched to
 * POST /v1/telemetry. Flushes when 10 events are queued, every 15s, or when
 * the app backgrounds. Fire-and-forget by design — failures are swallowed and
 * the batch is dropped (never retried, never surfaced): analytics must never
 * cost the user a spinner or an error state.
 *
 * The request layer attaches the ID token opportunistically, so events are
 * user-attributed when signed in and anonymous otherwise (the endpoint
 * accepts both).
 */
import type { TelemetryBatchRequest, TelemetryEvent } from "@niltv/types";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { Anything, request } from "@/api/client";

const FLUSH_AT = 10;
const FLUSH_INTERVAL_MS = 15_000;
/** Contract cap (TelemetryBatchRequest.events.max(100)). */
const MAX_BATCH = 100;

let queue: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Queue one event. Never throws; safe to call from render-adjacent code. */
export function track(type: string, props: Record<string, unknown> = {}): void {
  queue.push({ type, ts: new Date().toISOString(), props });
  if (queue.length >= FLUSH_AT) {
    void flush();
  } else if (timer === null) {
    timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  }
}

/** Drain the queue into one batched POST. Silent on failure (batch dropped). */
export async function flush(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const events = queue.splice(0, MAX_BATCH);
  const body: TelemetryBatchRequest = { events };
  try {
    await request("/v1/telemetry", Anything, { method: "POST", body });
  } catch {
    // Telemetry is best-effort: drop the batch, never surface, never block.
  }
  // Anything left (burst past 100) rides the next tick/flush trigger.
  if (queue.length > 0 && timer === null) {
    timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  }
}

// Flush pending events when the app leaves the foreground.
AppState.addEventListener("change", (state) => {
  if (state === "background" || state === "inactive") void flush();
});

/**
 * Fire a `screen_view` each time a screen gains navigation focus (initial
 * mount and back-navigation returns). Extra props are read at focus time.
 */
export function useScreenView(screen: string, props?: Record<string, unknown>): void {
  const propsRef = useRef(props);
  // Ref updated in an effect (not during render) so the compiler stays happy;
  // effects run before the focus callback fires, so the value is fresh.
  useEffect(() => {
    propsRef.current = props;
  });
  useFocusEffect(
    useCallback(() => {
      track("screen_view", { screen, ...propsRef.current });
    }, [screen]),
  );
}

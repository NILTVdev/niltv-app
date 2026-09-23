/**
 * Per-view milestone gating for the vertical video feed.
 *
 * Every page inside the feed's render window owns its own `expo-video` player,
 * and neighbours are deliberately preloaded (active ± 1) so a swipe starts
 * instantly. A preloaded neighbour is supposed to stay paused, but it does not
 * always get there silently: on web the element can autoplay muted for a frame
 * before `pause()` lands, which emits a real `playingChange(isPlaying: true)`
 * from a page the viewer has never seen.
 *
 * Ungated, opening one clip reports `video_start` for its *neighbour*, then
 * a second `video_start` for that same neighbour when the viewer actually
 * swipes to it. Starts land on the wrong clip and roughly double-count. These
 * numbers feed the view analytics, so the gate is deliberately strict:
 *
 *   1. only the active page may emit at all, and
 *   2. each milestone type emits at most once per view.
 *
 * The set is emptied when a page goes INACTIVE rather than when it becomes
 * active. Clearing on entry would race the player events that arrive
 * immediately after activation and could drop a legitimate `video_start`;
 * clearing on exit means a page is always already clean by the time it counts.
 */
export interface MilestoneGate {
  /**
   * Claim a milestone. Returns true exactly once per view per type, and only
   * while the page is the active one.
   */
  allow(active: boolean, type: string): boolean;
  /** Forget this view's milestones — called when the page stops being active. */
  reset(): void;
}

export function createMilestoneGate(): MilestoneGate {
  const fired = new Set<string>();
  return {
    allow(active, type) {
      if (!active) return false;
      if (fired.has(type)) return false;
      fired.add(type);
      return true;
    },
    reset() {
      fired.clear();
    },
  };
}

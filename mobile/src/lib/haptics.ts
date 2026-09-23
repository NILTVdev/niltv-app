/**
 * Haptics are OFF (silent app). Android maps selection
 * feedback to a coarse motor buzz, so tab switches and feed scrolls would
 * buzz on every touch. All touch feedback is disabled at the source; the call sites
 * keep the vocabulary (select / impact / success / error), so re-enabling is
 * a one-file revert of this module to its expo-haptics implementation.
 */

export function hapticSelect(): void {
  // silent
}

export function hapticImpact(): void {
  // silent
}

export function hapticSuccess(): void {
  // silent
}

export function hapticError(): void {
  // silent
}

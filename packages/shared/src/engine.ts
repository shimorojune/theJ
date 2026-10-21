import type { Button, Vibe } from "./schemas";

const BUTTON_DELTA: Record<Button, Vibe> = {
  hype: { energy: 0.2, valence: 0 },
  chill: { energy: -0.2, valence: 0 },
  brighter: { energy: 0, valence: 0.2 },
  moodier: { energy: 0, valence: -0.2 },
};

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** A button tap moves the goal. */
export function applyButton(goal: Vibe, button: Button): Vibe {
  const d = BUTTON_DELTA[button];
  return { energy: clamp(goal.energy + d.energy), valence: clamp(goal.valence + d.valence) };
}

/** Each played song moves the target one step toward the goal, so changes ramp gradually. */
export function stepToward(target: Vibe, goal: Vibe, step = 0.08): Vibe {
  const move = (from: number, to: number) =>
    Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step;
  return { energy: move(target.energy, goal.energy), valence: move(target.valence, goal.valence) };
}

/** Distance between a track and the target. Lower is a better fit. */
export function vibeDistance(a: Vibe, b: Vibe): number {
  return Math.hypot(a.energy - b.energy, a.valence - b.valence);
}

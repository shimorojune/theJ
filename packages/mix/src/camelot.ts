/** Keys on the Camelot wheel: neighbours (same number, or one step round) mix without clashing. */

const PITCH: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

export type Camelot = { n: number; letter: "A" | "B" };

/** "Eb" + "minor" → 2A. Null for a key the analyser didn't give. */
export function camelot(key?: string | null, scale?: string | null): Camelot | null {
  const pc = key ? PITCH[key] : undefined;
  if (pc == null || !scale) return null;
  const minor = scale.startsWith("min");
  // Majors run up the wheel in fifths from C = 8B; a minor sits with its relative major.
  const major = minor ? (pc + 3) % 12 : pc;
  return { n: ((((major * 7) % 12) + 7) % 12) + 1, letter: minor ? "A" : "B" };
}

export const camelotLabel = (c: Camelot | null) => (c ? `${c.n}${c.letter}` : "?");

/**
 * Steps between two keys on the wheel: 0 same key, 1 a neighbour (one round, or the relative
 * major/minor), more is a clash a DJ would avoid mixing across a long overlap.
 */
export function keySteps(a: Camelot, b: Camelot): number {
  const round = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  return round + (a.letter === b.letter ? 0 : 1);
}

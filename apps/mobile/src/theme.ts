/** Tokens from the design canvas (Now playing, direction A). */
export const c = {
  bg: "#0B0B0C",
  fg: "#F2F2F0",
  fg2: "#CFCFD2",
  muted: "#A8A8AE",
  dim: "#8A8A90",
  faint: "#6E6E75",
  warm: "#B3A8A0",
  accent: "#E6B85C",
  surface: "#151517",
  card: "rgba(255,255,255,0.07)",
  track: "rgba(255,255,255,0.14)",
  line: "#2A2A2E",
};

export const font = { regular: "400", medium: "500", semibold: "600" } as const;

/** Starting-vibe tiles: label, hint, colour, and where they put energy / valence. */
export const VIBES = [
  {
    id: "warm",
    label: "Warming up",
    hint: "Easy, upbeat, familiar",
    bg: "#7A5236",
    vibe: { energy: 0.55, valence: 0.65 },
  },
  {
    id: "dinner",
    label: "Dinner",
    hint: "Soft, mostly acoustic",
    bg: "#4E6B44",
    vibe: { energy: 0.3, valence: 0.55 },
  },
  {
    id: "floor",
    label: "Dance floor",
    hint: "High energy, big hooks",
    bg: "#8A3F3A",
    vibe: { energy: 0.85, valence: 0.75 },
  },
  {
    id: "late",
    label: "After hours",
    hint: "Deeper, moodier",
    bg: "#5B4A8A",
    vibe: { energy: 0.6, valence: 0.3 },
  },
  {
    id: "hang",
    label: "Hangout",
    hint: "Chill, conversational",
    bg: "#2F5A6B",
    vibe: { energy: 0.4, valence: 0.5 },
  },
  {
    id: "sing",
    label: "Singalong",
    hint: "Everyone knows the words",
    bg: "#7A6A3A",
    vibe: { energy: 0.65, valence: 0.7 },
  },
] as const;

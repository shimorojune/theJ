import type { Vibe } from "@thej/shared";

export type Mood = {
  id: string;
  label: string;
  line: string;
  /** Words the server embeds to find songs; the label alone is too thin. */
  moodText: string;
  vibe: Vibe;
  bg: string;
};

/** The home moods. One tap starts one. */
export const MOODS: Mood[] = [
  {
    id: "dance",
    label: "Dance",
    line: "High energy, big hooks",
    moodText: "dance floor club bangers upbeat high energy party",
    vibe: { energy: 0.9, valence: 0.8 },
    bg: "#8A3F3A",
  },
  {
    id: "workout",
    label: "Workout",
    line: "Fast and hard, keeps you moving",
    moodText: "workout gym running pump up energetic powerful",
    vibe: { energy: 0.95, valence: 0.6 },
    bg: "#8F5420",
  },
  {
    id: "focus",
    label: "Focus",
    line: "Steady, light on vocals",
    moodText: "focus deep work study calm steady instrumental",
    vibe: { energy: 0.35, valence: 0.5 },
    bg: "#2F5A6B",
  },
  {
    id: "travel",
    label: "Travel",
    line: "Open road, windows down",
    moodText: "road trip travel driving journey feel good",
    vibe: { energy: 0.6, valence: 0.75 },
    bg: "#4E6B44",
  },
  {
    id: "sad",
    label: "Sad",
    line: "Slow, heartbroken, honest",
    moodText: "sad heartbreak melancholy emotional slow songs",
    vibe: { energy: 0.25, valence: 0.15 },
    bg: "#3D4A7A",
  },
  {
    id: "celebrate",
    label: "Celebrate",
    line: "Anthems, everyone joins in",
    moodText: "celebration party anthems festive wedding happy",
    vibe: { energy: 0.85, valence: 0.92 },
    bg: "#7A6A2E",
  },
  {
    id: "sleep",
    label: "Sleep",
    line: "Soft, slow, quiet",
    moodText: "sleep calm soft peaceful night ambient lullaby",
    vibe: { energy: 0.1, valence: 0.4 },
    bg: "#4A3D6B",
  },
];

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyButton,
  type Candidate,
  languageMix,
  rank,
  type ScoreContext,
  scoreCandidate,
  stepToward,
} from "./engine";

const ctx = (over: Partial<ScoreContext> = {}): ScoreContext => ({
  target: { energy: 0.5, valence: 0.5 },
  languages: ["en", "hi"],
  mix: { en: 0.5, hi: 0.5 },
  playedShare: {},
  inSession: new Set(),
  skipped: new Set(),
  heardRecently: new Set(),
  liked: new Set(),
  jitter: () => 0,
  ...over,
});
const t = (id: string, energy: number, valence: number, languages = ["en"]): Candidate => ({
  videoId: id.padEnd(11, "x"),
  energy,
  valence,
  languages,
  wordsPerMin: 80,
});

test("buttons move the goal and clamp", () => {
  assert.deepEqual(applyButton({ energy: 0.9, valence: 0.5 }, "hype"), { energy: 1, valence: 0.5 });
  assert.deepEqual(applyButton({ energy: 0.5, valence: 0.5 }, "moodier"), {
    energy: 0.5,
    valence: 0.3,
  });
});

test("target ramps toward the goal one step per song", () => {
  const goal = { energy: 0.9, valence: 0.5 };
  let target = { energy: 0.5, valence: 0.5 };
  const steps: number[] = [];
  while (target.energy !== goal.energy) {
    target = stepToward(target, goal);
    steps.push(Math.round(target.energy * 100) / 100);
  }
  assert.deepEqual(steps, [0.58, 0.66, 0.74, 0.82, 0.9]);
});

test("closest to target wins", () => {
  const ranked = rank([t("far", 0.9, 0.9), t("near", 0.52, 0.5), t("mid", 0.6, 0.6)], ctx(), 3);
  assert.deepEqual(
    ranked.map((c) => c.videoId.slice(0, 4)),
    ["near", "midx", "farx"],
  );
});

test("session repeats, recent skips and other languages are excluded", () => {
  const c = ctx({
    inSession: new Set([t("a", 0.5, 0.5).videoId]),
    skipped: new Set([t("b", 0.5, 0.5).videoId]),
    languages: ["en"],
  });
  assert.equal(scoreCandidate(t("a", 0.5, 0.5), c), Infinity);
  assert.equal(scoreCandidate(t("b", 0.5, 0.5), c), Infinity);
  assert.equal(scoreCandidate(t("c", 0.5, 0.5, ["ja"]), c), Infinity);
  assert.ok(Number.isFinite(scoreCandidate(t("d", 0.5, 0.5), c)));
});

test("an over-played language is nudged down", () => {
  const c = ctx({ playedShare: { hi: 0.8, en: 0.2 } });
  const ranked = rank([t("hindi", 0.5, 0.5, ["hi"]), t("eng", 0.55, 0.55, ["en"])], c, 2);
  assert.equal(ranked[0]?.videoId.slice(0, 3), "eng");
});

test("fewer lyrics prefers low words-per-minute", () => {
  const wordy = { ...t("wordy", 0.5, 0.5), wordsPerMin: 180 };
  const sparse = { ...t("sparse", 0.52, 0.5), wordsPerMin: 20 };
  assert.equal(
    rank([wordy, sparse], ctx({ fewerLyrics: true }), 1)[0]?.videoId.slice(0, 6),
    "sparse",
  );
});

test("language mix honours the Hindi share", () => {
  assert.deepEqual(languageMix(["en", "hi"], 0.7), { hi: 0.7, en: 0.30000000000000004 });
  assert.deepEqual(languageMix(["en"]), { en: 1 });
});

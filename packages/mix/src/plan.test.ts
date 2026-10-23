import assert from "node:assert/strict";
import { test } from "node:test";
import { camelot, camelotLabel, keySteps } from "./camelot";
import { MIX, MIX_HEADROOM, matchRate, onGrid, planHandOver, valueAt } from "./plan";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("classic hand-over: 16 beats in, bass swap, 8 out", () => {
  const h = planHandOver({ when: 10, plan: MIX, beat: 0.5, rate: 1.02, inOffset: 3, master: 1 });
  close(h.swap, 18);
  close(h.end, 22);
  assert.equal(h.stems, undefined);
  close(valueAt(h.incoming.gain, 14), 0.5);
  close(valueAt(h.outgoing?.gain ?? { steps: [] }, 20, 1), 0.5);
  close(valueAt(h.master ?? { steps: [] }, 15, 1), MIX_HEADROOM);
  assert.deepEqual(h.incoming.easeBack?.at, 22);
});

test("stem hand-over ends a beat later and leaves the incoming bass shelf alone", () => {
  const len = 60;
  const h = planHandOver({
    when: 10,
    plan: MIX,
    beat: 0.5,
    rate: 1,
    inOffset: 30,
    master: 1,
    stems: {
      now: 0,
      outPosAt: (t) => 100 + t,
      outRateAt: () => 1,
      outStart: 90,
      inStart: 20,
      outLengths: { vocals: len, bass: len, rest: len },
      inLengths: { drums: len, other: len, rest: len },
    },
  });
  close(h.end, 22.5);
  assert.ok(h.stems);
  close(h.stems.out.at, 9.5);
  close(h.stems.out.offset, 19.5);
  close(h.stems.in.offset, 10);
  assert.equal(h.incoming.bass.steps.length, 0);
});

test("stems that don't cover the mix fall back to the classic hand-over", () => {
  const h = planHandOver({
    when: 10,
    plan: MIX,
    beat: 0.5,
    rate: 1,
    inOffset: 30,
    master: 1,
    stems: {
      now: 0,
      outPosAt: (t) => 100 + t,
      outRateAt: () => 1,
      outStart: 90,
      inStart: 20,
      outLengths: { vocals: 5, bass: 5, rest: 5 },
      inLengths: { drums: 60, other: 60, rest: 60 },
    },
  });
  assert.equal(h.stems, undefined);
  close(h.end, 22);
});

test("tempo match allows half time and refuses big stretches", () => {
  close(matchRate(0.5, 1, 0.52), 1.04);
  close(matchRate(0.5, 1, 1.02), 1.02);
  assert.equal(matchRate(0.5, 1, 0.6), 1);
  close(onGrid(10, 2, 10.3), 12);
  close(onGrid(10, 2, 9.999999999), 10);
});

test("camelot wheel", () => {
  assert.equal(camelotLabel(camelot("C", "major")), "8B");
  assert.equal(camelotLabel(camelot("A", "minor")), "8A");
  assert.equal(camelotLabel(camelot("Eb", "minor")), "2A");
  assert.equal(camelotLabel(camelot("F", "major")), "7B");
  const c = camelot("C", "major");
  const g = camelot("G", "major");
  const fs = camelot("F#", "major");
  assert.ok(c && g && fs);
  assert.equal(keySteps(c, g), 1);
  assert.equal(keySteps(c, fs), 6);
});

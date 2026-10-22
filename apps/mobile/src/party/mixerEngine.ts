import {
  type AudioBuffer,
  type AudioBufferSourceNode,
  AudioContext,
  AudioManager,
  type BiquadFilterNode,
  type GainNode,
  PlaybackNotificationManager,
} from "react-native-audio-api";
import type { Song } from "../lib/types";
import type { Engine, EngineStatus, TrackChange } from "./engine";

/** How far ahead of the mix point the next song must be decoded. */
const PRELOAD_AHEAD_S = 90;
/**
 * A planned mix: the next song runs beat-matched under the current one with its bass cut for
 * IN beats, the bass swaps on a beat, and the current song drops out over OUT beats.
 */
const MIX = { in: 16, out: 8 };
/** A skip is the same move, just fast. */
const SKIP = { in: 2, out: 2 };
const MAX_TEMPO_STRETCH = 0.08;
/** The bass shelf each deck has: cut while a song is coming in, open once it owns the floor. */
const BASS_HZ = 180;
const BASS_CUT_DB = -18;

type Deck = {
  song: Song;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode;
  /** Low shelf: the bass swap is what makes two beat-matched songs sound like one. */
  filter: BiquadFilterNode;
  gain: GainNode;
  /** Context time at which `offset` of the buffer started playing. */
  startedAt: number;
  offset: number;
  rate: number;
  started: boolean;
};

/**
 * The DJ engine: two decks on one AudioContext. The next song is decoded ahead of time and
 * started on the current song's beat grid at its mix-out point, tempo-matched, bass cut; after
 * 16 beats the bass swaps and the current song drops out over 8. Then the new song's tempo eases
 * back to its own. Skips are the same move in a few beats, never silence.
 */
export class MixerEngine implements Engine {
  private ctx = new AudioContext();
  private master: GainNode;
  private current: Deck | null = null;
  private nextDeck: Deck | null = null;
  private queue: Song[] = [];
  private decoding = new Map<string, Promise<AudioBuffer>>();
  private mixTimer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private pausedAt = 0;
  private repeat = false;
  private statusCbs = new Set<(s: EngineStatus) => void>();
  private trackCbs = new Set<(c: TrackChange) => void>();
  private subs: { remove(): void }[] = [];

  constructor() {
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    AudioManager.setAudioSessionOptions({ iosCategory: "playback", iosMode: "default" });
    void AudioManager.setAudioSessionActivity(true);
    void AudioManager.requestNotificationPermissions().catch(() => {});
    const subs = [
      PlaybackNotificationManager.addEventListener("playbackNotificationPlay", () => this.play()),
      PlaybackNotificationManager.addEventListener("playbackNotificationPause", () => this.pause()),
      PlaybackNotificationManager.addEventListener("playbackNotificationNextTrack", () =>
        this.next("skip"),
      ),
    ];
    for (const sub of subs) if (sub) this.subs.push(sub);
    this.tick = setInterval(() => this.emitStatus(), 500);
  }

  // --- queue ---

  setQueue(list: Song[]) {
    this.queue = list;
    const curId = this.current?.song.songId;
    if (!curId || !list.some((s) => s.songId === curId)) {
      // Nothing playing, or the server replaced the current song: start fresh from the top.
      this.stopDeck(this.current, 0.3);
      this.current = null;
      this.cancelNext();
      const first = list[0];
      if (first) void this.playNow(first);
      return;
    }
    const after = list[list.indexOf(list.find((s) => s.songId === curId) as Song) + 1];
    if (!after) return this.cancelNext();
    if (this.nextDeck && this.nextDeck.song.songId !== after.songId) this.cancelNext();
    if (!this.nextDeck) void this.prepareNext(after);
  }

  next(reason: "skip" | "complete") {
    const cur = this.current;
    const after = cur
      ? this.queue[this.queue.findIndex((s) => s.songId === cur.song.songId) + 1]
      : this.queue[0];
    if (!after) return;
    void (async () => {
      const deck =
        this.nextDeck?.song.songId === after.songId ? this.nextDeck : await this.makeDeck(after);
      this.nextDeck = null;
      const when = this.onGrid(this.current, this.ctx.currentTime + 0.05, 1);
      this.mixInto(deck, when, SKIP, reason);
    })();
  }

  // --- decks ---

  private decode(song: Song): Promise<AudioBuffer> {
    let p = this.decoding.get(song.songId);
    if (!p) {
      p = this.ctx.decodeAudioData(song.audioUrl);
      this.decoding.set(song.songId, p);
      p.catch(() => this.decoding.delete(song.songId));
    }
    return p;
  }

  private async makeDeck(song: Song): Promise<Deck> {
    const buffer = await this.decode(song);
    const source = this.ctx.createBufferSource({ pitchCorrection: true });
    source.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowshelf";
    filter.frequency.value = BASS_HZ;
    filter.gain.value = 0;
    const gain = this.ctx.createGain();
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    return {
      song,
      buffer,
      source,
      filter,
      gain,
      startedAt: 0,
      offset: 0,
      rate: 1,
      started: false,
    };
  }

  private async playNow(song: Song) {
    const deck = await this.makeDeck(song);
    if (this.current) return; // something else started meanwhile
    deck.gain.gain.value = 1;
    this.startDeck(deck, this.ctx.currentTime + 0.05, 0, 1);
    this.current = deck;
    this.paused = false;
    this.announce(deck.song);
    for (const cb of this.trackCbs) cb({ from: null, to: song.songId, reason: "complete" });
    this.scheduleMix();
    const after = this.queue[this.queue.findIndex((s) => s.songId === song.songId) + 1];
    if (after) void this.prepareNext(after);
  }

  private startDeck(deck: Deck, when: number, offset: number, rate: number) {
    deck.source.playbackRate.setValueAtTime(rate, when);
    deck.source.start(when, offset);
    deck.startedAt = when;
    deck.offset = offset;
    deck.rate = rate;
    deck.started = true;
    deck.source.onEnded = () => {
      if (this.current === deck && !this.repeat) this.onCurrentEnded(deck);
    };
  }

  private stopDeck(deck: Deck | null, fadeS: number) {
    if (!deck?.started) {
      if (deck) this.decoding.delete(deck.song.songId);
      return;
    }
    const t = this.ctx.currentTime;
    deck.gain.gain.cancelScheduledValues(t);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, t);
    deck.gain.gain.linearRampToValueAtTime(0, t + fadeS);
    deck.source.onEnded = null;
    try {
      deck.source.stop(t + fadeS + 0.05);
    } catch {}
    setTimeout(() => this.decoding.delete(deck.song.songId), (fadeS + 1) * 1000);
  }

  private async prepareNext(song: Song) {
    const deck = await this.makeDeck(song);
    if (this.queue.some((s) => s.songId === song.songId) && !this.nextDeck) {
      this.nextDeck = deck;
      this.scheduleMix();
    }
  }

  private cancelNext() {
    if (this.nextDeck) {
      this.decoding.delete(this.nextDeck.song.songId);
      this.nextDeck = null;
    }
    clearTimeout(this.mixTimer);
    this.mixTimer = undefined;
  }

  // --- the mix ---

  /** Position of the current deck in its song, in seconds. */
  private position(deck: Deck): number {
    if (this.paused) return this.pausedAt;
    return deck.offset + (this.ctx.currentTime - deck.startedAt) * deck.rate;
  }

  /** Context time at which `deck` plays second `t` of its song (while its rate holds). */
  private atSongTime(deck: Deck, t: number): number {
    return deck.startedAt + (t - deck.offset) / deck.rate;
  }

  /** One beat of `deck` in context seconds. */
  private beatSeconds(deck: Deck | null, fallback: Song): number {
    const bpm = deck?.song.bpm || fallback.bpm || 100;
    return 60 / bpm / (deck?.rate ?? 1);
  }

  /**
   * The first point at or after `earliest` on the current song's beat grid, counted in groups
   * of `beats` from its mix-out beat. Without a beat grid, `earliest` itself.
   */
  private onGrid(cur: Deck | null, earliest: number, beats: number): number {
    if (!cur?.song.bpm || cur.song.mixOutS == null || this.paused) return earliest;
    const anchor = this.atSongTime(cur, cur.song.mixOutS);
    const period = this.beatSeconds(cur, cur.song) * beats;
    return anchor + Math.ceil((earliest - anchor) / period - 1e-6) * period;
  }

  /** Arm a timer for the current song's mix-out point once the next deck is decoded. */
  private scheduleMix() {
    clearTimeout(this.mixTimer);
    const cur = this.current;
    const nxt = this.nextDeck;
    if (!cur || !nxt || this.paused || this.repeat) return;
    const mixOut = cur.song.mixOutS ?? cur.buffer.duration - 8;
    const inS = Math.max(0.2, (mixOut - this.position(cur)) / cur.rate - 0.3);
    this.mixTimer = setTimeout(() => {
      if (this.current !== cur || this.nextDeck !== nxt) return;
      this.nextDeck = null;
      // Exactly the mix-out beat, or the next bar if we are late.
      const when = this.onGrid(cur, this.ctx.currentTime + 0.05, 4);
      this.mixInto(nxt, when, MIX, "complete");
    }, inS * 1000);
  }

  /**
   * Bring `deck` in at `when` on the current deck's beat grid, tempo-matched, bass cut. After
   * `plan.in` beats the bass swaps and the current deck drops out over `plan.out` beats.
   */
  private mixInto(
    deck: Deck,
    when: number,
    plan: { in: number; out: number },
    reason: "skip" | "complete",
  ) {
    const cur = this.current;
    const from = cur?.song.songId ?? null;
    let rate = 1;
    if (cur?.song.bpm && deck.song.bpm) {
      const r = (cur.song.bpm * cur.rate) / deck.song.bpm;
      const candidates = [r, r / 2, r * 2];
      const best = candidates.reduce((p, c) => (Math.abs(c - 1) < Math.abs(p - 1) ? c : p), r);
      if (Math.abs(best - 1) <= MAX_TEMPO_STRETCH) rate = best;
    }
    const beat = this.beatSeconds(cur, deck.song);
    const inS = Math.min(14, plan.in * beat);
    const outS = Math.min(8, plan.out * beat);
    const swap = when + inS;
    const end = swap + outS;

    deck.filter.gain.setValueAtTime(BASS_CUT_DB, when);
    deck.filter.gain.linearRampToValueAtTime(0, swap + beat);
    deck.gain.gain.setValueAtTime(0, when);
    deck.gain.gain.linearRampToValueAtTime(1, swap);
    this.startDeck(deck, when, deck.song.mixInS ?? 0, rate);
    // Ease back to the song's own tempo over 20 s once it owns the floor.
    if (rate !== 1) {
      deck.source.playbackRate.setValueAtTime(rate, end);
      deck.source.playbackRate.linearRampToValueAtTime(1, end + 20);
    }
    if (cur) {
      cur.filter.gain.setValueAtTime(0, swap);
      cur.filter.gain.linearRampToValueAtTime(BASS_CUT_DB, swap + beat);
      cur.gain.gain.cancelScheduledValues(when);
      cur.gain.gain.setValueAtTime(1, swap);
      cur.gain.gain.linearRampToValueAtTime(0, end);
      cur.source.onEnded = null;
      try {
        cur.source.stop(end + 0.1);
      } catch {}
      setTimeout(() => this.decoding.delete(cur.song.songId), (end - when + 2) * 1000);
    }
    this.current = deck;
    this.paused = false;
    // Rate drifts back to 1 after the mix; track it for position maths.
    setTimeout(
      () => {
        if (this.current === deck) {
          deck.offset = this.position(deck);
          deck.startedAt = this.ctx.currentTime;
          deck.rate = 1;
        }
      },
      (end - this.ctx.currentTime + 20) * 1000,
    );
    this.announce(deck.song);
    for (const cb of this.trackCbs) cb({ from, to: deck.song.songId, reason });
    const after = this.queue[this.queue.findIndex((s) => s.songId === deck.song.songId) + 1];
    if (after) void this.prepareNext(after);
  }

  private onCurrentEnded(deck: Deck) {
    // Ran out without a next deck ready: tell the party so the server refills.
    if (this.current !== deck) return;
    this.current = null;
    for (const cb of this.trackCbs) cb({ from: deck.song.songId, to: null, reason: "complete" });
  }

  // --- transport ---

  play() {
    if (!this.paused) return;
    this.paused = false;
    void this.ctx.resume();
    if (this.current) {
      this.current.startedAt = this.ctx.currentTime;
      this.current.offset = this.pausedAt;
    }
    this.scheduleMix();
    this.announce(this.current?.song);
  }
  pause() {
    if (this.paused || !this.current) return;
    this.pausedAt = this.position(this.current);
    this.paused = true;
    clearTimeout(this.mixTimer);
    void this.ctx.suspend();
    this.announce(this.current.song);
  }
  seek(seconds: number) {
    const cur = this.current;
    if (!cur) return;
    // A buffer source can't seek: swap in a fresh source at the new offset.
    const fresh = this.ctx.createBufferSource({ pitchCorrection: true });
    fresh.buffer = cur.buffer;
    fresh.connect(cur.gain);
    cur.source.onEnded = null;
    try {
      cur.source.stop();
    } catch {}
    cur.source = fresh;
    cur.started = false;
    this.startDeck(cur, this.ctx.currentTime + 0.02, Math.max(0, seconds), 1);
    if (this.paused) {
      this.pausedAt = seconds;
      void this.ctx.suspend();
    }
    this.scheduleMix();
  }
  restart() {
    this.seek(0);
  }
  setRepeat(on: boolean) {
    this.repeat = on;
    if (this.current) {
      this.current.source.loop = on;
    }
    if (on) clearTimeout(this.mixTimer);
    else this.scheduleMix();
  }
  clear() {
    clearTimeout(this.mixTimer);
    this.stopDeck(this.current, 0.2);
    this.cancelNext();
    this.current = null;
    this.queue = [];
  }
  destroy() {
    clearInterval(this.tick);
    this.clear();
    for (const s of this.subs) s.remove();
    void this.ctx.close();
  }

  // --- reporting ---

  private notified = false;
  private announce(song: Song | undefined) {
    if (!song) return;
    void (async () => {
      await PlaybackNotificationManager.show({
        title: song.title,
        artist: song.artist,
        artwork: song.thumbUrl,
        duration: this.current?.buffer.duration ?? song.durationS,
        elapsedTime: this.current ? this.position(this.current) : 0,
        state: this.paused ? "paused" : "playing",
      });
      if (!this.notified) {
        // Controls can only be enabled once a notification exists.
        this.notified = true;
        for (const c of ["play", "pause", "nextTrack"] as const) {
          await PlaybackNotificationManager.enableControl(c, true);
        }
      }
    })().catch(() => {});
  }

  private emitStatus() {
    const cur = this.current;
    const status: EngineStatus = {
      current: cur?.song.songId ?? null,
      playing: Boolean(cur) && !this.paused,
      buffering: Boolean(this.queue[0]) && !cur,
      currentTime: cur ? this.position(cur) : 0,
      duration: cur?.buffer.duration ?? 0,
    };
    for (const cb of this.statusCbs) cb(status);
  }
  onStatus(cb: (s: EngineStatus) => void) {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
  onTrackChange(cb: (c: TrackChange) => void) {
    this.trackCbs.add(cb);
    return () => this.trackCbs.delete(cb);
  }
}

export const PRELOAD = PRELOAD_AHEAD_S;

import {
  type AudioBuffer,
  type AudioBufferSourceNode,
  AudioContext,
  AudioManager,
  type GainNode,
  PlaybackNotificationManager,
} from "react-native-audio-api";
import type { Song } from "../lib/types";
import type { Engine, EngineStatus, TrackChange } from "./engine";

/** How far ahead of the mix point the next song must be decoded. */
const PRELOAD_AHEAD_S = 90;
/** Crossfade length in beats, and the ceiling for tempo matching. */
const FADE_BEATS = 16;
const MAX_TEMPO_STRETCH = 0.08;

type Deck = {
  song: Song;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time at which `offset` of the buffer started playing. */
  startedAt: number;
  offset: number;
  rate: number;
  started: boolean;
};

/**
 * The DJ engine: two decks on one AudioContext. The next song is decoded ahead of time and
 * started on the current song's mix-out beat, tempo-matched to it, while the gains cross over.
 * After the mix its tempo eases back to normal. Skips are a short crossfade too, never silence.
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
    void PlaybackNotificationManager.enableControl("nextTrack", true);
    void PlaybackNotificationManager.enableControl("play", true);
    void PlaybackNotificationManager.enableControl("pause", true);
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
      this.mixInto(deck, this.ctx.currentTime + 0.05, 1.5, reason);
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
    const gain = this.ctx.createGain();
    source.connect(gain);
    gain.connect(this.master);
    return { song, buffer, source, gain, startedAt: 0, offset: 0, rate: 1, started: false };
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

  /** Arm a timer for the current song's mix-out point once the next deck is decoded. */
  private scheduleMix() {
    clearTimeout(this.mixTimer);
    const cur = this.current;
    const nxt = this.nextDeck;
    if (!cur || !nxt || this.paused || this.repeat) return;
    const dur = cur.buffer.duration;
    const mixOut = cur.song.mixOutS ?? dur - 8;
    const fadeS = this.fadeSeconds(cur.song, nxt.song);
    const inS = Math.max(0.2, (mixOut - this.position(cur)) / cur.rate - 0.25);
    this.mixTimer = setTimeout(() => {
      if (this.current !== cur || this.nextDeck !== nxt) return;
      this.nextDeck = null;
      const when = this.ctx.currentTime + 0.25;
      this.mixInto(nxt, when, fadeS, "complete");
    }, inS * 1000);
  }

  private fadeSeconds(a: Song, b: Song): number {
    const bpm = a.bpm || b.bpm || 100;
    return Math.min(14, Math.max(4, (FADE_BEATS * 60) / bpm));
  }

  /** Bring `deck` in at `when`, tempo-matched to the current deck, and fade the current one out. */
  private mixInto(deck: Deck, when: number, fadeS: number, reason: "skip" | "complete") {
    const cur = this.current;
    const from = cur?.song.songId ?? null;
    let rate = 1;
    if (cur?.song.bpm && deck.song.bpm) {
      const r = cur.song.bpm / deck.song.bpm;
      const candidates = [r, r / 2, r * 2];
      const best = candidates.reduce((p, c) => (Math.abs(c - 1) < Math.abs(p - 1) ? c : p), r);
      if (Math.abs(best - 1) <= MAX_TEMPO_STRETCH) rate = best;
    }
    deck.gain.gain.setValueAtTime(0, when);
    deck.gain.gain.linearRampToValueAtTime(1, when + fadeS);
    this.startDeck(deck, when, deck.song.mixInS ?? 0, rate);
    // Ease back to the song's own tempo over 20 s after the fade.
    if (rate !== 1) deck.source.playbackRate.linearRampToValueAtTime(1, when + fadeS + 20);
    if (cur) {
      cur.gain.gain.cancelScheduledValues(when);
      cur.gain.gain.setValueAtTime(1, when);
      cur.gain.gain.linearRampToValueAtTime(0, when + fadeS);
      cur.source.onEnded = null;
      try {
        cur.source.stop(when + fadeS + 0.1);
      } catch {}
      setTimeout(() => this.decoding.delete(cur.song.songId), (fadeS + 2) * 1000);
    }
    this.current = deck;
    this.paused = false;
    // Rate drifts back to 1 after the fade; track it for position maths.
    setTimeout(
      () => {
        if (this.current === deck) {
          deck.offset = this.position(deck);
          deck.startedAt = this.ctx.currentTime;
          deck.rate = 1;
        }
      },
      (fadeS + 20) * 1000,
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
    void PlaybackNotificationManager.hide();
  }
  destroy() {
    clearInterval(this.tick);
    this.clear();
    for (const s of this.subs) s.remove();
    void this.ctx.close();
  }

  // --- reporting ---

  private announce(song: Song | undefined) {
    if (!song) return;
    void PlaybackNotificationManager.show({
      title: song.title,
      artist: song.artist,
      artwork: song.thumbUrl,
      duration: this.current?.buffer.duration ?? song.durationS,
      elapsedTime: this.current ? this.position(this.current) : 0,
      state: this.paused ? "paused" : "playing",
    });
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

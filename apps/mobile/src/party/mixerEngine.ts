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
/** "Mix it in now" and tapping Up next: a short DJ mix from the next bar. */
const NOW = { in: 8, out: 4 };
const MAX_TEMPO_STRETCH = 0.08;
/** The bass shelf each deck has: cut while a song is coming in, open once it owns the floor. */
const BASS_HZ = 180;
const BASS_CUT_DB = -18;

/** A full song, or its 30-second store preview while the full audio is pulled. */
type Kind = "full" | "preview";
const kindFor = (s: Song): Kind | null => (s.ready ? "full" : s.previewUrl ? "preview" : null);
/** A song can play right now: its audio is pulled or it has a preview. */
export const playable = (s: Song) => kindFor(s) !== null;

type Deck = {
  song: Song;
  kind: Kind;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode;
  /** Low shelf: the bass swap is what makes two beat-matched songs sound like one. */
  filter: BiquadFilterNode;
  gain: GainNode;
  /** Context time at which `offset` of the buffer started playing. */
  startedAt: number;
  offset: number;
  rate: number;
  /** After a mix, `rate` eases linearly to 1 over `dur` seconds starting at context time `at`. */
  ramp?: { at: number; dur: number };
  started: boolean;
};

/**
 * The DJ engine: two decks on one AudioContext. The next song is decoded ahead of time and
 * started on the current song's beat grid at its mix-out point, tempo-matched, bass cut; after
 * 16 beats the bass swaps and the current song drops out over 8. Then the new song's tempo eases
 * back to its own. Skips are the same move in a few beats, never silence.
 *
 * A song whose audio isn't pulled yet starts on its store preview; once the full audio arrives
 * it takes over at the same point of the song (the server knows where the preview sits), so the
 * listener never hears the switch.
 */
export class MixerEngine implements Engine {
  private ctx = new AudioContext();
  private master: GainNode;
  private current: Deck | null = null;
  private nextDeck: Deck | null = null;
  private queue: Song[] = [];
  /** Decoded audio by `kind:songId`. */
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
    const cur = this.current;
    const i = cur ? list.findIndex((s) => s.songId === cur.song.songId) : -1;
    if (!cur || i < 0) {
      // Nothing playing, or the server replaced the current song: start fresh from the top.
      this.stopDeck(this.current, 0.3);
      this.current = null;
      this.cancelNext();
      const first = list[0];
      if (first && playable(first)) void this.playNow(first);
      return;
    }
    const latest = list[i] as Song;
    if (cur.kind === "preview" && latest.ready) void this.upgrade(cur, latest);
    const after = list[i + 1];
    if (!after) return this.cancelNext();
    const stale =
      this.nextDeck &&
      (this.nextDeck.song.songId !== after.songId ||
        (this.nextDeck.kind === "preview" && after.ready));
    if (stale) this.cancelNext();
    // The natural next song is prepared from its full audio; previews are a late fallback (tick).
    if (!this.nextDeck && after.ready) void this.prepareNext(after);
  }

  next(reason: "skip" | "complete") {
    const cur = this.current;
    const after = cur
      ? this.queue[this.queue.findIndex((s) => s.songId === cur.song.songId) + 1]
      : this.queue[0];
    if (!after) return;
    void (async () => {
      const ready = this.nextDeck?.song.songId === after.songId ? this.nextDeck : null;
      if (this.nextDeck && !ready) this.retire(this.nextDeck);
      this.nextDeck = null;
      clearTimeout(this.mixTimer);
      const deck = ready ?? (await this.makeDeck(after).catch(() => null));
      if (!deck) return;
      const quick = reason === "skip";
      const when = this.onGrid(this.current, this.ctx.currentTime + 0.05, quick ? 1 : 4);
      this.mixInto(deck, when, quick ? SKIP : NOW, reason);
    })();
  }

  // --- decks ---

  private decode(song: Song, kind: Kind): Promise<AudioBuffer> {
    const key = `${kind}:${song.songId}`;
    let p = this.decoding.get(key);
    if (!p) {
      const url = kind === "full" ? song.audioUrl : song.previewUrl;
      if (!url) return Promise.reject(new Error(`no ${kind} audio for ${song.songId}`));
      p = this.ctx.decodeAudioData(url);
      this.decoding.set(key, p);
      p.catch(() => this.decoding.delete(key));
    }
    return p;
  }

  private forget(deck: Deck) {
    this.decoding.delete(`${deck.kind}:${deck.song.songId}`);
  }

  private async makeDeck(song: Song, kind = kindFor(song)): Promise<Deck> {
    if (!kind) throw new Error(`${song.songId} is not playable yet`);
    const buffer = await this.decode(song, kind);
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
      kind,
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

  private starting: string | null = null;
  private async playNow(song: Song) {
    // Queue updates arrive in bursts while the first song decodes; start it once.
    if (this.starting === song.songId) return;
    this.starting = song.songId;
    let deck: Deck;
    try {
      deck = await this.makeDeck(song);
    } catch {
      return; // no preview after all: the full audio's arrival starts it
    } finally {
      if (this.starting === song.songId) this.starting = null;
    }
    if (this.current) return this.retire(deck); // something else started meanwhile
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
    deck.ramp = undefined;
    deck.started = true;
    deck.source.onEnded = () => {
      if (this.current === deck && !this.repeat) this.onCurrentEnded(deck);
    };
  }

  /** Unhook a deck that has stopped (or never started) so its nodes and buffer can go. */
  private retire(deck: Deck, afterS = 0) {
    setTimeout(
      () => {
        if (this.current === deck || this.nextDeck === deck) return;
        for (const n of [deck.source, deck.filter, deck.gain]) {
          try {
            n.disconnect();
          } catch {}
        }
        if (this.current?.song.songId !== deck.song.songId || this.current.kind !== deck.kind)
          this.forget(deck);
      },
      Math.max(0, afterS) * 1000 + 250,
    );
  }

  private stopDeck(deck: Deck | null, fadeS: number) {
    if (!deck?.started) {
      if (deck) this.retire(deck);
      return;
    }
    const t = this.ctx.currentTime;
    deck.gain.gain.cancelScheduledValues(t);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, t);
    deck.gain.gain.linearRampToValueAtTime(0, t + fadeS);
    try {
      deck.source.stop(t + fadeS + 0.05);
    } catch {}
    this.retire(deck, fadeS + 0.1);
  }

  private preparing: string | null = null;
  /** Context time the current mix ends; nothing new is decoded before then. */
  private mixingUntil = 0;
  private async prepareNext(song: Song, kind = kindFor(song)) {
    if (this.preparing === song.songId) return;
    this.preparing = song.songId;
    const wait = this.mixingUntil - this.ctx.currentTime;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000 + 500));
    let deck: Deck;
    try {
      deck = await this.makeDeck(song, kind);
    } catch {
      return;
    } finally {
      if (this.preparing === song.songId) this.preparing = null;
    }
    if (this.queue.some((s) => s.songId === song.songId) && !this.nextDeck) {
      this.nextDeck = deck;
      this.scheduleMix();
    } else this.retire(deck);
  }

  private cancelNext() {
    if (this.nextDeck) {
      this.retire(this.nextDeck);
      this.nextDeck = null;
    }
    clearTimeout(this.mixTimer);
    this.mixTimer = undefined;
  }

  /**
   * The full audio of the song playing as a preview has arrived: start it at the matching point
   * on the same clock and cross over in 50 ms, so nothing audible changes. Without a match, the
   * full song comes in from its start with a short crossfade.
   */
  private upgrading: string | null = null;
  private async upgrade(prev: Deck, song: Song) {
    if (this.upgrading === song.songId) return;
    this.upgrading = song.songId;
    try {
      const full = await this.makeDeck(song, "full").catch(() => null);
      if (!full) return;
      if (this.current !== prev || this.paused) return this.retire(full);
      const when = this.ctx.currentTime + 0.12;
      const exact = song.previewOffsetS != null;
      const at = exact
        ? (song.previewOffsetS as number) + this.positionAt(prev, when)
        : (song.mixInS ?? 0);
      const fade = exact ? 0.05 : 1.5;
      full.gain.gain.setValueAtTime(0, when);
      full.gain.gain.linearRampToValueAtTime(1, when + fade);
      prev.gain.gain.cancelScheduledValues(when);
      prev.gain.gain.setValueAtTime(1, when);
      prev.gain.gain.linearRampToValueAtTime(0, when + fade);
      try {
        prev.source.stop(when + fade + 0.05);
      } catch {}
      this.startDeck(full, when, at, 1);
      this.current = full;
      this.retire(prev, fade + 0.3);
      this.announce(song);
      this.scheduleMix();
      const after = this.queue[this.queue.findIndex((s) => s.songId === song.songId) + 1];
      if (after?.ready && !this.nextDeck) void this.prepareNext(after);
    } finally {
      this.upgrading = null;
    }
  }

  /** Twenty seconds from the mix point with the next song still not pulled: mix into its preview. */
  private fallbackNext() {
    const cur = this.current;
    if (!cur || this.nextDeck || this.paused || this.repeat) return;
    const after = this.queue[this.queue.findIndex((s) => s.songId === cur.song.songId) + 1];
    if (!after || after.ready || !after.previewUrl) return;
    if ((this.mixOutOf(cur) - this.position(cur)) / cur.rate < 20)
      void this.prepareNext(after, "preview");
  }

  // --- the mix ---

  /** Where a deck hands over: its analysed mix-out point, or near the end of a preview. */
  private mixOutOf(deck: Deck): number {
    if (deck.kind === "preview") return Math.max(1, deck.buffer.duration - 6);
    return deck.song.mixOutS ?? deck.buffer.duration - 8;
  }

  /** Position of `deck` at context time `t`, following the tempo ease-back after a mix. */
  private positionAt(deck: Deck, t: number): number {
    const r = deck.rate;
    const ramp = deck.ramp;
    if (!ramp || t <= ramp.at) return deck.offset + (t - deck.startedAt) * r;
    const u = Math.min(t - ramp.at, ramp.dur);
    return (
      deck.offset +
      (ramp.at - deck.startedAt) * r +
      r * u +
      ((1 - r) * u * u) / (2 * ramp.dur) +
      Math.max(0, t - ramp.at - ramp.dur)
    );
  }

  /** Playback rate of `deck` at context time `t`. */
  private rateAt(deck: Deck, t: number): number {
    const ramp = deck.ramp;
    if (!ramp || t <= ramp.at) return deck.rate;
    const u = Math.min(1, (t - ramp.at) / ramp.dur);
    return deck.rate + (1 - deck.rate) * u;
  }

  /** Position of the current deck in its song, in seconds. */
  private position(deck: Deck): number {
    if (this.paused) return this.pausedAt;
    return this.positionAt(deck, this.ctx.currentTime);
  }

  /**
   * Context time at which `deck` plays second `t` of its song, assuming its current rate holds
   * from now on (true once any ease-back has finished, which it has long before a mix-out).
   */
  private atSongTime(deck: Deck, t: number): number {
    const now = this.ctx.currentTime;
    return now + (t - this.positionAt(deck, now)) / this.rateAt(deck, now);
  }

  /**
   * Beat length of `song` in its own time at a mix point: the grid the server fitted to the
   * audio there when it has one (song-wide bpm drifts 100 ms or more over a mix), else the bpm.
   */
  private songBeat(song: Song, at: "in" | "out"): number | null {
    const fitted = at === "in" ? song.mixInBeatS : song.mixOutBeatS;
    return fitted || (song.bpm ? 60 / song.bpm : null);
  }

  /** One beat of `deck` (at its mix-out) in context seconds. */
  private beatSeconds(deck: Deck | null, fallback: Song): number {
    const own = deck ? this.songBeat(deck.song, "out") : null;
    const beat = own ?? this.songBeat(fallback, "in") ?? 0.6;
    return own && deck ? beat / this.rateAt(deck, this.ctx.currentTime) : beat;
  }

  /**
   * The first point at or after `earliest` on the current song's beat grid, counted in groups
   * of `beats` from its mix-out beat. Without a beat grid, `earliest` itself.
   */
  private onGrid(cur: Deck | null, earliest: number, beats: number): number {
    if (!cur || cur.kind === "preview" || !cur.song.bpm || cur.song.mixOutS == null || this.paused)
      return earliest;
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
    const mixOut = this.mixOutOf(cur);
    const inS = Math.max(
      0.2,
      (mixOut - this.position(cur)) / this.rateAt(cur, this.ctx.currentTime) - 0.3,
    );
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
    // Tempo matching needs both beat grids: previews have none.
    const curBeat = cur ? this.songBeat(cur.song, "out") : null;
    const inBeat = this.songBeat(deck.song, "in");
    if (cur?.kind === "full" && deck.kind === "full" && curBeat && inBeat) {
      // Fast enough that one beat of `deck` lasts as long as one beat of `cur` as it plays now.
      const r = (inBeat * this.rateAt(cur, when)) / curBeat;
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
    this.startDeck(deck, when, deck.kind === "full" ? (deck.song.mixInS ?? 0) : 0, rate);
    // Ease back to the song's own tempo over 20 s once it owns the floor.
    if (rate !== 1) {
      deck.source.playbackRate.setValueAtTime(rate, end);
      deck.source.playbackRate.linearRampToValueAtTime(1, end + 20);
      deck.ramp = { at: end, dur: 20 };
    }
    if (cur) {
      cur.filter.gain.setValueAtTime(0, swap);
      cur.filter.gain.linearRampToValueAtTime(BASS_CUT_DB, swap + beat);
      cur.gain.gain.cancelScheduledValues(when);
      cur.gain.gain.setValueAtTime(1, swap);
      cur.gain.gain.linearRampToValueAtTime(0, end);
      try {
        cur.source.stop(end + 0.1);
      } catch {}
      this.retire(cur, end - this.ctx.currentTime + 0.2);
    }
    this.current = deck;
    this.paused = false;
    this.announce(deck.song);
    for (const cb of this.trackCbs) cb({ from, to: deck.song.songId, reason });
    const after = this.queue[this.queue.findIndex((s) => s.songId === deck.song.songId) + 1];
    // Decode the following song once the outgoing deck has stopped, never in the middle of a mix.
    this.mixingUntil = end;
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
    // The context clock stood still while suspended, so the deck's anchors (and any tempo
    // ease-back in progress) still hold; re-anchor only a deck at its plain rate.
    if (this.current && !this.current.ramp) {
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
    this.fallbackNext();
    const cur = this.current;
    const status: EngineStatus = {
      current: cur?.song.songId ?? null,
      playing: Boolean(cur) && !this.paused,
      buffering: Boolean(this.queue[0]) && !cur,
      currentTime: cur ? this.position(cur) : 0,
      duration: cur ? (cur.kind === "full" ? cur.buffer.duration : cur.song.durationS) : 0,
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

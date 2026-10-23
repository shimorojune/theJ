import {
  apply,
  BASS_HZ,
  camelot,
  type HandOver,
  keyShift,
  keySteps,
  LIMITER_INPUT,
  limiterCurve,
  MIX,
  matchRate,
  NOW,
  onGrid,
  planHandOver,
  SKIP,
  type StemInput,
  type StemVoices,
  songBeat,
} from "@thej/mix";
import { AppState } from "react-native";
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
/** Shift the incoming song's key toward the outgoing one's (off: see mixInto). */
const KEY_SHIFT = false;
/** The outgoing loop of a planned mix (planHandOver): two bars. */
const OUT_LOOP = { beats: 8, roll: false };

/** A full song, or its 30-second store preview while the full audio is pulled. */
type Kind = "full" | "preview";
const kindFor = (s: Song): Kind | null => (s.ready ? "full" : s.previewUrl ? "preview" : null);
/** A song can play right now: its audio is pulled or it has a preview. */
export const playable = (s: Song) => kindFor(s) !== null;

/** A song's decoded stems for one mix window, and where the window starts in the song (s). */
type StemSet = { start: number; parts: Record<string, AudioBuffer> };
/** A stem playing during a hand-over. */
type StemVoice = { source: AudioBufferSourceNode; gain: GainNode };

type Deck = {
  song: Song;
  kind: Kind;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode;
  /** Low shelf: the bass swap is what makes two beat-matched songs sound like one. */
  filter: BiquadFilterNode;
  /** High- and low-pass, open until a filter-style switch sweeps them. */
  highpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  gain: GainNode;
  /** Context time at which `offset` of the buffer started playing. */
  startedAt: number;
  offset: number;
  rate: number;
  /** After a mix, `rate` eases linearly to 1 over `dur` seconds starting at context time `at`. */
  ramp?: { at: number; dur: number };
  started: boolean;
  /** Key of this deck's current source in `MixerEngine.endedDecks`. */
  endedId?: number;
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
  /** Cancels the armed mix. */
  private mixTimer: (() => void) | undefined;
  private tick: (() => void) | undefined;
  private paused = false;
  private pausedAt = 0;
  private repeat = false;
  private statusCbs = new Set<(s: EngineStatus) => void>();
  private trackCbs = new Set<(c: TrackChange) => void>();
  private subs: { remove(): void }[] = [];
  /**
   * Decks by their source's "ended" listener. react-native-audio-api never drops an ended
   * listener (setting onEnded again or to null leaves the old one subscribed), so a listener
   * that closed over its deck kept every song ever played in memory: about 180 MB each, and the
   * app died of OOM after a few songs. Listeners hold only an id; a retired deck's is removed.
   */
  private endedDecks = new Map<number, Deck>();
  private endedSeq = 0;
  /**
   * Timers on the audio clock, by id. Android stops JS timers while the app is in the
   * background, so mixes never fired and retired decks (and their audio) were never let go
   * with the screen off. A silent source stopped at the due time still sends its native
   * "ended" event; as with decks, the listener holds only an id.
   */
  private clockTimers = new Map<number, () => void>();
  private clockSeq = 0;
  private silent: GainNode;

  constructor() {
    this.master = this.ctx.createGain();
    // Soft limiter on the master: mixes add the songs at full level rather than dipping.
    const toShaper = this.ctx.createGain();
    toShaper.gain.value = LIMITER_INPUT;
    const limiter = this.ctx.createWaveShaper();
    limiter.curve = limiterCurve();
    this.master.connect(toShaper);
    toShaper.connect(limiter);
    limiter.connect(this.ctx.destination);
    this.silent = this.ctx.createGain();
    this.silent.gain.value = 0;
    this.silent.connect(this.ctx.destination);
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
    // Twice a second for the screen; every few seconds in the background, where only the
    // preview fallback needs it.
    const loop = () => {
      this.emitStatus();
      const away = AppState.currentState === "background";
      this.tick = this.later(loop, away ? 4 : 0.5, away);
    };
    loop();
  }

  /**
   * Run `fn` in `s` seconds, on a JS timer and (with `clock`) on the audio clock as well,
   * whichever comes first: the JS timer covers a paused (suspended) context, the clock covers
   * the background. Returns a cancel.
   */
  private later(fn: () => void, s: number, clock = true): () => void {
    let src: ReturnType<AudioContext["createConstantSource"]> | null = null;
    const id = ++this.clockSeq;
    const stop = () => {
      clearTimeout(t);
      this.clockTimers.delete(id);
      if (!src) return;
      try {
        src.onEnded = null;
        src.disconnect();
      } catch {}
      src = null;
    };
    const run = () => {
      if (!this.clockTimers.has(id)) return;
      stop();
      fn();
    };
    this.clockTimers.set(id, run);
    const t = setTimeout(run, Math.max(0, s) * 1000);
    if (clock) {
      try {
        src = this.ctx.createConstantSource();
        src.offset.value = 0;
        src.connect(this.silent);
        src.onEnded = () => this.clockTimers.get(id)?.();
        const now = this.ctx.currentTime;
        src.start(now);
        src.stop(now + Math.max(0.01, s));
      } catch {
        src = null;
      }
    }
    return stop;
  }

  // --- queue ---

  setQueue(list: Song[]) {
    this.queue = list;
    // Decoded audio of songs that left the queue goes (a playing deck keeps its own reference).
    const queued = new Set(list.map((s) => s.songId));
    for (const key of this.decoding.keys())
      if (!queued.has(key.slice(key.indexOf(":") + 1))) this.decoding.delete(key);
    this.pruneStems();
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
      this.mixTimer?.();
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

  /** Decoded stem windows by `in:<songId>` / `out:<songId>`; only settled ones are kept. */
  private stemSets = new Map<string, StemSet>();
  private stemLoads = new Set<string>();

  /** Decode `song`'s stems for one window in the background; a failure just means no stems. */
  private loadStems(song: Song, which: "in" | "out") {
    const key = `${which}:${song.songId}`;
    const st = song.stems;
    if (!st || this.stemSets.has(key) || this.stemLoads.has(key)) return;
    this.stemLoads.add(key);
    const urls: Record<string, string> = which === "in" ? st.in : st.out;
    void Promise.all(
      Object.entries(urls).map(
        async ([part, url]) => [part, await this.ctx.decodeAudioData(url)] as const,
      ),
    )
      .then((parts) => {
        if (this.queue.some((s) => s.songId === song.songId))
          this.stemSets.set(key, {
            start: which === "in" ? st.inS : st.outS,
            parts: Object.fromEntries(parts),
          });
      })
      .catch(() => {})
      .finally(() => this.stemLoads.delete(key));
  }

  /** Stems of songs that left the queue go. */
  private pruneStems() {
    const queued = new Set(this.queue.map((s) => s.songId));
    for (const key of this.stemSets.keys())
      if (!queued.has(key.slice(key.indexOf(":") + 1))) this.stemSets.delete(key);
  }

  /** A stem as a voice: its own source (same rate and stretcher as the deck) and gain. */
  private stemVoice(buffer: AudioBuffer, rate: number, at: number, offset: number): StemVoice {
    const source = this.ctx.createBufferSource({ pitchCorrection: true });
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(this.master);
    source.playbackRate.setValueAtTime(rate, at);
    source.start(at, Math.max(0, offset));
    return { source, gain };
  }

  /** Stop stem voices at context time `at` and let their audio go just after. */
  private endVoices(voices: StemVoice[], at: number) {
    for (const v of voices) {
      try {
        v.source.stop(at);
      } catch {}
    }
    this.later(
      () => {
        for (const v of voices) {
          releaseSource(v.source);
          try {
            v.gain.disconnect();
          } catch {}
        }
      },
      Math.max(0, at - this.ctx.currentTime) + 0.25,
    );
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
    const highpass = this.ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 20;
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 20000;
    const gain = this.ctx.createGain();
    source.connect(filter);
    filter.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(this.master);
    return {
      song,
      kind,
      buffer,
      source,
      filter,
      highpass,
      lowpass,
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
    if (deck.endedId) this.endedDecks.delete(deck.endedId);
    const id = ++this.endedSeq;
    deck.endedId = id;
    this.endedDecks.set(id, deck);
    deck.source.onEnded = () => {
      const d = this.endedDecks.get(id);
      if (d && this.current === d && !this.repeat) this.onCurrentEnded(d);
    };
  }

  /** Unhook a deck that has stopped (or never started) so its nodes and buffer can go. */
  private retire(deck: Deck, afterS = 0) {
    this.later(() => {
      if (this.current === deck || this.nextDeck === deck) return;
      if (deck.endedId) this.endedDecks.delete(deck.endedId);
      releaseSource(deck.source);
      for (const n of [deck.filter, deck.highpass, deck.lowpass, deck.gain]) {
        try {
          n.disconnect();
        } catch {}
      }
      if (this.current?.song.songId !== deck.song.songId || this.current.kind !== deck.kind)
        this.forget(deck);
    }, Math.max(0, afterS) + 0.25);
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
    if (wait > 0) await new Promise<void>((r) => this.later(r, wait + 0.5));
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
    this.mixTimer?.();
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

  /** One beat of `deck` (at its mix-out) in context seconds. */
  private beatSeconds(deck: Deck | null, fallback: Song): number {
    const own = deck ? songBeat(deck.song, "out") : null;
    const beat = own ?? songBeat(fallback, "in") ?? 0.6;
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
    return onGrid(anchor, this.beatSeconds(cur, cur.song) * beats, earliest);
  }

  /** Arm a timer for the current song's mix-out point once the next deck is decoded. */
  private scheduleMix() {
    this.mixTimer?.();
    const cur = this.current;
    const nxt = this.nextDeck;
    if (!cur || !nxt || this.paused || this.repeat) return;
    if (cur.kind === "full" && nxt.kind === "full") {
      this.loadStems(cur.song, "out");
      this.loadStems(nxt.song, "in");
    }
    const mixOut = this.mixOutOf(cur);
    const beat = this.beatSeconds(cur, nxt.song);
    // Wake a beat early: the stem hand-over starts its crossfade one beat before the mix point.
    const inS = Math.max(
      0.2,
      (mixOut - this.position(cur)) / this.rateAt(cur, this.ctx.currentTime) - beat - 0.4,
    );
    this.mixTimer = this.later(() => {
      if (this.current !== cur || this.nextDeck !== nxt) return;
      this.nextDeck = null;
      // Exactly the mix-out beat, or the next bar if we are late.
      const when = this.onGrid(cur, this.ctx.currentTime + beat + 0.05, 4);
      this.mixInto(nxt, when, MIX, "complete");
    }, inS);
  }

  /**
   * Bring `deck` in at `when` on the current deck's beat grid, tempo-matched, as planned by
   * planHandOver (packages/mix): the same schedules the lab renders.
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
    const curBeat = cur ? songBeat(cur.song, "out") : null;
    const inBeat = songBeat(deck.song, "in");
    if (cur?.kind === "full" && deck.kind === "full" && curBeat && inBeat)
      rate = matchRate(curBeat, this.rateAt(cur, when), inBeat);
    const sameTempo = curBeat != null && inBeat != null && Math.abs(curBeat - inBeat) < 1e-4;
    const offset = deck.kind === "full" ? (deck.song.mixInS ?? 0) : 0;
    const stems = reason === "complete" && cur ? this.stemInput(cur, deck) : null;
    const h = planHandOver({
      when,
      plan,
      beat: this.beatSeconds(cur, deck.song),
      rate,
      inOffset: offset,
      master: cur ? this.master.gain.value : null,
      stems,
      // Tempos too far apart to match: echo the old song out and drop the new one on the one.
      style:
        cur?.kind === "full" && deck.kind === "full" && rate === 1 && !sameTempo ? "echo" : "blend",
      // Key shifting is off: this stretcher pitch-shifts music badly (heard as distortion in the
      // lab). KEY_SHIFT turns it back on; never with stems (each stem has its own stretcher).
      detune:
        KEY_SHIFT && reason === "complete" && cur && !stems
          ? keyShift(cur.song, deck.song) * 100
          : 0,
      keyClash: cur ? keysClash(cur.song, deck.song) : false,
      // A planned mix loops the outgoing song from the mix point.
      loop: reason === "complete" && cur?.kind === "full" ? OUT_LOOP : null,
      outPos: cur ? this.positionAt(cur, when) : undefined,
      outRate: cur ? this.rateAt(cur, when) : undefined,
    });
    if (cur && h.stems) this.playStems(cur, deck, h.stems);
    apply(this.master.gain, h.master);
    apply(deck.gain.gain, h.incoming.gain);
    apply(deck.filter.gain, h.incoming.bass);
    apply(deck.lowpass.frequency, h.incoming.lowpass);
    this.startDeck(deck, when, offset, h.rate);
    deck.source.detune.setValueAtTime(h.incoming.detune, when);
    if (h.incoming.easeBack) {
      apply(deck.source.playbackRate, h.incoming.easeBack.rate);
      apply(deck.source.detune, h.incoming.easeBack.detune);
      deck.ramp = { at: h.incoming.easeBack.at, dur: h.incoming.easeBack.dur };
    }
    if (cur && h.outgoing) {
      apply(cur.gain.gain, h.outgoing.gain);
      apply(cur.filter.gain, h.outgoing.bass);
      apply(cur.highpass.frequency, h.outgoing.highpass);
      if (h.outgoing.echo) this.echoOut(cur, h.outgoing.echo);
      if (h.outgoing.loop) this.playLoop(cur, h.outgoing.loop);
      try {
        cur.source.stop(h.outgoing.stopAt);
      } catch {}
      this.retire(cur, h.end - this.ctx.currentTime + 0.2);
    }
    this.current = deck;
    this.paused = false;
    this.announce(deck.song);
    for (const cb of this.trackCbs) cb({ from, to: deck.song.songId, reason });
    const after = this.queue[this.queue.findIndex((s) => s.songId === deck.song.songId) + 1];
    // Decode the following song once the outgoing deck has stopped, never in the middle of a mix.
    this.mixingUntil = h.end;
    if (after) void this.prepareNext(after);
  }

  /** Feed the outgoing deck into a feedback delay that rings out under the new song. */
  private echoOut(deck: Deck, echo: NonNullable<NonNullable<HandOver["outgoing"]>["echo"]>) {
    const send = this.ctx.createGain();
    send.gain.value = 0;
    const delay = this.ctx.createDelay(2);
    delay.delayTime.value = echo.delayS;
    const feedback = this.ctx.createGain();
    feedback.gain.value = echo.feedback;
    const thin = this.ctx.createBiquadFilter();
    thin.type = "highpass";
    thin.frequency.value = 300;
    deck.gain.connect(send);
    send.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(thin);
    thin.connect(this.master);
    apply(send.gain, echo.send);
    this.later(
      () => {
        for (const n of [send, delay, feedback, thin]) {
          try {
            n.disconnect();
          } catch {}
        }
      },
      echo.until - this.ctx.currentTime + 0.5,
    );
  }

  /**
   * Set the outgoing source's loop regions on the audio clock. Each lands a little after the
   * boundary it starts on (setAt), so a late timer still finds the playhead inside the region.
   */
  private playLoop(deck: Deck, loop: NonNullable<NonNullable<HandOver["outgoing"]>["loop"]>) {
    const now = this.ctx.currentTime;
    for (const step of loop.steps)
      this.later(() => {
        deck.source.loopStart = step.startS;
        deck.source.loopEnd = step.startS + step.lengthS;
        deck.source.loop = true;
      }, step.setAt - now);
    this.later(() => {
      deck.source.loop = false;
    }, loop.releaseAt - now);
  }

  /** The decoded stems both songs have around this mix, or null for the classic hand-over. */
  private stemInput(cur: Deck, deck: Deck): StemInput | null {
    if (cur.kind !== "full" || deck.kind !== "full" || this.repeat) return null;
    const outSet = this.stemSets.get(`out:${cur.song.songId}`);
    const inSet = this.stemSets.get(`in:${deck.song.songId}`);
    if (!outSet || !inSet) return null;
    const lengths = (set: StemSet) =>
      Object.fromEntries(Object.entries(set.parts).map(([k, b]) => [k, b.duration]));
    return {
      now: this.ctx.currentTime,
      outPosAt: (t) => this.positionAt(cur, t),
      outRateAt: (t) => this.rateAt(cur, t),
      outStart: outSet.start,
      inStart: inSet.start,
      outLengths: lengths(outSet) as StemInput["outLengths"],
      inLengths: lengths(inSet) as StemInput["inLengths"],
    };
  }

  /** Start the stem voices of a planned stem hand-over; their windows are used up after it. */
  private playStems(cur: Deck, deck: Deck, stems: NonNullable<HandOver["stems"]>) {
    const outKey = `out:${cur.song.songId}`;
    const inKey = `in:${deck.song.songId}`;
    const play = <K extends string>(set: StemSet | undefined, v: StemVoices<K>) => {
      const voices: StemVoice[] = [];
      for (const [part, schedule] of Object.entries(v.gain) as [K, HandOver["master"]][]) {
        const buffer = set?.parts[part];
        if (!buffer) continue;
        const voice = this.stemVoice(buffer, v.rate, v.at, v.offset);
        apply(voice.gain.gain, schedule);
        voices.push(voice);
      }
      this.endVoices(voices, v.stopAt);
    };
    play(this.stemSets.get(outKey), stems.out);
    play(this.stemSets.get(inKey), stems.in);
    this.stemSets.delete(outKey);
    this.stemSets.delete(inKey);
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
    this.mixTimer?.();
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
    const old = cur.source;
    try {
      old.stop();
    } catch {}
    this.later(() => releaseSource(old), 0.25, false);
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
    if (on) this.mixTimer?.();
    else this.scheduleMix();
  }
  clear() {
    this.mixTimer?.();
    this.stopDeck(this.current, 0.2);
    this.cancelNext();
    this.current = null;
    this.queue = [];
  }
  destroy() {
    this.tick?.();
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

/**
 * Let a stopped source's audio go now: with pitch correction each source holds its own full copy
 * of the song (another ~90 MB), freed natively once its buffer is unset.
 */
function releaseSource(source: AudioBufferSourceNode) {
  try {
    source.onEnded = null;
  } catch {}
  try {
    source.buffer = null;
  } catch {}
  try {
    source.disconnect();
  } catch {}
}

/** Keys 3+ steps apart on the Camelot wheel: the mix overlaps only rhythm (planHandOver). */
function keysClash(a: Song, b: Song): boolean {
  const ka = camelot(a.key, a.scale);
  const kb = camelot(b.key, b.scale);
  return ka != null && kb != null && keySteps(ka, kb) >= 3;
}

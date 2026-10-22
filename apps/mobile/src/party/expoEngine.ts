import {
  type AudioPlaylist,
  type AudioPlaylistStatus,
  createAudioPlaylist,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { Platform } from "react-native";
import type { Song } from "../lib/types";
import type { Engine, EngineStatus, TrackChange } from "./engine";

/** The simple engine: expo-audio's native playlist. Clean cuts between songs, no mixing. */
export class ExpoEngine implements Engine {
  private playlist: AudioPlaylist;
  private loaded: string[] = [];
  private songs = new Map<string, Song>();
  private reason: "skip" | "complete" | null = null;
  private last = { index: -1, time: 0, duration: 0 };
  private lockScreenActive = false;
  private statusCbs = new Set<(s: EngineStatus) => void>();
  private trackCbs = new Set<(c: TrackChange) => void>();
  private sub: { remove(): void } | undefined;

  constructor() {
    this.playlist = createAudioPlaylist({ updateInterval: 500 });
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    });
    // Android 13+ hides the media notification until the app asks for it.
    if (Platform.OS === "android") void requestNotificationPermissionsAsync().catch(() => {});
    this.sub = this.playlist.addListener("playlistStatusUpdate", (s: AudioPlaylistStatus) =>
      this.onNative(s),
    );
  }

  private onNative(s: AudioPlaylistStatus) {
    const prev = this.last;
    if (s.currentIndex !== prev.index && prev.index >= 0) {
      const from = this.loaded[prev.index] ?? null;
      const finished = prev.duration > 0 && prev.time >= prev.duration - 3;
      const reason = this.reason ?? (finished ? "complete" : "skip");
      this.reason = null;
      const to = this.loaded[s.currentIndex] ?? null;
      this.lockScreen(to ? this.songs.get(to) : undefined);
      for (const cb of this.trackCbs) cb({ from, to, reason });
    }
    // The last song ran out with nothing after it: report it so the server refills.
    const atEnd = s.currentIndex === this.loaded.length - 1;
    if (
      atEnd &&
      !s.playing &&
      s.duration > 0 &&
      s.currentTime >= s.duration - 0.5 &&
      prev.time < prev.duration - 0.5
    ) {
      const from = this.loaded[s.currentIndex] ?? null;
      for (const cb of this.trackCbs) cb({ from, to: null, reason: "complete" });
    }
    this.last = { index: s.currentIndex, time: s.currentTime, duration: s.duration };
    const status: EngineStatus = {
      current: this.loaded[s.currentIndex] ?? null,
      playing: s.playing,
      buffering: s.isBuffering,
      currentTime: s.currentTime,
      duration: s.duration,
    };
    for (const cb of this.statusCbs) cb(status);
  }

  /** First call creates the media session; later ones only swap the metadata, so it doesn't flicker. */
  private lockScreen(song: Song | undefined) {
    if (!song) return;
    const meta = { title: song.title, artist: song.artist, artworkUrl: song.thumbUrl };
    if (this.lockScreenActive) {
      this.playlist.updateLockScreenMetadata(meta);
      return;
    }
    this.playlist.setActiveForLockScreen(true, meta, {
      showNextTrack: true,
      showPreviousTrack: false,
    });
    this.lockScreenActive = true;
  }

  setQueue(list: Song[]) {
    for (const s of list) this.songs.set(s.songId, s);
    const ids = list.map((s) => s.songId);
    const cur = this.playlist.currentIndex;
    const curId = this.loaded[cur];
    if (!curId || !ids.includes(curId)) {
      this.playlist.clear();
      this.loaded = [];
      for (const s of list) {
        this.playlist.add({ uri: s.audioUrl, name: s.title });
        this.loaded.push(s.songId);
      }
      this.last = { index: 0, time: 0, duration: 0 };
      if (list.length) {
        this.playlist.play();
        this.lockScreen(list[0]);
      }
      return;
    }
    const k = ids.indexOf(curId);
    const want = ids.slice(k + 1);
    const have = this.loaded.slice(cur + 1);
    if (want.join() !== have.join()) {
      for (let i = this.loaded.length - 1; i > cur; i--) {
        this.playlist.remove(i);
        this.loaded.splice(i, 1);
      }
      for (const s of list.slice(k + 1)) {
        this.playlist.add({ uri: s.audioUrl, name: s.title });
        this.loaded.push(s.songId);
      }
    }
  }

  next(reason: "skip" | "complete") {
    if (this.playlist.currentIndex >= this.loaded.length - 1) return;
    this.reason = reason;
    this.playlist.next();
  }
  play() {
    this.playlist.play();
  }
  pause() {
    this.playlist.pause();
  }
  seek(seconds: number) {
    void this.playlist.seekTo(seconds);
  }
  restart() {
    void this.playlist.seekTo(0);
  }
  setRepeat(on: boolean) {
    this.playlist.loop = on ? "single" : "none";
  }
  clear() {
    this.playlist.pause();
    this.playlist.clear();
    this.playlist.clearLockScreenControls();
    this.lockScreenActive = false;
    this.loaded = [];
  }
  onStatus(cb: (s: EngineStatus) => void) {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
  onTrackChange(cb: (c: TrackChange) => void) {
    this.trackCbs.add(cb);
    return () => this.trackCbs.delete(cb);
  }
  destroy() {
    this.sub?.remove();
    this.clear();
  }
}

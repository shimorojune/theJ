import type { QueueTrack } from "@thej/shared";

/**
 * Web playback: one <audio> plays, a second preloads the next song so the switch is gapless enough.
 * The Media Session API gives lock-screen / notification controls on Android Chrome and iOS Safari.
 * The queue itself comes from the server (committed next-2 over SSE).
 */
export class Player {
  private current = new Audio();
  private next = new Audio();
  private queue: QueueTrack[] = [];

  constructor(private readonly onSkip: (t: QueueTrack) => void) {
    for (const a of [this.current, this.next]) {
      a.preload = "auto";
      a.addEventListener("ended", () => a === this.current && this.advance());
    }

    const ms = navigator.mediaSession;
    ms?.setActionHandler("play", () => this.play());
    ms?.setActionHandler("pause", () => this.pause());
    ms?.setActionHandler("nexttrack", () => this.skip());
  }

  /** Replace the committed queue (current + up to 2 next) from a server event. */
  setQueue(tracks: QueueTrack[]) {
    const playing = this.queue[0];
    this.queue = tracks;
    if (!playing || playing.videoId !== tracks[0]?.videoId) this.load();
    else this.preloadNext();
  }

  play() {
    return this.current.play();
  }

  pause() {
    this.current.pause();
  }

  skip() {
    const t = this.queue[0];
    if (t) this.onSkip(t);
    this.advance();
  }

  private advance() {
    this.queue.shift();
    [this.current, this.next] = [this.next, this.current];
    this.syncSession();
    void this.current.play();
    this.preloadNext();
  }

  private load() {
    const t = this.queue[0];
    if (!t) return;
    this.current.src = t.audioUrl;
    this.syncSession();
    this.preloadNext();
  }

  private preloadNext() {
    const n = this.queue[1];
    if (n && this.next.src !== n.audioUrl) this.next.src = n.audioUrl;
  }

  private syncSession() {
    const t = this.queue[0];
    if (!t || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      artwork: [{ src: t.thumbUrl, sizes: "480x360", type: "image/jpeg" }],
    });
  }
}

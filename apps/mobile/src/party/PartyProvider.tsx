import type { Button, Vibe } from "@thej/shared";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import EventSource from "react-native-sse";
import { API_URL, ok, useApi } from "../lib/api";
import { DEV_HEADERS, DEV_USER, useSession } from "../lib/auth";
import type { Queue, Song } from "../lib/types";
import type { Engine, EngineStatus } from "./engine";

const SESSION_KEY = "thej.session";
/** A mood start that hasn't answered by now is reported, with a retry, instead of spinning. */
const START_TIMEOUT_MS = 75_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The DJ didn't answer in time.")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}
const LABEL_KEY = "thej.label";

/** What a mood start needs: a name to show, a starting vibe, and words for the search. */
export type MoodStart = {
  label: string;
  vibe: Vibe;
  moodText?: string;
  /** Onboarding passes the languages just picked; otherwise the server uses the saved ones. */
  languages?: ("en" | "hi")[];
};

/** EXPO_PUBLIC_ENGINE=mixer uses the two-deck mixer (react-native-audio-api); default is expo-audio. */
const ENGINE = process.env.EXPO_PUBLIC_ENGINE === "mixer" ? "mixer" : "expo";

async function createEngine(): Promise<Engine> {
  if (ENGINE === "mixer") {
    const { MixerEngine } = await import("./mixerEngine");
    return new MixerEngine();
  }
  const { ExpoEngine } = await import("./expoEngine");
  return new ExpoEngine();
}

/** What the engine is doing, without the playhead (that ticks; see `useProgress`). */
export type PlayStatus = Omit<EngineStatus, "currentTime">;

type Party = {
  queue: Queue | null;
  status: PlayStatus;
  engine: "mixer" | "expo";
  starting: boolean;
  error: string | null;
  /** The name of the mood playing, for the player header. */
  label: string | null;
  start: (mood: MoodStart) => Promise<void>;
  /** Start the last mood again (after a failed start). */
  retry: () => void;
  press: (button: Button, now: boolean) => Promise<void>;
  skip: () => void;
  /** Jump to the next song because the user chose it (not a dislike). */
  jumpNext: () => void;
  togglePlay: () => void;
  restart: () => void;
  seek: (seconds: number) => void;
  repeat: boolean;
  toggleRepeat: () => void;
  toggleLike: () => Promise<void>;
  end: () => Promise<void>;
  upcoming: () => Promise<Song[]>;
  nowPlaying: { now: Song | undefined; next: Song | undefined };
};

const IDLE: PlayStatus = { current: null, playing: false, buffering: false, duration: 0 };

const sameStatus = (a: PlayStatus, b: PlayStatus) =>
  a.current === b.current &&
  a.playing === b.playing &&
  a.buffering === b.buffering &&
  a.duration === b.duration;

/**
 * The playhead, kept out of the party context: the engine reports it twice a second, and as
 * context state it re-rendered every screen each time (taps landed late or not at all).
 * Only the components that show it subscribe. Nothing is pushed while the app is in the
 * background; the latest value is there on return.
 */
function createProgress() {
  let time = 0;
  let active = AppState.currentState !== "background";
  const subs = new Set<() => void>();
  const notify = () => {
    for (const cb of subs) cb();
  };
  return {
    get: () => time,
    set(t: number) {
      if (t === time) return;
      time = t;
      if (active) notify();
    },
    setActive(on: boolean) {
      active = on;
      if (on) notify();
    },
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
type Progress = ReturnType<typeof createProgress>;

const Ctx = createContext<Party | null>(null);
const ProgressCtx = createContext<Progress | null>(null);
export const useParty = () => {
  const p = useContext(Ctx);
  if (!p) throw new Error("useParty outside PartyProvider");
  return p;
};

/** Seconds into the song playing; re-renders only its caller, twice a second. */
export function useProgress(): number {
  const p = useContext(ProgressCtx);
  if (!p) throw new Error("useProgress outside PartyProvider");
  return useSyncExternalStore(p.subscribe, p.get);
}

/**
 * Owns the party: the server's committed queue (current + next 2) handed to a playback engine,
 * the live SSE stream, and play events back to the api. The server decides what plays.
 */
export function PartyProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { getToken, isSignedIn } = useSession();
  const engine = useRef<Engine | null>(null);
  const [status, setStatus] = useState<PlayStatus>(IDLE);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [progress] = useState(createProgress);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const songs = useRef(new Map<string, Song>());
  const sessionId = queue?.sessionId;
  const sessionRef = useRef<string | undefined>(undefined);
  sessionRef.current = sessionId;

  /** "Mix it in now" picked this song; the mix starts the moment its audio is playable. */
  const pendingSkip = useRef<string | null>(null);

  /** Hand the server's queue to the engine: songs whose audio is pulled or that have a preview. */
  const apply = useCallback((q: Queue) => {
    for (const s of [...q.committed, ...(q.upcoming ?? [])]) songs.current.set(s.songId, s);
    setQueue((prev) => ({ ...q, upcoming: q.upcoming ?? prev?.upcoming }));
    const playable = q.committed.filter((s) => s.ready !== false || Boolean(s.previewUrl));
    engine.current?.setQueue(playable);
    if (q.skipTo) pendingSkip.current = q.skipTo;
    const target = pendingSkip.current;
    if (!target) return;
    if (playable[1]?.songId === target) {
      pendingSkip.current = null;
      engine.current?.next("complete");
    } else if (!q.committed.some((s) => s.songId === target)) pendingSkip.current = null;
  }, []);

  const send = useCallback(
    async (songId: string, event: "start" | "skip" | "complete" | "like" | "unlike") => {
      const id = sessionRef.current;
      if (!id) return;
      const res = await api.sessions[":id"].events.$post({
        param: { id },
        json: { songId, event },
      });
      if (res.status === 200) apply(await ok<Queue>(res));
    },
    [api, apply],
  );

  // One engine for the provider's life; it reports status and song changes. `send` is read
  // through a ref so a new api client (Clerk hands out a new getToken) never rebuilds the engine.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    let alive = true;
    let offStatus = () => {};
    let offTrack = () => {};
    void createEngine().then((e) => {
      if (!alive) return e.destroy();
      engine.current = e;
      offStatus = e.onStatus(({ currentTime, ...rest }) => {
        progress.set(currentTime);
        setStatus((prev) => (sameStatus(prev, rest) ? prev : rest));
      });
      offTrack = e.onTrackChange(({ from, to, reason }) => {
        if (to) void sendRef.current(to, "start").catch(() => {});
        if (from) void sendRef.current(from, reason).catch((err) => setError(String(err)));
      });
    });
    return () => {
      alive = false;
      offStatus();
      offTrack();
      engine.current?.destroy();
      engine.current = null;
    };
  }, [progress]);

  // Back from the background: the stream may have died while the phone slept, so reconnect it
  // and fetch the queue once, so nothing on screen is stale.
  const [resumes, setResumes] = useState(0);
  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      progress.setActive(next === "active");
      if (next === "active" && last !== "active") setResumes((n) => n + 1);
      last = next;
    });
    return () => sub.remove();
  }, [progress]);
  useEffect(() => {
    const id = sessionRef.current;
    if (!resumes || !id) return;
    void (async () => {
      const res = await api.sessions[":id"].$get({ param: { id } });
      if (res.ok && sessionRef.current === id) apply(await ok<Queue>(res));
    })().catch(() => {});
  }, [resumes, api, apply]);

  // Live queue changes from the server (a pad move from another phone, audio becoming ready).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a resume reconnects the stream
  useEffect(() => {
    if (!sessionId || !isSignedIn) return;
    let es: EventSource<"queue" | "ping"> | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = async () => {
      const token = await getToken();
      if (closed) return;
      es = new EventSource<"queue" | "ping">(`${API_URL}/sessions/${sessionId}/stream`, {
        headers: DEV_USER ? DEV_HEADERS : { Authorization: `Bearer ${token}` },
        pollingInterval: 0,
      });
      es.addEventListener("queue", (e) => {
        if (e.data) apply(JSON.parse(e.data) as Queue);
      });
      es.addEventListener("error", () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      });
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [sessionId, isSignedIn, getToken, apply, resumes]);

  // Resume the last mood after the app restarts.
  useEffect(() => {
    if (!isSignedIn) return;
    void (async () => {
      const id = await SecureStore.getItemAsync(SESSION_KEY);
      if (!id) return;
      setLabel(await SecureStore.getItemAsync(LABEL_KEY));
      const res = await api.sessions[":id"].$get({ param: { id } });
      if (res.ok) apply(await ok<Queue>(res));
      else await SecureStore.deleteItemAsync(SESSION_KEY);
    })().catch(() => {});
  }, [isSignedIn, api, apply]);

  const lastMood = useRef<MoodStart | null>(null);
  const start = useCallback(
    async (mood: MoodStart) => {
      const { label, vibe, moodText, languages } = mood;
      lastMood.current = mood;
      setStarting(true);
      setError(null);
      setLabel(label);
      setQueue(null);
      sessionRef.current = undefined;
      try {
        engine.current?.clear();
        const q = await withTimeout(
          api.sessions.$post({ json: { languages, vibe, moodText } }).then((r) => ok<Queue>(r)),
          START_TIMEOUT_MS,
        );
        await SecureStore.setItemAsync(SESSION_KEY, q.sessionId);
        await SecureStore.setItemAsync(LABEL_KEY, label);
        sessionRef.current = q.sessionId;
        apply(q);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setStarting(false);
      }
    },
    [api, apply],
  );

  const retry = useCallback(() => {
    if (lastMood.current) void start(lastMood.current).catch(() => {});
  }, [start]);

  const control = useCallback(
    async (json: { kind: "button"; button: Button; now: boolean }) => {
      if (!sessionId) return;
      const res = await api.sessions[":id"].control.$post({ param: { id: sessionId }, json });
      apply(await ok<Queue>(res));
    },
    [api, sessionId, apply],
  );
  const press = useCallback(
    (button: Button, now: boolean) => control({ kind: "button", button, now }),
    [control],
  );

  const skip = useCallback(() => engine.current?.next("skip"), []);
  const jumpNext = useCallback(() => engine.current?.next("complete"), []);
  const togglePlay = useCallback(() => {
    if (statusRef.current.playing) engine.current?.pause();
    else engine.current?.play();
  }, []);
  const restart = useCallback(() => engine.current?.restart(), []);
  const seek = useCallback((s: number) => engine.current?.seek(s), []);
  const toggleRepeat = useCallback(() => {
    setRepeat((r) => {
      engine.current?.setRepeat(!r);
      return !r;
    });
  }, []);

  const liked = queue?.liked;
  const toggleLike = useCallback(async () => {
    const id = statusRef.current.current;
    if (!id) return;
    await send(id, liked?.includes(id) ? "unlike" : "like");
  }, [send, liked]);

  const end = useCallback(async () => {
    if (sessionId)
      await api.sessions[":id"].end.$post({ param: { id: sessionId } }).catch(() => {});
    await SecureStore.deleteItemAsync(SESSION_KEY);
    engine.current?.clear();
    sessionRef.current = undefined;
    setQueue(null);
  }, [api, sessionId]);

  const upcoming = useCallback(async () => {
    if (!sessionId) return [];
    const q = await ok<Queue>(await api.sessions[":id"].$get({ param: { id: sessionId } }));
    return q.upcoming ?? [];
  }, [api, sessionId]);

  const nowPlaying = useMemo(() => {
    const committed = queue?.committed ?? [];
    const i = committed.findIndex((s) => s.songId === status.current);
    return { now: i >= 0 ? committed[i] : undefined, next: i >= 0 ? committed[i + 1] : undefined };
  }, [queue, status.current]);

  const value = useMemo<Party>(
    () => ({
      queue,
      status,
      engine: ENGINE,
      starting,
      error,
      label,
      start,
      retry,
      press,
      skip,
      jumpNext,
      togglePlay,
      restart,
      seek,
      repeat,
      toggleRepeat,
      toggleLike,
      end,
      upcoming,
      nowPlaying,
    }),
    [
      queue,
      status,
      starting,
      error,
      label,
      start,
      retry,
      press,
      skip,
      jumpNext,
      togglePlay,
      restart,
      seek,
      repeat,
      toggleRepeat,
      toggleLike,
      end,
      upcoming,
      nowPlaying,
    ],
  );

  return (
    <ProgressCtx.Provider value={progress}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </ProgressCtx.Provider>
  );
}

/** The song the engine is on right now. */
export function useNowPlaying(): { now: Song | undefined; next: Song | undefined } {
  return useParty().nowPlaying;
}

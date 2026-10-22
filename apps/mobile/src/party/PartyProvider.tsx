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
} from "react";
import EventSource from "react-native-sse";
import { API_URL, ok, useApi } from "../lib/api";
import { DEV_HEADERS, DEV_USER, useSession } from "../lib/auth";
import type { Queue, Song } from "../lib/types";
import type { Engine, EngineStatus } from "./engine";

const SESSION_KEY = "thej.session";

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

type Party = {
  queue: Queue | null;
  status: EngineStatus;
  engine: "mixer" | "expo";
  starting: boolean;
  error: string | null;
  start: (languages: ("en" | "hi")[] | undefined, vibe: Vibe) => Promise<void>;
  press: (button: Button, now: boolean) => Promise<void>;
  /** The mood pad: an absolute goal. */
  setVibe: (vibe: Vibe, now: boolean) => Promise<void>;
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

const IDLE: EngineStatus = {
  current: null,
  playing: false,
  buffering: false,
  currentTime: 0,
  duration: 0,
};

const Ctx = createContext<Party | null>(null);
export const useParty = () => {
  const p = useContext(Ctx);
  if (!p) throw new Error("useParty outside PartyProvider");
  return p;
};

/**
 * Owns the party: the server's committed queue (current + next 2) handed to a playback engine,
 * the live SSE stream, and play events back to the api. The server decides what plays.
 */
export function PartyProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { getToken, isSignedIn } = useSession();
  const engine = useRef<Engine | null>(null);
  const [status, setStatus] = useState<EngineStatus>(IDLE);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repeat, setRepeat] = useState(false);
  const songs = useRef(new Map<string, Song>());
  const sessionId = queue?.sessionId;
  const sessionRef = useRef<string | undefined>(undefined);
  sessionRef.current = sessionId;

  /** Hand the server's queue to the engine; only songs whose audio is pulled are playable. */
  const apply = useCallback((q: Queue) => {
    for (const s of [...q.committed, ...(q.upcoming ?? [])]) songs.current.set(s.songId, s);
    setQueue((prev) => ({ ...q, upcoming: q.upcoming ?? prev?.upcoming }));
    const playable = q.committed.filter((s) => s.ready !== false);
    engine.current?.setQueue(playable);
    if (q.skipTo && playable[1]?.songId === q.skipTo) engine.current?.next("complete");
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
      offStatus = e.onStatus(setStatus);
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
  }, []);

  // Live queue changes from the server (a pad move from another phone, audio becoming ready).
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
  }, [sessionId, isSignedIn, getToken, apply]);

  // Resume the last mood after the app restarts.
  useEffect(() => {
    if (!isSignedIn) return;
    void (async () => {
      const id = await SecureStore.getItemAsync(SESSION_KEY);
      if (!id) return;
      const res = await api.sessions[":id"].$get({ param: { id } });
      if (res.ok) apply(await ok<Queue>(res));
      else await SecureStore.deleteItemAsync(SESSION_KEY);
    })().catch(() => {});
  }, [isSignedIn, api, apply]);

  const start = useCallback(
    async (languages: ("en" | "hi")[] | undefined, vibe: Vibe) => {
      setStarting(true);
      setError(null);
      try {
        engine.current?.clear();
        const q = await ok<Queue>(await api.sessions.$post({ json: { languages, vibe } }));
        await SecureStore.setItemAsync(SESSION_KEY, q.sessionId);
        sessionRef.current = q.sessionId;
        apply(q);
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setStarting(false);
      }
    },
    [api, apply],
  );

  const control = useCallback(
    async (
      json:
        | { kind: "button"; button: Button; now: boolean }
        | { kind: "pad"; vibe: Vibe; now: boolean },
    ) => {
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
  const setVibe = useCallback(
    (vibe: Vibe, now: boolean) => control({ kind: "pad", vibe, now }),
    [control],
  );

  const skip = useCallback(() => engine.current?.next("skip"), []);
  const jumpNext = useCallback(() => engine.current?.next("complete"), []);
  const togglePlay = useCallback(() => {
    if (status.playing) engine.current?.pause();
    else engine.current?.play();
  }, [status.playing]);
  const restart = useCallback(() => engine.current?.restart(), []);
  const seek = useCallback((s: number) => engine.current?.seek(s), []);
  const toggleRepeat = useCallback(() => {
    setRepeat((r) => {
      engine.current?.setRepeat(!r);
      return !r;
    });
  }, []);

  const toggleLike = useCallback(async () => {
    const id = status.current;
    if (!id) return;
    await send(id, queue?.liked.includes(id) ? "unlike" : "like");
  }, [status.current, send, queue?.liked]);

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

  return (
    <Ctx.Provider
      value={{
        queue,
        status,
        engine: ENGINE,
        starting,
        error,
        start,
        press,
        setVibe,
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
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

/** The song the engine is on right now. */
export function useNowPlaying(): { now: Song | undefined; next: Song | undefined } {
  return useParty().nowPlaying;
}

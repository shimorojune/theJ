import { useAuth } from "@clerk/expo";
import type { Button, Vibe } from "@thej/shared";
import {
  type AudioPlaylistStatus,
  setAudioModeAsync,
  useAudioPlaylist,
  useAudioPlaylistStatus,
} from "expo-audio";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import EventSource from "react-native-sse";
import { API_URL, ok, useApi } from "../lib/api";
import type { Queue, Song } from "../lib/types";

const SESSION_KEY = "thej.session";

type Party = {
  queue: Queue | null;
  status: AudioPlaylistStatus;
  starting: boolean;
  error: string | null;
  start: (languages: ("en" | "hi")[], vibe: Vibe) => Promise<void>;
  press: (button: Button, now: boolean) => Promise<void>;
  skip: () => void;
  togglePlay: () => void;
  restart: () => void;
  like: () => Promise<void>;
  end: () => Promise<void>;
  upcoming: () => Promise<Song[]>;
  nowPlaying: { now: Song | undefined; next: Song | undefined };
};

const Ctx = createContext<Party | null>(null);
export const useParty = () => {
  const p = useContext(Ctx);
  if (!p) throw new Error("useParty outside PartyProvider");
  return p;
};

/**
 * Owns the party: the server's committed queue (current + next 2) mirrored into one native
 * expo-audio playlist, the live SSE stream, and play events back to the api.
 */
export function PartyProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { getToken, isSignedIn } = useAuth();
  const playlist = useAudioPlaylist({ updateInterval: 500 });
  const status = useAudioPlaylistStatus(playlist);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Video ids in the native playlist, index for index. */
  const loaded = useRef<string[]>([]);
  const songs = useRef(new Map<string, Song>());
  /** Why the next index change happened, when we caused it ourselves. */
  const reason = useRef<"skip" | "complete" | null>(null);
  const last = useRef({ index: -1, time: 0, duration: 0 });
  const sessionId = queue?.sessionId;

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    });
  }, []);

  const lockScreen = useCallback(
    (song: Song | undefined) => {
      if (!song) return;
      const meta = { title: song.title, artist: song.artist, artworkUrl: song.thumbUrl };
      playlist.setActiveForLockScreen(true, meta, {
        showNextTrack: true,
        showPreviousTrack: false,
      });
    },
    [playlist],
  );

  /** Make the native playlist match the server's committed queue without interrupting the current song. */
  const apply = useCallback(
    (q: Queue) => {
      for (const s of [...q.committed, ...(q.upcoming ?? [])]) songs.current.set(s.videoId, s);
      setQueue((prev) => ({ ...q, upcoming: q.upcoming ?? prev?.upcoming }));
      const ids = q.committed.map((s) => s.videoId);
      const cur = playlist.currentIndex;
      const curId = loaded.current[cur];

      if (!curId || !ids.includes(curId)) {
        playlist.clear();
        loaded.current = [];
        for (const s of q.committed) {
          playlist.add({ uri: s.audioUrl, name: s.title });
          loaded.current.push(s.videoId);
        }
        last.current = { index: 0, time: 0, duration: 0 };
        if (q.committed.length) {
          playlist.play();
          lockScreen(q.committed[0]);
        }
        return;
      }

      const k = ids.indexOf(curId);
      const want = ids.slice(k + 1);
      const have = loaded.current.slice(cur + 1);
      if (want.join() !== have.join()) {
        for (let i = loaded.current.length - 1; i > cur; i--) {
          playlist.remove(i);
          loaded.current.splice(i, 1);
        }
        for (const s of q.committed.slice(k + 1)) {
          playlist.add({ uri: s.audioUrl, name: s.title });
          loaded.current.push(s.videoId);
        }
      }
      if (q.skipTo && loaded.current[cur + 1] === q.skipTo) {
        // A long press: jumping isn't a dislike, so it's reported as finished, not skipped.
        reason.current = "complete";
        playlist.next();
      }
    },
    [playlist, lockScreen],
  );

  const send = useCallback(
    async (videoId: string, event: "start" | "skip" | "complete" | "like") => {
      if (!sessionId) return;
      const res = await api.sessions[":id"].events.$post({
        param: { id: sessionId },
        json: { videoId, event },
      });
      if (res.status === 200) apply(await ok<Queue>(res));
    },
    [api, sessionId, apply],
  );

  // A song changed (it ended, or someone pressed next here or on the lock screen): tell the server.
  useEffect(() => {
    const prev = last.current;
    if (status.currentIndex !== prev.index && prev.index >= 0) {
      const prevId = loaded.current[prev.index];
      const finished = prev.duration > 0 && prev.time >= prev.duration - 3;
      const kind = reason.current ?? (finished ? "complete" : "skip");
      reason.current = null;
      const nowId = loaded.current[status.currentIndex];
      lockScreen(nowId ? songs.current.get(nowId) : undefined);
      if (nowId) void send(nowId, "start").catch(() => {});
      if (prevId) void send(prevId, kind).catch((e) => setError(String(e)));
    }
    last.current = {
      index: status.currentIndex,
      time: status.currentTime,
      duration: status.duration,
    };
  }, [status.currentIndex, status.currentTime, status.duration, send, lockScreen]);

  // The last committed song ran out with nothing after it: report it so the server refills.
  useEffect(() => {
    const atEnd = status.currentIndex === loaded.current.length - 1;
    if (
      atEnd &&
      !status.playing &&
      status.duration > 0 &&
      status.currentTime >= status.duration - 0.5
    ) {
      const id = loaded.current[status.currentIndex];
      if (id) void send(id, "complete").catch(() => {});
    }
  }, [status.playing, status.currentTime, status.duration, status.currentIndex, send]);

  // Live queue changes from the server (another phone pressing a button, or a refill landing).
  useEffect(() => {
    if (!sessionId || !isSignedIn) return;
    let es: EventSource<"queue" | "ping"> | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = async () => {
      const token = await getToken();
      if (closed) return;
      es = new EventSource<"queue" | "ping">(`${API_URL}/sessions/${sessionId}/stream`, {
        headers: { Authorization: `Bearer ${token}` },
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

  // Resume the last party after the app restarts.
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
    async (languages: ("en" | "hi")[], vibe: Vibe) => {
      setStarting(true);
      setError(null);
      try {
        playlist.clear();
        loaded.current = [];
        const q = await ok<Queue>(await api.sessions.$post({ json: { languages, vibe } }));
        await SecureStore.setItemAsync(SESSION_KEY, q.sessionId);
        apply(q);
        const first = q.committed[0];
        if (first) void send(first.videoId, "start").catch(() => {});
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setStarting(false);
      }
    },
    [api, apply, playlist, send],
  );

  const press = useCallback(
    async (button: Button, now: boolean) => {
      if (!sessionId) return;
      const res = await api.sessions[":id"].control.$post({
        param: { id: sessionId },
        json: { kind: "button", button, now },
      });
      apply(await ok<Queue>(res));
    },
    [api, sessionId, apply],
  );

  const skip = useCallback(() => {
    if (playlist.currentIndex >= loaded.current.length - 1) return;
    reason.current = "skip";
    playlist.next();
  }, [playlist]);

  const togglePlay = useCallback(() => {
    if (playlist.playing) playlist.pause();
    else playlist.play();
  }, [playlist]);

  const restart = useCallback(() => void playlist.seekTo(0), [playlist]);

  const like = useCallback(async () => {
    const id = loaded.current[playlist.currentIndex];
    if (id) await send(id, "like");
  }, [playlist, send]);

  const end = useCallback(async () => {
    if (sessionId)
      await api.sessions[":id"].end.$post({ param: { id: sessionId } }).catch(() => {});
    await SecureStore.deleteItemAsync(SESSION_KEY);
    playlist.pause();
    playlist.clear();
    playlist.clearLockScreenControls();
    loaded.current = [];
    setQueue(null);
  }, [api, sessionId, playlist]);

  const upcoming = useCallback(async () => {
    if (!sessionId) return [];
    const q = await ok<Queue>(await api.sessions[":id"].$get({ param: { id: sessionId } }));
    return q.upcoming ?? [];
  }, [api, sessionId]);

  const nowPlaying = {
    now: songs.current.get(loaded.current[status.currentIndex] ?? ""),
    next: songs.current.get(loaded.current[status.currentIndex + 1] ?? ""),
  };

  return (
    <Ctx.Provider
      value={{
        queue,
        status,
        starting,
        error,
        start,
        press,
        skip,
        togglePlay,
        restart,
        like,
        end,
        upcoming,
        nowPlaying,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

/** The song the native player is on right now (it can be a beat ahead of the server). */
export function useNowPlaying(): { now: Song | undefined; next: Song | undefined } {
  const { nowPlaying } = useParty();
  return nowPlaying;
}

import type { AppType } from "@thej/api";
import { hc } from "hono/client";
import { useMemo } from "react";
import { DEV_USER, useSession } from "./auth";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "https://thej.rraj.dev";

/** Typed Hono RPC client. Every call gets a fresh Clerk token (they expire after a minute). */
export function createApi(getToken: () => Promise<string | null>) {
  return hc<AppType>(API_URL, {
    headers: async (): Promise<Record<string, string>> => {
      if (DEV_USER) return { "x-dev-user": DEV_USER };
      const token = await getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  });
}
export type Api = ReturnType<typeof createApi>;

export function useApi() {
  const { getToken } = useSession();
  return useMemo(() => createApi(getToken), [getToken]);
}

type Res = { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };

export async function ok<T>(res: Res): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

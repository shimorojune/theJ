import type { AppType } from "@thej/api";
import { hc } from "hono/client";

// Dev: Vite proxies /api to the local api. Prod: set VITE_API_URL to the api's public URL.
const baseUrl = import.meta.env.VITE_API_URL ?? "/api";

/** Typed Hono RPC client. Pass Clerk's getToken so every call is authenticated. */
export function createApi(getToken: () => Promise<string | null>) {
  return hc<AppType>(new URL(baseUrl, location.origin).toString(), {
    headers: async (): Promise<Record<string, string>> => {
      const token = await getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  });
}

import type { AppType } from "@thej/api";
import { hc } from "hono/client";

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

/** Typed Hono RPC client. Pass Clerk's getToken so every call is authenticated. */
export function createApi(getToken: () => Promise<string | null>) {
  return hc<AppType>(baseUrl, {
    headers: async (): Promise<Record<string, string>> => {
      const token = await getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  });
}

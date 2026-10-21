# theJ conventions

- TypeScript everywhere on Node 24. pnpm workspaces (hoisted, for Expo); run scripts with `pnpm <script>` from the root. Server code runs through `tsx`, no build step.
- Shared types and zod schemas go in `packages/shared`; DB schema only in `packages/db/src/schema.ts`.
- The api exports `AppType`; the app uses the Hono RPC client (`apps/mobile/src/lib/api.ts`). Keep routes chained so types flow.
- Lint/format: `pnpm lint` / `pnpm format` (Biome). Typecheck: `pnpm typecheck`.
- Mobile deps: add with `npx expo install <pkg>` (from apps/mobile) so versions match the Expo SDK.
- Never commit secrets (proxy password, Tailscale keys, Clerk secret, keystores). Use `.env` locally, Dokploy env in prod.
- Tailscale node/tag names keep the `deejay-` prefix because they are live.
- Mobile playback uses expo-audio's AudioPlaylist mirrored from the server's committed queue (src/party/PartyProvider.tsx); the server decides what plays.
- The api lives at https://thej.rraj.dev (Dokploy domain on the `api` service).

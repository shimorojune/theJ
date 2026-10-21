# theJ conventions

- TypeScript everywhere. Bun workspaces; run scripts with `bun run` from the root.
- Shared types and zod schemas go in `packages/shared`; DB schema only in `packages/db/src/schema.ts`.
- The api exports `AppType`; the app uses the Hono RPC client (`apps/mobile/src/lib/api.ts`). Keep routes chained so types flow.
- Lint/format: `bun run lint` / `bun run format` (Biome). Typecheck: `bun run typecheck`.
- Web PWA (`apps/web`) is mobile-view only: one phone-width column (max 430px), tokens in `src/styles.css` from the design canvas.
- Mobile deps: add with `bunx expo install <pkg>` so versions match the Expo SDK.
- Never commit secrets (proxy password, Tailscale keys, Clerk secret, keystores). Use `.env` locally, Dokploy env in prod.
- Tailscale node/tag names keep the `deejay-` prefix because they are live.

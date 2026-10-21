# theJ

A party DJ app: an Expo Android player with 4 vibe buttons and a text box, backed by a TypeScript
service that fetches songs with yt-dlp, analyses them once, and plans the queue.
- Architecture: https://claude.ai/artifact/K27oLAioiXiv8jqpH9zVCv
- Design canvas: https://claude.ai/artifact/7tEmKnkjEaBdgfeuuENAn3

## Layout

```
apps/
  mobile/    Expo 58 Android app (Expo Router, Clerk, react-native-track-player)
  api/       Hono on Node: Clerk JWT auth, sessions, SSE, signed audio URLs
  workers/   BullMQ workers, one entrypoint each: fetcher, analysis, planner
packages/
  shared/    zod schemas, queue names, DJ engine math (used by app, api, workers)
  db/        Drizzle schema + client for Postgres
infra/       local dev compose, Dokploy stack, home proxy (see infra/README.md)
```

## Getting started

Needs Node 24+, pnpm 9+ and Docker (or OrbStack) for local Postgres, Redis and MinIO.

```sh
pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:generate && pnpm db:migrate
pnpm dev:api             # http://localhost:3000/health
pnpm dev:fetcher         # needs yt-dlp + ffmpeg locally, or run it on Dokploy
```

Fetch pipeline (fetcher + bgutil + analysis run in Docker, so no yt-dlp/ffmpeg on the Mac):

```sh
pnpm workers:up                  # build + start the workers (profile "workers")
pnpm seed                        # resolve 50 Hindi + English songs, queue fetches
pnpm status                      # tracks per status + features of ready songs
pnpm requeue                     # retry failed jobs
pnpm workers:logs
```

Downloads go direct unless `HOME_PROXY` is set. That's fine when the Mac is on the home network
(same exit IP as the proxy). Elsewhere, run `pnpm proxy:forward` and set `HOME_PROXY` as in `.env.example`.

Engine + api from the terminal (dev auth, no Clerk needed locally):

```sh
pnpm dev:api                     # DEV_AUTH=1: accepts x-dev-user instead of a Clerk token
pnpm cli start en,hi 0.3 0.4     # start a party at low energy, mid-low mood
pnpm cli queue                   # now playing, next 2, projected plan
pnpm cli hype [now]              # buttons: hype / chill / brighter / moodier, "now" = long press
pnpm cli play 4                  # finish 4 songs, watch the target ramp
pnpm cli watch                   # follow the SSE stream
pnpm test                        # engine + signing unit tests
```

Mobile (needs a dev build, not Expo Go, because of track-player):

```sh
cd apps/mobile && cp .env.example .env
npx expo run:android             # dev build on a connected device / emulator
pnpm build:apk                   # eas build --local, sideloadable APK
```

## Build order

1. Fetch pipeline: fetcher via home proxy → MinIO → ReccoBeats, 50 Hindi + English songs
2. Engine + api: scorer, ramp, sessions, Clerk auth, SSE
3. Expo player: RNTP, background playback, lock screen, signed URLs
4. LLM layer: interpret / refill via OpenRouter, bucket cache, daily cap
5. Hardening: proxy fallback, Essentia fallback, eviction job, metrics

## Secrets

Never commit secrets. Real values live in Dokploy / Portainer env. The Android release keystore stays
out of the repo and must be backed up: losing it means every phone has to reinstall.

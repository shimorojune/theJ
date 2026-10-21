# infra

| File                                | Where it runs    | Status                                                   |
| ----------------------------------- | ---------------- | -------------------------------------------------------- |
| `dev.compose.yml`                   | your Mac         | Postgres, Redis, MinIO for local dev                     |
| `dokploy/thej.compose.yml`          | Dokploy VPS      | target production stack                                  |
| `dokploy/fetcher-probe.compose.yml` | Dokploy VPS      | **live**: the probe that proved 10/10 downloads via home |
| `home/home-proxy.live.compose.yml`  | Umbrel Portainer | **live**: stack `deejay-home-proxy`                      |
| `home/home-proxy.compose.yml`       | Umbrel Portainer | hardened version (own Tailscale node, no LAN port)       |

No secret values live here. They come from Dokploy / Portainer environment variables.

## Egress path

fetcher + bgutil → tailscale sidecar (`deejay-fetcher`) → tailnet → home gost `:1080` → YouTube from the residential IP.
The home box only forwards traffic. yt-dlp, Deno, bgutil and nightly updates all run on the VPS.

Live: `HOME_PROXY_IP` is Umbrel's own Tailscale IP (100.104.87.114). The proxy is also reachable on the home LAN
(password-protected); make sure the router does not forward port 1080.

## Setup (hardened version)

1. Tailscale ACL: `tagOwners` for `tag:deejay-proxy` and `tag:deejay-fetcher` = `autogroup:admin`; grant
   src `tag:deejay-fetcher` → dst `tag:deejay-proxy`, `tcp:1080`. Has no effect while the default allow-all
   rule exists; the SOCKS password covers that gap.
2. Create two tagged auth keys (proxy, fetcher), not ephemeral, single use.
3. Umbrel Portainer: add the home stack with `TS_AUTHKEY` and `PROXY_PASS` (letters and digits only). Copy the node's 100.x IP.
   Use named volumes only (Umbrel wipes bind mounts) and keep this file in the repo (uninstalling Portainer deletes the stack).
4. Dokploy: fetcher compose with `TS_AUTHKEY`, `HOME_PROXY_IP`, `PROXY_PASS`. In the probe logs, "Egress via home"
   should show the home IP and "RESULT x/10".

## Troubleshooting

- `/dev/net/tun` missing: set `TS_USERSPACE: "true"` and drop `devices`/`cap_add`.
- `PROXY UNREACHABLE`: both nodes online? right IP? ACL allows `tcp:1080`?
- "Sign in to confirm you're not a bot" even via home: the home IP is flagged. Wait a day, or add cookies from a throwaway account.

## Failover (to build in the fetcher)

Every 30 s, SOCKS-connect and fetch `https://www.youtube.com/generate_204`. After 2 minutes of failures, or 3 failed
jobs in a row, switch `--proxy` to `FALLBACK_PROXY` until home is healthy again.

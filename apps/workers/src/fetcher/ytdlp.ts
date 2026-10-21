import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/run";

/**
 * Downloads format 140 (AAC m4a) and remuxes with faststart so phones can seek and start early.
 * Every request goes out through `proxy` (the home SOCKS5 proxy) when set. bgutil's PO-token
 * plugin is used automatically; BGUTIL_URL overrides where its server lives (default localhost).
 */
export async function downloadAudio(
  videoId: string,
  proxy?: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "thej-"));
  const raw = join(dir, "raw.m4a");
  const out = join(dir, "out.m4a");
  const cleanup = () => rm(dir, { recursive: true, force: true });

  const args = ["-q", "--no-warnings", "--no-playlist", "-f", "140/bestaudio[ext=m4a]", "-o", raw];
  if (proxy) args.push("--proxy", proxy);
  if (process.env.BGUTIL_URL) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_URL}`);
  }
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  try {
    await run("yt-dlp", args);
    await run("ffmpeg", [
      "-loglevel",
      "error",
      "-i",
      raw,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ]);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { path: out, cleanup };
}

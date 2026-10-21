import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Downloads format 140 (AAC m4a) and remuxes with faststart so phones can seek and start early.
 * Every request goes out through `proxy` (the home SOCKS5 proxy) when set.
 */
export async function downloadAudio(videoId: string, proxy?: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "thej-"));
  const raw = join(dir, "raw.m4a");
  const out = join(dir, "out.m4a");

  const args = ["-q", "--no-warnings", "--no-playlist", "-f", "140", "-o", raw];
  if (proxy) args.push("--proxy", proxy);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

  await run("yt-dlp", args);
  await run("ffmpeg", ["-loglevel", "error", "-i", raw, "-c", "copy", "-movflags", "+faststart", out]);
  return { path: out, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function run(cmd: string, args: string[]) {
  const p = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const err = (await new Response(p.stderr).text()).trim().split("\n").at(-1);
    throw new Error(`${cmd} exited ${code}: ${err}`);
  }
}

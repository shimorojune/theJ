import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Downloads format 140 (AAC m4a) and remuxes with faststart so phones can seek and start early.
 * Every request goes out through `proxy` (the home SOCKS5 proxy) when set.
 */
export async function downloadAudio(
  videoId: string,
  proxy?: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "thej-"));
  const raw = join(dir, "raw.m4a");
  const out = join(dir, "out.m4a");

  const args = ["-q", "--no-warnings", "--no-playlist", "-f", "140", "-o", raw];
  if (proxy) args.push("--proxy", proxy);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);

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
  return { path: out, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d;
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split("\n").at(-1)}`));
    });
  });
}

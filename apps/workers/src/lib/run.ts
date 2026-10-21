import { spawn } from "node:child_process";

/** Runs a command, resolves with stdout, rejects with the last stderr line. */
export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d;
    });
    p.stderr.on("data", (d) => {
      stderr += d;
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      const last = stderr.trim().split("\n").at(-1) ?? "";
      reject(new Error(`${cmd} exited ${code}: ${last}`));
    });
  });
}

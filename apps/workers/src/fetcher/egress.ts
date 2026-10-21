import { run } from "../lib/run";

const CHECK_EVERY_MS = 30_000;
const FAIL_AFTER_MS = 2 * 60_000;
const FAIL_AFTER_JOBS = 3;

export const isBotCheck = (err: Error) => /sign in to confirm|not a bot/i.test(err.message);

/** Errors that point at the exit IP or the proxy rather than the song. */
const EGRESS_ERROR =
  /sign in to confirm|not a bot|proxy|socks|timed out|connection|HTTP Error 403|429/i;

/**
 * Chooses the proxy for each download. Home is preferred. After 2 minutes of failed health checks,
 * or 3 egress-type job failures in a row, it switches to FALLBACK_PROXY until home is healthy again.
 */
export class Egress {
  private homeDownSince: number | undefined;
  private jobFailures = 0;
  private onFallback = false;

  constructor(
    private readonly home: string | undefined,
    private readonly fallback: string | undefined,
  ) {}

  get proxy(): string | undefined {
    return this.onFallback ? this.fallback : this.home;
  }

  /** True when a fallback exists and isn't in use yet, so a blocked IP can be routed around. */
  get canSwitch(): boolean {
    return Boolean(this.fallback) && !this.onFallback;
  }

  get label(): string {
    if (!this.home) return "direct";
    return this.onFallback ? "fallback" : "home";
  }

  start() {
    if (!this.home) return;
    const tick = () => void this.check();
    tick();
    setInterval(tick, CHECK_EVERY_MS).unref();
  }

  reportJob(err?: Error) {
    if (!err) {
      this.jobFailures = 0;
      return;
    }
    if (EGRESS_ERROR.test(err.message) && !this.onFallback) this.jobFailures++;
    this.evaluate();
  }

  private async check() {
    const healthy = await probe(this.home as string);
    if (healthy) {
      this.homeDownSince = undefined;
      this.jobFailures = 0;
      if (this.onFallback) {
        this.onFallback = false;
        console.log("egress: home proxy healthy again, switching back");
      }
    } else {
      this.homeDownSince ??= Date.now();
      console.warn("egress: home proxy health check failed");
    }
    this.evaluate();
  }

  private evaluate() {
    if (this.onFallback || !this.fallback) return;
    const downLong = this.homeDownSince && Date.now() - this.homeDownSince >= FAIL_AFTER_MS;
    if (downLong || this.jobFailures >= FAIL_AFTER_JOBS) {
      this.onFallback = true;
      console.warn("egress: switching to fallback proxy");
    }
  }
}

async function probe(proxy: string): Promise<boolean> {
  try {
    const code = await run("curl", [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-m",
      "10",
      "-x",
      proxy,
      "https://www.youtube.com/generate_204",
    ]);
    return code.trim() === "204";
  } catch {
    return false;
  }
}

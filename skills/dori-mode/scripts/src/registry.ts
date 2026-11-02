import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly pane?: string;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus;
  readonly receipt?: unknown;
};

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

/**
 * Per-key lock `<lanesDir>/<key>.lock/` holding owner.json = {pid, bootAtMs, processStartedAtMs, at, nonce}. The same
 * protocol is implemented in ~/.omocat/registry.ts (acquireDirLock); registry.test.ts in both repos runs the two against
 * one lane file. A lock is reclaimed only when its process is gone (dead pid, other boot, reused pid); a live holder
 * makes the caller wait up to 30 s and then fail with lock_wait.
 */
export class LockWaitError extends Error {}
const OWN_START = Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000;
const bootAtMs = (): number => Math.round((Date.now() - uptime() * 1000) / 1000) * 1000;
const readText = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};
const startOf = async (pid: number): Promise<number | undefined> => {
  const p = Bun.spawn(["ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(out);
  if (!m) return undefined;
  const secs = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
  return Math.floor(Date.now() / 1000) * 1000 - secs * 1000;
};
const ownerLive = async (o: { pid?: unknown; bootAtMs?: unknown; processStartedAtMs?: unknown }): Promise<boolean> => {
  if (typeof o.pid !== "number") return false;
  if (typeof o.bootAtMs === "number" && Math.abs(o.bootAtMs - bootAtMs()) > 120_000) return false;
  if (o.pid === process.pid) return typeof o.processStartedAtMs !== "number" || Math.abs(o.processStartedAtMs - OWN_START) <= 3_000;
  try {
    process.kill(o.pid, 0);
  } catch (e) {
    if ((e as { code?: string }).code !== "EPERM") return false;
  }
  if (typeof o.processStartedAtMs !== "number") return true;
  const seen = await startOf(o.pid);
  return seen === undefined || Math.abs(seen - o.processStartedAtMs) <= 3_000;
};

export const acquireKeyLock = async (dir: string, waitMs = 30_000): Promise<() => void> => {
  const owner = join(dir, "owner.json");
  const mine = JSON.stringify({ pid: process.pid, bootAtMs: bootAtMs(), processStartedAtMs: OWN_START, at: new Date().toISOString(), nonce: crypto.randomUUID() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(owner, mine);
      return () => {
        if (readText(owner) === mine) rmSync(dir, { recursive: true, force: true });
      };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    const raw = readText(owner);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      parsed = null;
    }
    let stale: boolean;
    if (parsed) stale = !(await ownerLive(parsed));
    else {
      let age = 0;
      try {
        age = Date.now() - statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      stale = age > 30_000;
    }
    if (stale) {
      const aside = `${dir}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.broken`;
      try {
        renameSync(dir, aside);
      } catch {
        continue;
      }
      if (readText(join(aside, "owner.json")) !== raw) {
        try {
          renameSync(aside, dir);
          continue;
        } catch {
          // a fresh lock took the name meanwhile; the displaced one cannot be restored
        }
      }
      rmSync(aside, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new LockWaitError(`lock_wait ${dir} held by pid ${String(parsed?.pid ?? "?")}`);
    await Bun.sleep(50);
  }
};

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? ((await f.json()) as Lane) : null;
  }

  /**
   * The one writer of a lane file: under the key's lock, re-read the lane, apply `fn`, and publish with temp file +
   * rename. `fn` returning null writes nothing. Returns the lane as stored afterwards.
   */
  async update(key: string, fn: (current: Lane | null) => Lane | null): Promise<Lane | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(key)) throw new Error(`bad lane key ${key}`);
    mkdirSync(this.dir, { recursive: true });
    const release = await acquireKeyLock(join(this.dir, `${key}.lock`));
    try {
      const file = this.path(key);
      const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Lane) : null;
      const next = fn(current);
      if (next === null) return current;
      const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 1));
      renameSync(tmp, file);
      return next;
    } finally {
      release();
    }
  }

  /** Whole-lane replace, still under the key lock (test fixtures); flows use update(). */
  async write(lane: Lane): Promise<void> {
    await this.update(lane.key, () => lane);
  }

  async list(): Promise<Lane[]> {
    mkdirSync(this.dir, { recursive: true });
    const lanes: Lane[] = [];
    for (const f of readdirSync(this.dir)) if (f.endsWith(".json")) lanes.push((await Bun.file(join(this.dir, f)).json()) as Lane);
    return lanes;
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  async byPane(pane: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane) ?? null;
  }
}

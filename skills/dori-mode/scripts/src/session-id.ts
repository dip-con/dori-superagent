import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";

export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string };
export type SessionHit = { readonly id: string; readonly via: "argv" | "child-env" | "start-time" | "none"; readonly pid?: number };

const AGENT = /senpi\/dist\/bundle\/cli\.js|(^|\/)omo(\s|$)/;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

export const procTable = async (run: Runner): Promise<Proc[]> =>
  (await run(["ps", "-A", "-o", "pid=,ppid=,command="])).out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" }] : [];
  });

const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

export const sessionDirFor = (sessionsDir: string, cwd: string): string => join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);

/** The session file for `id`: in the cwd's directory when it is known, else searched across every session directory. */
export const findSessionFile = (sessionsDir: string, id: string, cwd?: string): string | undefined => {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const suffix = `_${id}.jsonl`;
  const list = (d: string): string[] => { try { return readdirSync(d); } catch { return []; } };
  const dirs = cwd ? [sessionDirFor(sessionsDir, cwd)] : [];
  for (const dir of [...dirs, ...list(sessionsDir).map((d) => join(sessionsDir, d))]) {
    const hit = list(dir).find((n) => n.endsWith(suffix));
    if (hit) return join(dir, hit);
  }
  return undefined;
};

/** The last `bytes` of a JSONL file as parsed entries (a cut first line and unparsable lines are skipped). Session files grow to hundreds of MB. */
export const readSessionTail = (file: string, bytes = 1 << 20): Record<string, unknown>[] => {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((l) => {
      if (!l.trim()) return [];
      try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
    });
  } finally {
    closeSync(fd);
  }
};

export type SessionDeps = { readonly run: Runner; readonly sessionsDir: string; readonly listDir?: (dir: string) => readonly string[] };

export const resolveSession = async (pane: string, cwd: string, table: readonly Proc[], deps: SessionDeps): Promise<SessionHit> => {
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", pane]);
  const shellPid = info.code === 0 ? Number((JSON.parse(info.out) as { result?: { process_info?: { shell_pid?: number } } }).result?.process_info?.shell_pid ?? 0) : 0;
  const agent = shellPid ? descendants(table, shellPid).find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd)) : undefined;
  if (!agent) return { id: "", via: "none" };
  const argv = agent.cmd.split(/\s+/);
  const flagAt = argv.indexOf("--session");
  const fromFlag = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
  if (fromFlag) return { id: fromFlag, via: "argv", pid: agent.pid };
  for (const child of descendants(table, agent.pid).slice(0, 40)) {
    const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)]);
    const hit = ENV_ID.exec(env.out);
    if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
  }
  const started = Date.parse((await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list = deps.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const near = list(sessionDirFor(deps.sessionsDir, cwd)).flatMap((name) => {
    const m = SESSION_FILE.exec(name);
    const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
    return m?.[5] && at >= started - 5_000 && at <= started + START_WINDOW_MS ? [{ id: m[5], at }] : [];
  }).sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};

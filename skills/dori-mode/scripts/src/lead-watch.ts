import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { unacked } from "./ack.ts";
import { type DoriConfig, fill } from "./config.ts";
import { listPanes, readScreen } from "./panes.ts";
import type { Clock, Runner } from "./run.ts";
import { findSessionFile, procTable, readSessionTail, resolveSession } from "./session-id.ts";

/**
 * Watches the lead session itself, which no lane sweep covers: a lead that is paused (Esc), interrupted, stuck inside
 * one tool call, or idle while owner messages stay unacked never sees the events queued for it, because omo holds
 * its monitor events while it is paused. Read from the session file's own lifecycle entries, never from the screen.
 */
export type LeadStateKind = "running" | "tool-wait" | "paused" | "interrupted" | "idle" | "unknown";
export type LeadState = { readonly kind: LeadStateKind; readonly since: number };

type Entry = Record<string, unknown>;
const at = (e: Entry): number => Date.parse(String(e.timestamp ?? ""));

export const leadStateFrom = (entries: readonly Entry[]): LeadState => {
  const life = entries.findLast((e) => e.type === "custom" && e.customType === "session-lifecycle");
  if (!life) return { kind: "unknown", since: Number.NaN };
  const d = (life.data ?? {}) as { state?: string; interrupted?: boolean; since?: string };
  const since = Date.parse(d.since ?? "") || at(life);
  if (d.interrupted) return { kind: "interrupted", since };
  if (d.state === "paused") return { kind: "paused", since };
  if (d.state !== "running") return { kind: d.state ? "idle" : "unknown", since };
  const msgs = entries.filter((e) => e.type === "message");
  const last = msgs.at(-1)?.message as { role?: string; content?: unknown } | undefined;
  const calls = last?.role === "assistant" && Array.isArray(last.content) && last.content.some((p: { type?: string }) => p.type === "toolCall");
  return calls ? { kind: "tool-wait", since: at(msgs.at(-1)!) } : { kind: "running", since };
};

/** omo's footer on a session paused by Esc ("Paused · N updates held · type to continue, /resume to resume"). */
export const PAUSED = /\bPaused\b.*\/resume\b/;

/** The omo input line holds nothing the owner typed, so typing /resume cannot submit or mangle their text (from dev-bokdong/dori-mode, MIT). */
export const emptyInput = (screen: string): boolean => {
  const input = screen.split("\n").reverse().find((line) => line.trimStart().startsWith("\u276f"));
  return input !== undefined && input.trimStart().slice(1).trim() === "";
};

type Seen = { paused?: string; unread?: string; resumed?: string; proposed?: string };
const seenFile = (stateDir: string): string => join(stateDir, "lead-watch.json");
const loadSeen = (stateDir: string): Seen => {
  try { return existsSync(seenFile(stateDir)) ? (JSON.parse(readFileSync(seenFile(stateDir), "utf8")) as Seen) : {}; } catch { return {}; }
};
const saveSeen = (stateDir: string, seen: Seen): void => {
  const tmp = `${seenFile(stateDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(seen));
  renameSync(tmp, seenFile(stateDir));
};

export type LeadWatchDeps = { readonly config: DoriConfig; readonly run: Runner; readonly clock: Clock };

export const leadSessionFile = async (deps: LeadWatchDeps): Promise<string | undefined> => {
  const { config, run } = deps;
  if (config.leadSessionFile) return config.leadSessionFile;
  if (!config.leadPane) return undefined;
  const pane = (await listPanes(run)).find((p) => p.pane_id === config.leadPane);
  if (!pane?.cwd) return undefined;
  const hit = await resolveSession(pane.pane_id, pane.cwd, await procTable(run), { run, sessionsDir: config.sessionsDir });
  return hit.id ? findSessionFile(config.sessionsDir, hit.id, pane.cwd) : undefined;
};

const STOPPED: ReadonlySet<LeadStateKind> = new Set(["paused", "interrupted"]);
const mins = (ms: number): number => Math.round(ms / 60_000);

/**
 * One check. LEAD_PAUSED once per pause that lasts leadWatch.pausedMin; LEAD_UNREAD once per (oldest unacked message,
 * lead state) when an owner message waits leadUnreadRestartMin while the lead is not running. With leadWatch.autoResume
 * a paused lead gets `/resume` once per pause, only into an empty input line; with leadWatch.restartProposeMin a
 * LEAD_RESTART_PROPOSED line is printed. It never restarts the lead. Every LEAD_* line also runs hooks.leadAlert.
 */
export const leadWatchTick = async (deps: LeadWatchDeps, state: LeadState): Promise<string[]> => {
  const { config, run } = deps;
  if (!config.features.leadWatch || state.kind === "unknown") return [];
  const now = deps.clock.now();
  const seen = loadSeen(config.stateDir);
  const before = JSON.stringify(seen);
  const out: string[] = [];
  const episode = `${state.kind}:${state.since}`;
  const sinceIso = Number.isFinite(state.since) ? new Date(state.since).toISOString() : "?";
  const pending = unacked(config.stateDir).filter((o) => now - o.at >= config.leadUnreadRestartMin * 60_000);
  if (STOPPED.has(state.kind) && now - state.since >= config.leadWatch.pausedMin * 60_000 && seen.paused !== episode) {
    out.push(`LEAD_PAUSED ${state.kind} ${mins(now - state.since)}m since=${sinceIso} unacked=${unacked(config.stateDir).length}`);
    seen.paused = episode;
  }
  const oldest = pending[0];
  if (oldest && state.kind !== "running") {
    const key = `${oldest.channel}-${oldest.message}:${episode}`;
    if (seen.unread !== key) {
      out.push(`LEAD_UNREAD ${state.kind} ${pending.length} oldest=${oldest.channel} ${oldest.message} ${mins(now - oldest.at)}m since=${sinceIso}`);
      seen.unread = key;
    }
    if (config.leadWatch.autoResume && STOPPED.has(state.kind) && config.leadPane && seen.resumed !== episode) {
      seen.resumed = episode;
      const screen = await readScreen(run, config.leadPane, 40);
      if (!PAUSED.test(screen)) out.push(`LEAD_RESUME_SKIPPED ${config.leadPane}: no Paused footer on screen`);
      else if (!emptyInput(screen)) out.push(`LEAD_PAUSED_INPUT ${config.leadPane}: paused with text in its input; not typing`);
      else {
        const sent = (await run(["herdr", "pane", "send-text", config.leadPane, "/resume"])).code === 0 && (await run(["herdr", "pane", "send-keys", config.leadPane, "enter"])).code === 0;
        out.push(`LEAD_RESUMED ${config.leadPane} ${sent ? "sent" : "send-failed"}`);
      }
    }
    if (config.leadWatch.restartProposeMin > 0 && now - oldest.at >= config.leadWatch.restartProposeMin * 60_000 && seen.proposed !== key) {
      out.push(`LEAD_RESTART_PROPOSED ${state.kind} oldest=${mins(now - oldest.at)}m: the lead has not read owner messages; restart it by hand (dori never restarts the lead)`);
      seen.proposed = key;
    }
  }
  if (JSON.stringify(seen) !== before) saveSeen(config.stateDir, seen);
  const hook = config.hooks.leadAlert;
  if (hook) {
    for (const line of out.filter((l) => /^LEAD_(PAUSED|UNREAD|RESTART_PROPOSED) /.test(l))) {
      const r = await run(fill(hook, { text: line }));
      if (r.code !== 0) out.push(`LEAD_ALERT_FAILED exit ${r.code}: ${(r.err || r.out).slice(0, 160)}`);
    }
  }
  return out;
};

export const leadStateOf = (file: string): LeadState => leadStateFrom(readSessionTail(file, 2 << 20));

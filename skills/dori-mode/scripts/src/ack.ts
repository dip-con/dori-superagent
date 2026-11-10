import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MessengerError } from "./messenger/http.ts";

/**
 * Owner-message obligations, named after dev-bokdong/dori-mode (`dori ack`, `dori handled`, `ackTimeoutSec`,
 * `handledTimeoutMin`), without its supervisor: whatever receives a message (a Discord listener, a card watcher)
 * registers it with `dori track`, the lead confirms with `dori ack` / `dori handled`, and `dori obligations` prints
 * UNACKED / UNHANDLED once each. Nothing is posted to the owner.
 *
 * State: one directory, one file per message and event (`<channel>-<message>.<event>.json`), each written once by a
 * single writer (tmp + rename), so the receiver, the lead and the sweep never rewrite each other's file.
 */
export const HOURGLASS = "\u23F3";
export const EYES = "\u{1F440}";

export type Reactions = {
  readonly react: (channel: string, message: string, emoji: string) => Promise<void>;
  readonly unreact: (channel: string, message: string, emoji: string) => Promise<void>;
};

export class AckError extends Error {}

const ID = /^\d+$/;
const SOURCE = /^[\w.-]{1,40}$/;
const LANE = /^[\w.-]+$/;
const EVENTS = ["track", "ack", "handled", "unacked", "unhandled"] as const;
type Event = (typeof EVENTS)[number];
const FILE = /^(\d+)-(\d+)\.(track|ack|handled|unacked|unhandled)\.json$/;
const DAY = 86_400_000;
/** Groups older than this are pruned whatever their state; a handled one goes a day after it was handled. */
const KEEP_MS = 7 * DAY;

export const obligationsDir = (stateDir: string): string => join(stateDir, "owner-messages");

const check = (channel: string, message: string): void => {
  if (!ID.test(channel) || !ID.test(message)) throw new AckError("channel and message must be Discord ids (digits only)");
};

const fileOf = (stateDir: string, channel: string, message: string, event: Event): string => join(obligationsDir(stateDir), `${channel}-${message}.${event}.json`);

/** Writes the event once; an existing file wins (the first ack is the ack). Returns false when it was already there. */
const writeOnce = (path: string, body: Record<string, unknown>): boolean => {
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(body), { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "EEXIST") return false;
    throw e;
  }
};

const writeAtomic = (path: string, body: Record<string, unknown>): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  renameSync(tmp, path);
};

const notThere = (e: unknown): boolean => e instanceof MessengerError && e.status === 404;

export type TrackInput = { readonly channel: string; readonly message: string; readonly source?: string; readonly text?: string };

/**
 * Registers a received message as an obligation and, with `hourglass`, puts the hourglass on it. A failed reaction
 * is reported but the obligation is still recorded: the timer matters more than the emoji.
 */
export const track = async (stateDir: string, reactions: Reactions | undefined, input: TrackInput, now: number): Promise<string> => {
  check(input.channel, input.message);
  const source = input.source ?? "owner";
  if (!SOURCE.test(source)) throw new AckError("--source must be 1-40 of [A-Za-z0-9_.-]");
  const fresh = writeOnce(fileOf(stateDir, input.channel, input.message, "track"), { at: now, source, text: (input.text ?? "").slice(0, 200) });
  if (!fresh) return `TRACK_EXISTS ${input.channel} ${input.message}`;
  if (!reactions) return `TRACKED ${input.channel} ${input.message} ${source}`;
  try {
    await reactions.react(input.channel, input.message, HOURGLASS);
    return `TRACKED ${input.channel} ${input.message} ${source} hourglass`;
  } catch (e) {
    return `TRACKED ${input.channel} ${input.message} ${source} hourglass-failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
};

/**
 * The lead's read receipt: hourglass off, eyes on, then the ack is recorded. It is recorded only once the eyes are on,
 * so a failed reaction leaves the message unacked and the sweep keeps it due. An untracked message can be acked too.
 */
export const ack = async (stateDir: string, reactions: Reactions, channel: string, message: string, now: number): Promise<string> => {
  check(channel, message);
  try {
    await reactions.unreact(channel, message, HOURGLASS);
  } catch (e) {
    if (!notThere(e)) throw e;
  }
  await reactions.react(channel, message, EYES);
  const fresh = writeOnce(fileOf(stateDir, channel, message, "ack"), { at: now });
  return `${fresh ? "ACKED" : "ACK_EXISTS"} ${channel} ${message}`;
};

export type Handled = { readonly lanes?: readonly string[]; readonly reply?: boolean; readonly note?: string };

export const recordHandled = (stateDir: string, channel: string, message: string, now: number, handled: Handled): string => {
  check(channel, message);
  if (!handled.lanes?.length && !handled.reply) throw new AckError("handled needs --lane <key> and/or --reply");
  if (handled.lanes?.some((l) => !LANE.test(l))) throw new AckError("--lane must name a lane key");
  writeAtomic(fileOf(stateDir, channel, message, "handled"), { at: now, ...(handled.lanes?.length ? { lanes: handled.lanes } : {}), ...(handled.reply ? { reply: true } : {}), ...(handled.note ? { note: handled.note.slice(0, 200) } : {}) });
  return `HANDLED ${channel} ${message}`;
};

export type Obligation = {
  readonly channel: string;
  readonly message: string;
  readonly source: string;
  readonly text: string;
  readonly at: number;
  readonly ackedAt?: number;
  readonly handledAt?: number;
  readonly unackedSent: boolean;
  readonly unhandledSent: boolean;
};

const readAt = (path: string): { at: number; source?: string; text?: string } | undefined => {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown; source?: unknown; text?: unknown };
    return typeof j.at === "number" ? { at: j.at, ...(typeof j.source === "string" ? { source: j.source } : {}), ...(typeof j.text === "string" ? { text: j.text } : {}) } : undefined;
  } catch {
    return undefined;
  }
};

export const listObligations = (stateDir: string): Obligation[] => {
  let names: string[];
  try {
    names = readdirSync(obligationsDir(stateDir));
  } catch {
    return [];
  }
  const groups = new Map<string, Set<Event>>();
  for (const name of names) {
    const m = FILE.exec(name);
    if (!m) continue;
    const id = `${m[1]}-${m[2]}`;
    groups.set(id, (groups.get(id) ?? new Set()).add(m[3] as Event));
  }
  return [...groups].flatMap(([id, events]) => {
    if (!events.has("track")) return [];
    const [channel = "", message = ""] = id.split("-");
    const path = (e: Event) => fileOf(stateDir, channel, message, e);
    const t = readAt(path("track"));
    if (!t) return [];
    const ackedAt = events.has("ack") ? readAt(path("ack"))?.at : undefined;
    const handledAt = events.has("handled") ? readAt(path("handled"))?.at : undefined;
    return [{ channel, message, source: t.source ?? "owner", text: t.text ?? "", at: t.at, ...(ackedAt !== undefined ? { ackedAt } : {}), ...(handledAt !== undefined ? { handledAt } : {}), unackedSent: events.has("unacked"), unhandledSent: events.has("unhandled") }];
  });
};

export const unacked = (stateDir: string): Obligation[] => listObligations(stateDir).filter((o) => o.ackedAt === undefined && o.handledAt === undefined).sort((a, b) => a.at - b.at);

export type ObligationTimers = { readonly ackTimeoutSec: number; readonly handledTimeoutMin: number };

const quote = (text: string): string => JSON.stringify(text.replace(/\s+/g, " ").slice(0, 80));

/**
 * One sweep: UNACKED once a tracked message waits past ackTimeoutSec without an ack, UNHANDLED once it waits past
 * handledTimeoutMin from its ack (or its receipt, when it was never acked) without `dori handled`. Each fires once
 * per message. Old groups are pruned.
 */
export const obligationsTick = (stateDir: string, timers: ObligationTimers, now: number): string[] => {
  const out: string[] = [];
  for (const o of listObligations(stateDir)) {
    const path = (e: Event) => fileOf(stateDir, o.channel, o.message, e);
    if ((o.handledAt !== undefined && now - o.handledAt > DAY) || now - o.at > KEEP_MS) {
      for (const e of EVENTS) rmSync(path(e), { force: true });
      continue;
    }
    if (o.handledAt !== undefined) continue;
    if (o.ackedAt === undefined && !o.unackedSent && now - o.at >= timers.ackTimeoutSec * 1000) {
      if (writeOnce(path("unacked"), { at: now })) out.push(`UNACKED ${o.channel} ${o.message} ${o.source} ${Math.round((now - o.at) / 1000)}s ${quote(o.text)} -> dori ack ${o.channel} ${o.message}`);
    }
    const from = o.ackedAt ?? o.at;
    if (!o.unhandledSent && now - from >= timers.handledTimeoutMin * 60_000) {
      if (writeOnce(path("unhandled"), { at: now })) out.push(`UNHANDLED ${o.channel} ${o.message} ${o.source} ${Math.round((now - from) / 60_000)}m ${o.ackedAt === undefined ? "unacked" : "acked"} ${quote(o.text)} -> dori handled ${o.channel} ${o.message} --reply|--lane KEY`);
    }
  }
  return out;
};

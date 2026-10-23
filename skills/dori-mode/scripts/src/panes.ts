import { existsSync, readFileSync } from "node:fs";

import type { Clock, Runner } from "./run.ts";

const omocatHome = (): string => process.env.OMOCAT_HOME ?? `${process.env.HOME}/.omocat`;
/** Kill switch file for the adapter path (redesign S9/S10). Present: lane messages go through `sess.ts send <key>`. */
export const sendAdapterFlag = (): string => process.env.DORI_SEND_ADAPTER_FLAG ?? `${omocatHome()}/flags/dori.send-adapter`;
export const sessScript = (): string => `${omocatHome()}/sess.ts`;
/** The flag file lists the lane keys on the adapter path (whitespace/comma separated); an empty file means every lane (S10). */
export const sendAdapterOn = (key: string): boolean => {
  const f = sendAdapterFlag();
  if (!existsSync(f)) return false;
  const keys = readFileSync(f, "utf8").split(/[\s,]+/).filter(Boolean);
  return keys.length === 0 || keys.includes(key);
};

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

/** States herdr reports for a pane whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> =>
  (await listPanes(run)).find((p) => p.pane_id === pane)?.agent_status;

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (run: Runner, pane: string): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    return { status: await agentStatus(run, pane) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

/**
 * With the adapter flag present and naming this lane (or empty): `bun ~/.omocat/sess.ts send <key> <text> [--id <id>]` (RPC or receipt-checked herdr,
 * chosen per lane by transport.json); exit 0 = delivered (persisted receipt), 3 = unconfirmed, anything else = failed.
 * Nothing is typed into the pane on this path.
 *
 * Without the flag: types the text and presses Enter exactly once. Delivery is confirmed only by a state change: the
 * pane's agent_status moving to "working" from something else. A pane that was already working cannot show that change,
 * so its send comes back "unconfirmed" and the caller decides. The screen is never read here, and Enter is never pressed again.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string, key: string, id?: string): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  if (sendAdapterOn(key)) {
    const r = await run(["bun", sessScript(), "send", key, text, ...(id ? ["--id", id] : [])], { timeoutMs: 120_000 });
    if (r.code === 0) return "delivered";
    console.error(`sendVerified ${key}: sess.ts send exit ${r.code}: ${(r.err || r.out).slice(-200)}`);
    return r.code === 3 ? "unconfirmed" : "failed";
  }
  const before = await statusLookup(run, pane);
  if (before.error) console.error(`sendVerified ${pane}: status lookup failed before send: ${before.error}`);
  if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return "failed";
  await run(["herdr", "pane", "send-keys", pane, "enter"]);
  if (before.status === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    const after = await statusLookup(run, pane);
    if (after.error) console.error(`sendVerified ${pane}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};

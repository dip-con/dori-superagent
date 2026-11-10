import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ack, track } from "../src/ack.ts";
import { defaultConfig, type DoriConfig } from "../src/config.ts";
import { emptyInput, leadStateFrom, leadWatchTick } from "../src/lead-watch.ts";
import type { Ran, Runner } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const life = (ms: number, s: string, interrupted = false) => ({ type: "custom", customType: "session-lifecycle", timestamp: iso(ms), data: { state: s, since: iso(ms), interrupted } });
const assistantCall = (ms: number) => ({ type: "message", timestamp: iso(ms), message: { role: "assistant", content: [{ type: "toolCall", name: "memory", arguments: {} }] } });
const toolResult = (ms: number) => ({ type: "message", timestamp: iso(ms), message: { role: "toolResult", content: [] } });

test("the lead state comes from the newest lifecycle entry and a tool call with no result", () => {
  expect(leadStateFrom([life(T0, "running"), assistantCall(T0 + MIN)])).toEqual({ kind: "tool-wait", since: T0 + MIN });
  expect(leadStateFrom([life(T0, "running"), assistantCall(T0 + MIN), toolResult(T0 + 2 * MIN)]).kind).toBe("running");
  expect(leadStateFrom([life(T0, "running"), life(T0 + MIN, "paused")])).toEqual({ kind: "paused", since: T0 + MIN });
  expect(leadStateFrom([life(T0, "paused", true)]).kind).toBe("interrupted");
  expect(leadStateFrom([life(T0, "waiting_background")]).kind).toBe("idle");
  expect(leadStateFrom([]).kind).toBe("unknown");
});

type Call = string[];
const runner = (calls: Call[], screen = ""): Runner => async (argv) => {
  calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  if (argv[0] === "herdr" && argv[2] === "read") return ok(screen);
  if (argv[0] === "alert") return ok();
  return ok();
};
const cfg = (patch: Partial<DoriConfig> = {}): DoriConfig => ({ ...defaultConfig("/home/test"), stateDir: state.dir, leadPane: "lead:p1", hooks: { leadAlert: ["alert", "{text}"] }, ...patch });

test("a paused lead with an unread owner message raises LEAD_PAUSED and LEAD_UNREAD once each, through the alert hook", async () => {
  await track(state.dir, undefined, { channel: "11", message: "22" }, T0);
  const calls: Call[] = [];
  const paused = { kind: "paused" as const, since: T0 + MIN };
  const at = (ms: number) => ({ config: cfg(), run: runner(calls), clock: fakeClock(ms) });
  expect(await leadWatchTick(at(T0 + 2 * MIN), paused)).toEqual([]);
  const lines = await leadWatchTick(at(T0 + 6 * MIN), paused);
  expect(lines.map((l) => l.split(" ")[0])).toEqual(["LEAD_PAUSED", "LEAD_UNREAD"]);
  expect(lines[1]).toContain("oldest=11 22 6m");
  expect(calls.filter((c) => c[0] === "alert").map((c) => c[1]?.split(" ")[0])).toEqual(["LEAD_PAUSED", "LEAD_UNREAD"]);
  expect(await leadWatchTick(at(T0 + 8 * MIN), paused)).toEqual([]);
  expect(calls.some((c) => c[2] === "send-text")).toBe(false);
  expect(JSON.parse(readFileSync(join(state.dir, "lead-watch.json"), "utf8")).unread).toBe(`11-22:paused:${T0 + MIN}`);
});

test("a running lead never gets LEAD_UNREAD, and an acked message is no longer unread", async () => {
  await track(state.dir, undefined, { channel: "11", message: "22" }, T0);
  const calls: Call[] = [];
  const deps = { config: cfg(), run: runner(calls), clock: fakeClock(T0 + 10 * MIN) };
  expect(await leadWatchTick(deps, { kind: "running", since: T0 })).toEqual([]);
  await ack(state.dir, { react: async () => {}, unreact: async () => {} }, "11", "22", T0 + 9 * MIN);
  expect(await leadWatchTick(deps, { kind: "idle", since: T0 })).toEqual([]);
});

test("autoResume types /resume only into an empty input line under the Paused footer", async () => {
  await track(state.dir, undefined, { channel: "11", message: "22" }, T0);
  const auto = cfg({ leadWatch: { pausedMin: 2, autoResume: true, restartProposeMin: 0 } });
  const typed: Call[] = [];
  const lines = await leadWatchTick({ config: auto, run: runner(typed, "Paused · 2 updates held · /resume to resume\n❯ me typing"), clock: fakeClock(T0 + 6 * MIN) }, { kind: "paused", since: T0 });
  expect(lines).toContain("LEAD_PAUSED_INPUT lead:p1: paused with text in its input; not typing");
  expect(typed.some((c) => c[2] === "send-text")).toBe(false);
  state.done();
  state = withState();
  await track(state.dir, undefined, { channel: "11", message: "22" }, T0);
  const clean: Call[] = [];
  const again = await leadWatchTick({ config: { ...auto, stateDir: state.dir }, run: runner(clean, "Paused · /resume to resume\n❯ "), clock: fakeClock(T0 + 6 * MIN) }, { kind: "paused", since: T0 });
  expect(again).toContain("LEAD_RESUMED lead:p1 sent");
  expect(clean.find((c) => c[2] === "send-text")?.[4]).toBe("/resume");
  expect(emptyInput("x\n❯ ")).toBe(true);
});

test("restartProposeMin proposes a restart once and never runs one; the feature flag turns the watch off", async () => {
  await track(state.dir, undefined, { channel: "11", message: "22" }, T0);
  const calls: Call[] = [];
  const config = cfg({ leadWatch: { pausedMin: 2, autoResume: false, restartProposeMin: 15 } });
  const lines = await leadWatchTick({ config, run: runner(calls), clock: fakeClock(T0 + 16 * MIN) }, { kind: "tool-wait", since: T0 });
  expect(lines.map((l) => l.split(" ")[0])).toEqual(["LEAD_UNREAD", "LEAD_RESTART_PROPOSED"]);
  expect(calls.every((c) => c[0] === "alert")).toBe(true);
  const off = { ...config, features: { ...config.features, leadWatch: false } };
  expect(await leadWatchTick({ config: off, run: runner(calls), clock: fakeClock(T0 + 60 * MIN) }, { kind: "paused", since: T0 })).toEqual([]);
});

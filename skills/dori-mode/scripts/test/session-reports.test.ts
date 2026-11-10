import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { lastSessionReport } from "../src/session-reports.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const SID = "0b1c2d3e-0000-4000-8000-00000000abcd";
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const call = (args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: args }] } });

test("the last report is the one the lane sent in a tool call; brief echoes and other lanes are ignored", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "[REPORT] demo | milestone | from the brief" }] } },
    call({ code: 'await run(["herdr","pane","send-text","w:p1","[REPORT] demo | milestone | first step done"])' }),
    call({ code: 'tool.bash({ command: "herdr pane send-text w:p1 \\"[REPORT] demo | blocker | waiting on CI\\" && echo ok" })' }),
    call({ code: '["herdr","pane","send-text","w:p1","[REPORT] other | done | not mine"]' }),
    call({ code: "x = '[REPORT] demo | <milestone|blocker> | <what>'" }),
  ];
  expect(lastSessionReport(entries, "demo")).toBe("[REPORT] demo | blocker | waiting on CI");
  expect(lastSessionReport([], "demo")).toBeNull();
});

const lane: Lane = { key: "demo", title: "demo", thread: "chat:team/9", pane: "w:p7", session: SID, cwd: "/repo", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("freshness posts the session-file report on the first due tick, wrapped screen or not", async () => {
  const sessionsDir = join(state.dir, "sessions");
  const dir = sessionDirFor(sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-01-01T11-00-00-000Z_${SID}.jsonl`), `{"type":"session"}\n${JSON.stringify(call({ code: '["herdr","pane","send-text","w:p1","[REPORT] demo | milestone | PR open, CI green"]' }))}\n`);
  world.screen = "[REPORT] demo | milestone | a wrapped screen line that is cut";
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { sessionsDir, hooks: { threadReply: ["notify", "{thread}", "{text}"] }, nudgeAfterMin: 999 });
  await deps(T0).registry.write(lane);
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  expect(acts.map((a) => a.kind)).toEqual(["posted"]);
  expect(world.calls.find((c) => c[0] === "notify")?.[2]).toContain("PR open, CI green");
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "read")).toBe(false);
});

test("without a session report (or with sessionReports off) freshness falls back to the screen", async () => {
  world.screen = "[REPORT] demo | milestone | from the screen\n❯ ";
  const deps = (ms: number, on: boolean) => {
    const d = depsFor(world, fakeClock(ms), state.dir, { sessionsDir: join(state.dir, "none"), hooks: { threadReply: ["notify", "{thread}", "{text}"] }, nudgeAfterMin: 999 });
    return { ...d, config: { ...d.config, features: { ...d.config.features, sessionReports: on } } };
  };
  await deps(T0, true).registry.write(lane);
  expect((await freshnessTick(deps(T0 + 21 * MIN, true), "/home/test")).map((a) => a.kind)).toEqual(["pending-report"]);
  expect((await freshnessTick(deps(T0 + 26 * MIN, false), "/home/test")).map((a) => a.kind)).toEqual(["posted"]);
  expect(world.calls.find((c) => c[0] === "notify")?.[2]).toContain("from the screen");
});

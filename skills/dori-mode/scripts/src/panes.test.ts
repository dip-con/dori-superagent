// redesign S9: sendVerified(run, clock, pane, text, key) goes through `sess.ts send <key>` when the adapter flag file
// exists, and keeps the keystroke path otherwise; freshness --no-nudge; done-flow claim CAS, untracked files, worktree first.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World, WT } from "../test/fakes.ts";
import { claimDone, closeLane, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { sendAdapterFlag, sendVerified, sessScript } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Runner } from "./run.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "none", pane: "w:p1", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let flagDir = "";
let state: ReturnType<typeof withState>;
let world: World;
let sessExit = 0;
const prevFlag = process.env.DORI_SEND_ADAPTER_FLAG;

const runner = (w: World, wrap?: (argv: readonly string[]) => Promise<{ code: number; out: string; err: string } | null>): Runner => {
  const base = fakeRunner(w);
  return async (argv, opts) => {
    const hit = wrap ? await wrap(argv) : null;
    if (hit) { w.calls.push([...argv]); return hit; }
    if (argv[0] === "bun" && argv[2] === "send") { w.calls.push([...argv]); return { code: sessExit, out: "{}", err: "" }; }
    return base(argv, opts);
  };
};
const deps = (ms: number, wrap?: Parameters<typeof runner>[1]) => ({ ...depsFor(world, fakeClock(ms), state.dir), run: runner(world, wrap) });
const flagOn = () => writeFileSync(join(flagDir, "dori.send-adapter"), "");
const sessCalls = () => world.calls.filter((c) => c[0] === "bun");
const typed = () => world.calls.filter((c) => c[0] === "herdr" && c[2] === "send-text");

beforeEach(async () => {
  flagDir = mkdtempSync(join(tmpdir(), "dori-flag-"));
  process.env.DORI_SEND_ADAPTER_FLAG = join(flagDir, "dori.send-adapter");
  state = withState();
  world = newWorld();
  sessExit = 0;
  await deps(T0).registry.write(lane);
});
afterEach(() => {
  state.done();
  rmSync(flagDir, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.DORI_SEND_ADAPTER_FLAG;
  else process.env.DORI_SEND_ADAPTER_FLAG = prevFlag;
});

test("with flags/dori.send-adapter present: spawns ['bun', sess.ts, 'send', key, text] and never send-text", async () => {
  flagOn();
  expect(sendAdapterFlag()).toBe(join(flagDir, "dori.send-adapter"));
  const d = deps(T0);
  expect(await sendVerified(d.run, d.clock, "w:p1", "[LEAD] please report", "demo-lane")).toBe("delivered");
  expect(sessCalls()).toEqual([["bun", sessScript(), "send", "demo-lane", "[LEAD] please report"]]);
  expect(sessScript()).toEndWith("/.omocat/sess.ts");
  expect(typed()).toEqual([]);
  expect(world.calls.some((c) => c.includes("send-text") || c.includes("send-keys"))).toBe(false);
});

test("adapter path: an id is passed through, exit 3 is unconfirmed, other failures are failed", async () => {
  flagOn();
  const d = deps(T0);
  sessExit = 3;
  expect(await sendVerified(d.run, d.clock, "w:p1", "x", "demo-lane", "nudge:demo-lane:h1:1")).toBe("unconfirmed");
  expect(sessCalls().at(-1)).toEqual(["bun", sessScript(), "send", "demo-lane", "x", "--id", "nudge:demo-lane:h1:1"]);
  sessExit = 4;
  expect(await sendVerified(d.run, d.clock, "w:p1", "x", "demo-lane")).toBe("failed");
  expect(typed()).toEqual([]);
});

test("without the flag the keystroke path is unchanged (send-text + one Enter, no sess.ts)", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent_status: "idle" }];
  world.onEnterStatus = "working";
  const d = deps(T0);
  expect(await sendVerified(d.run, d.clock, "w:p1", "[LEAD] please report", "demo-lane")).toBe("delivered");
  expect(sent(world)).toEqual(["[LEAD] please report"]);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toEqual([["herdr", "pane", "send-keys", "w:p1", "enter"]]);
  expect(sessCalls()).toEqual([]);
});

test("a flag that lists lane keys moves only those lanes to the adapter; every other lane keeps typing", async () => {
  writeFileSync(join(flagDir, "dori.send-adapter"), "rpc-smoke\ns9-test-a\n");
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent_status: "idle" }];
  world.onEnterStatus = "working";
  const d = deps(T0);
  expect(await sendVerified(d.run, d.clock, "w:p1", "[LEAD] x", "demo-lane")).toBe("delivered");
  expect(sessCalls()).toEqual([]);
  expect(sent(world)).toEqual(["[LEAD] x"]);
  expect(await sendVerified(d.run, d.clock, "w:p1", "[LEAD] y", "rpc-smoke")).toBe("delivered");
  expect(sessCalls()).toEqual([["bun", sessScript(), "send", "rpc-smoke", "[LEAD] y"]]);
  expect(typed().length).toBe(1);
});

test("done-flow and freshness messages carry the lane key to the adapter", async () => {
  flagOn();
  await claimDone(deps(T0), lane, "merged acme/app#1");
  expect(sessCalls()[0]?.slice(0, 4)).toEqual(["bun", sessScript(), "send", "demo-lane"]);
  await deps(T0).registry.write(lane);
  await freshnessTick(deps(T0 + 16 * MIN), "/home/test");
  expect(sessCalls().at(-1)?.slice(0, 4)).toEqual(["bun", sessScript(), "send", "demo-lane"]);
  expect(sessCalls().at(-1)?.slice(-2)).toEqual(["--id", `nudge:demo-lane:h${T0 - 60 * MIN}:1`]);
  expect(typed()).toEqual([]);
});

test("freshness --no-nudge: a due nudge is a NO-NUDGE line, nothing is sent or typed, once per silence", async () => {
  flagOn();
  const first = await freshnessTick(deps(T0 + 16 * MIN), "/home/test", { noNudge: true });
  expect(first.map((a) => a.kind)).toEqual(["no-nudge"]);
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { noNudge: true })).filter((a) => a.kind === "no-nudge")).toEqual([]);
  expect(sessCalls()).toEqual([]);
  expect(typed()).toEqual([]);
  const after = await deps(T0).registry.read("demo-lane");
  expect(after?.lastNudgeAt).toBeUndefined();
});

test("settle: verified only if claim.at is unchanged; an objection made meanwhile wins", async () => {
  await claimDone(deps(T0), lane, "merged acme/app#1");
  await watchTick(deps(T0 + MIN));
  let objected = false;
  const wrap = async (argv: readonly string[]) => {
    if (!objected && argv[0] === "git" && argv.includes("status")) {
      objected = true;
      await deps(T0).registry.update("demo-lane", (cur) => cur && { ...cur, status: "not-done", objection: { at: new Date(T0 + 5 * MIN).toISOString(), reasons: ["lead objected"] } });
    }
    return null;
  };
  const lines = await watchTick(deps(T0 + 6 * MIN, wrap));
  expect(lines.some((l) => l.startsWith("LANE_SETTLE_SKIPPED demo-lane"))).toBe(true);
  const after = await deps(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "close")).toBe(false);
});

test("untracked files count as unpushed (no --untracked-files=no)", async () => {
  world.dirty = "?? notes/new.md";
  await claimDone(deps(T0), lane, "merged acme/app#1");
  await watchTick(deps(T0 + 6 * MIN));
  const after = await deps(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(world.calls.some((c) => c.includes("--untracked-files=no"))).toBe(false);
});

test("worktree removal comes before the pane close; a failed removal keeps the lane and its pane", async () => {
  const wrap = async (argv: readonly string[]) => (argv[0] === "git" && argv.includes("worktree") && argv.includes("remove") ? { code: 1, out: "", err: "contains modified files" } : null);
  const r = await closeLane(deps(T0, wrap), lane, "done");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toContain(`worktree ${WT} not removed`);
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "close")).toBe(false);
  const after = await deps(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("working");
  const order: string[] = [];
  world.calls = [];
  const ok = await closeLane(deps(T0), lane, "done");
  for (const c of world.calls) if ((c[0] === "git" && c.includes("remove")) || (c[0] === "herdr" && c[2] === "close")) order.push(c[0]);
  expect(ok.closed).toBe(true);
  expect(order).toEqual(["git", "herdr"]);
});

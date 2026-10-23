import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "../test/fakes.ts";
import { launchLane } from "./launch.ts";

let state: ReturnType<typeof withState>;
let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent_status: "idle" }];
});
afterEach(() => state.done());

let n = 0;
const launch = async (screen: string) => {
  world.screen = screen;
  const key = `borrow-test-launch${++n}`;
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "brief\n");
  const deps = depsFor(world, fakeClock(0), state.dir);
  const base = fakeRunner(world);
  const run: typeof deps.run = async (argv) =>
    argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: JSON.stringify({ result: { tab_id: "w:t9", root_pane: { pane_id: "w:p9" } } }), err: "" }
      : base(argv);
  return (await launchLane({ ...deps, run }, { key, title: "t", brief, done: `approved ${key}` })).startup.replace(key, "KEY");
};

test("brief echo, tips and recalled memory that mention quota/rate limit do not fail a healthy start", async () => {
  const screen = [
    " Read and execute the lane brief at /tmp/b.md in full. Watch the quota and rate limit.",
    "Tip: when you hit a usage limit, switch accounts.",
    "<recalled-memory>",
    "  quota exhausted on account 2 last week",
    "</recalled-memory>",
    "────────────",
    "❯ ",
    "────────────",
  ].join("\n");
  expect(await launch(screen)).toBe("STARTUP_OK KEY w:p9");
});

test("a real Error:-prefixed or line-leading failure is still a STARTUP_ERROR", async () => {
  expect(await launch("Error: 429 rate limit exceeded for model\n❯ ")).toBe("STARTUP_ERROR KEY w:p9: rate limit");
  expect(await launch("│ All fallback models failed\n❯ ")).toBe("STARTUP_ERROR KEY w:p9: All fallback models failed");
  expect(await launch("  ✗ Usage limit reached, resets at 18:00\n")).toBe("STARTUP_ERROR KEY w:p9: Usage limit reached");
});

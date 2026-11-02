import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireKeyLock, LockWaitError, Registry } from "./registry.ts";

const SRC = join(import.meta.dir, "registry.ts");
const OMOCAT_REGISTRY = `${process.env.HOME}/.omocat/registry.ts`;
const lane = (key: string) => ({ key, title: key, thread: "none", brief: "b", done: "d", openedAt: "2026-10-23T00:00:00Z" });

test("update re-reads under the key lock: two processes bumping different fields both survive", async () => {
  const state = mkdtempSync(join(tmpdir(), "dori-reg-"));
  await new Registry(state).write(lane("race"));
  const bump = (field: string) =>
    Bun.spawn(["bun", "-e", `import { Registry } from ${JSON.stringify(SRC)}; const r = new Registry(${JSON.stringify(state)}); for (let i = 0; i < 40; i++) await r.update("race", (c) => ({ ...c, ${field}: (c?.${field} ?? 0) + 1 }));`], { stdout: "inherit", stderr: "inherit" });
  const codes = await Promise.all([bump("lastNudgeAt").exited, bump("lastReplyAt").exited]);
  expect(codes).toEqual([0, 0]);
  const got = await new Registry(state).read("race");
  expect([got?.lastNudgeAt, got?.lastReplyAt]).toEqual([40, 40]);
  expect(existsSync(join(state, "lanes", "race.lock"))).toBe(false);
}, 60_000);

test("a lock left by a dead pid is reclaimed; a lock held by this live process waits and fails with lock_wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-lock-"));
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  mkdirSync(join(dir, "a.lock"));
  writeFileSync(join(dir, "a.lock", "owner.json"), JSON.stringify({ pid: dead.pid, bootAtMs: 0, processStartedAtMs: 0 }));
  const release = await acquireKeyLock(join(dir, "a.lock"), 1_000);
  expect(JSON.parse(readFileSync(join(dir, "a.lock", "owner.json"), "utf8")).pid).toBe(process.pid);
  await expect(acquireKeyLock(join(dir, "a.lock"), 300)).rejects.toBeInstanceOf(LockWaitError);
  release();
  expect(existsSync(join(dir, "a.lock"))).toBe(false);
});

test.skipIf(!existsSync(OMOCAT_REGISTRY))("cross-repo: omocat updateDoriLane and dori Registry.update on one key keep both fields", async () => {
  const state = mkdtempSync(join(tmpdir(), "dori-xrepo-"));
  await new Registry(state).write(lane("xrepo"));
  const lanes = join(state, "lanes");
  const dori = Bun.spawn(["bun", "-e", `import { Registry } from ${JSON.stringify(SRC)}; const r = new Registry(${JSON.stringify(state)}); for (let i = 0; i < 40; i++) await r.update("xrepo", (c) => ({ ...c, lastNudgeAt: (c?.lastNudgeAt ?? 0) + 1 }));`], { stdout: "inherit", stderr: "inherit" });
  const omocat = Bun.spawn(["bun", "-e", `import { updateDoriLane } from ${JSON.stringify(OMOCAT_REGISTRY)}; for (let i = 0; i < 40; i++) await updateDoriLane("xrepo", (c) => ({ ...c, session: String(Number(c?.session ?? 0) + 1) }), { dir: ${JSON.stringify(lanes)} });`], { stdout: "inherit", stderr: "inherit" });
  expect(await Promise.all([dori.exited, omocat.exited])).toEqual([0, 0]);
  const got = await new Registry(state).read("xrepo");
  expect([got?.lastNudgeAt, got?.session]).toEqual([40, "40"]);
}, 60_000);

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-appr-"));
process.env.DORI_APPROVALS_DIR = dir;
const { checkSignal, UNREADABLE } = await import("../src/signals.ts");

const runner = (answers: Record<string, { code: number; out: string }>, calls: string[][] = []): Runner => async (argv) => {
  calls.push([...argv]);
  const hit = Object.entries(answers).find(([k]) => argv.join(" ").includes(k));
  return hit ? { code: hit[1].code, out: hit[1].out, err: "" } : { code: 1, out: "", err: "no fake" };
};

describe("Dandori local signals", () => {
  test("gitlab merged reads the MR and needs a merge sha", async () => {
    const calls: string[][] = [];
    const ok = await checkSignal("merged gitlab:bizcorelab/bizcorelab!5", runner({ "merge_requests/5": { code: 0, out: JSON.stringify({ state: "merged", merge_commit_sha: "6058e252da86" }) } }, calls));
    expect(ok).toMatchObject({ ok: true, detail: "merged 6058e252da" });
    expect(calls[0]).toContain("projects/bizcorelab%2Fbizcorelab/merge_requests/5");
    expect(calls[0]).toContain("GLAB_SEND_TELEMETRY=0");
    const open = await checkSignal("merged gitlab:bizcorelab/bizcorelab!6", runner({ "merge_requests/6": { code: 0, out: JSON.stringify({ state: "opened", merge_commit_sha: null }) } }));
    expect(open.ok).toBe(false);
  });
  test("gitlab closed issue", async () => {
    expect((await checkSignal("closed gitlab:grp/app#3", runner({ "issues/3": { code: 0, out: '{"state":"closed"}' } }))).ok).toBe(true);
    expect((await checkSignal("closed gitlab:grp/app#4", runner({ "issues/4": { code: 0, out: '{"state":"opened"}' } }))).ok).toBe(false);
  });
  test("deployed compares the NAS deploy-state sha", async () => {
    const live = runner({ "bizcorelab.sha": { code: 0, out: "6058e252da8652ffe9d5df8b0424962638e714c5\n" } });
    expect((await checkSignal("deployed bizcorelab@6058e252", live)).ok).toBe(true);
    expect((await checkSignal("deployed bizcorelab@deadbeef", live)).ok).toBe(false);
  });
  test("approved reads the approval file", async () => {
    const no = await checkSignal("approved real-estate", runner({}));
    expect(no.ok).toBe(false);
    writeFileSync(join(dir, "real-estate"), "owner said done in thread");
    expect((await checkSignal("approved real-estate", runner({}))).ok).toBe(true);
  });
  test("unknown text is still unreadable", async () => {
    expect((await checkSignal("it works on my machine", runner({}))).detail).toBe(UNREADABLE);
  });
});

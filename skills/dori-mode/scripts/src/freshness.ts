import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { checkPausedLane } from "./pause.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { laneSessionReport } from "./session-reports.ts";

export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|done) \\| (?!<what)\\S`);
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => grammar.test(l));
  if (at < 0) return null;
  // The pane wraps a long report over several screen lines; keep reading until a blank line or the next block.
  const first = lines[at]!;
  const parts = [first.slice(first.indexOf("[REPORT]")).trim()];
  for (const l of lines.slice(at + 1)) {
    const t = l.trim();
    if (!t || t.includes("[REPORT]") || /^[─━│╭╰❯>•\-]/.test(t)) break;
    parts.push(t);
  }
  // A report typed inside a shell command ends at its closing quote; drop the command tail ("... && herdr pane send-keys ...").
  return parts.join(" ").replace(/["']\s*(?:&&|\|\||;|\||\)).*$/, "").replace(/["'\])\s,]+$/, "");
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

export type SweepAct = { readonly kind: "nudged" | "no-nudge" | "posted" | "no-report" | "pending-report" | "stale-report" | "working-while-paused"; readonly lane: string; readonly detail: string };

/** noNudge: report a due nudge as a NO-NUDGE line instead of sending it (redesign S9: the supervisor nudge policy sends).
 *  only: restrict the sweep to one lane key. */
export type FreshnessOpts = { readonly noNudge?: boolean; readonly only?: string };

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

export const freshnessTick = async (deps: FlowDeps, home: string, opts: FreshnessOpts = {}): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  for (const lane of await deps.registry.open()) {
    if (statusOf(lane) === "paused") {
      const checked = await checkPausedLane(deps, lane);
      if (checked && checked.lane.lastFreshnessNote !== "working-while-paused") {
        // Reported once per working stretch (the note clears when the lane goes idle), so the lead can ask; it stays paused.
        await deps.registry.write({ ...checked.lane, lastFreshnessNote: "working-while-paused" });
        acts.push({ kind: "working-while-paused", lane: lane.key, detail: "paused lane is working on two ticks; left paused (resume is dori resume only)" });
      }
      continue;
    }
    if (statusOf(lane) !== "working" || !lane.pane) continue;
    if (opts.only && lane.key !== opts.only) continue;
    const heard = lastHeard(lane);
    const silentMin = Math.round((now - heard) / 60_000);
    let current = lane;
    if (silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard && opts.noNudge) {
      // One NO-NUDGE line per silence episode (kept in its own field; lastFreshnessNote belongs to the report hold).
      if ((current as Lane & { lastNudgeProposal?: number }).lastNudgeProposal !== heard) {
        acts.push({ kind: "no-nudge", lane: lane.key, detail: `${silentMin} min silent: nudge due, not sent (--no-nudge) -> propose: bun ~/.omocat/sess.ts send ${lane.key} "<progress request>"` });
        const proposed = current;
        current = (await deps.registry.update(lane.key, (cur) => ({ ...(cur ?? proposed), lastNudgeProposal: heard }) as Lane)) ?? current;
      }
    } else if (silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      // One id per silence episode: a retry of the same nudge never becomes a second message.
      const delivery = await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`, lane.key, `nudge:${lane.key}:h${heard}:1`);
      const nudged = current;
      current = (await deps.registry.update(lane.key, (cur) => ({ ...(cur ?? nudged), lastNudgeAt: now }))) ?? { ...current, lastNudgeAt: now };
      acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery ${delivery}` });
    }
    const hook = deps.config.hooks.threadReply;
    if (silentMin >= deps.config.postAfterMin && hook && lane.thread !== "none" && (current.lastAutoReplyAt ?? 0) < heard) {
      const fromSession = deps.config.features.sessionReports ? laneSessionReport(deps.config.sessionsDir, lane) : null;
      const report = fromSession ?? lastReportLine(await readScreen(deps.run, lane.pane, 200), lane.key);
      // Two screen reads are a full loop interval apart: a screen line counts only once it is still there on the next
      // tick. A session-file report is the whole argv the lane sent, so it needs no second look.
      const seenBefore = fromSession ?? current.lastSeenReport;
      const seen = report ?? undefined;
      current = { ...current, lastSeenReport: seen };
      let hold: { kind: SweepAct["kind"]; detail: string } | null = null;
      if (!report) hold = { kind: "no-report", detail: "pane has no [REPORT] line" };
      else if (report !== seenBefore) hold = { kind: "pending-report", detail: "a new [REPORT] line; posting once it holds on the next tick" };
      else if (report === current.lastPostedReport) hold = { kind: "stale-report", detail: "the last [REPORT] line was already posted" };
      if (hold) {
        const note = `${hold.kind}|${hold.detail}|${report ?? ""}`;
        if (note !== current.lastFreshnessNote) acts.push({ kind: hold.kind, lane: lane.key, detail: hold.detail });
        const held = current;
        await deps.registry.update(lane.key, (cur) => ({ ...(cur ?? held), lastSeenReport: seen, lastFreshnessNote: note }));
        continue;
      }
      const text = `Progress (from the lane's last report): ${scrubForThread(report ?? "", home)}`;
      await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      const posted = current;
      await deps.registry.update(lane.key, (cur) => ({ ...(cur ?? posted), lastSeenReport: seen, lastAutoReplyAt: now, lastPostedReport: report ?? undefined, lastFreshnessNote: undefined }));
      acts.push({ kind: "posted", lane: lane.key, detail: text });
    }
  }
  return acts;
};

import type { Lane } from "./registry.ts";
import { findSessionFile, readSessionTail } from "./session-id.ts";

const KINDS = "milestone|blocker|question|done";

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};

/**
 * The last `[REPORT] <key> | <kind> | <text>` the lane sent, read from its own tool calls in the session file (the
 * argv it passed to send the report), so pane width, wrapping and shell quoting never cut or invent a report. The text
 * ends at the end of its string literal: a quote, a backtick, a newline or an escaped newline.
 */
export const lastSessionReport = (entries: readonly Record<string, unknown>[], key: string): string | null => {
  const grammar = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (${KINDS}) \\| (?!<what)([^\\n"\`]+)`, "g");
  let last: string | null = null;
  for (const e of entries) {
    const m = e.message as { role?: string; content?: unknown } | undefined;
    if (e.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; arguments?: unknown }[]) {
      if (part.type !== "toolCall") continue;
      for (const s of strings(part.arguments)) {
        for (const hit of s.matchAll(grammar)) {
          const text = (hit[2] ?? "").split("\\n")[0]!.replace(/['\])\s,\\]+$/, "").trim();
          if (text) last = `[REPORT] ${key} | ${hit[1]} | ${text}`;
        }
      }
    }
  }
  return last;
};

export const laneSessionReport = (sessionsDir: string, lane: Lane): string | null => {
  const file = lane.session ? findSessionFile(sessionsDir, lane.session, lane.cwd) : undefined;
  return file ? lastSessionReport(readSessionTail(file), lane.key) : null;
};

import type { Runner } from "./run.ts";

export type Check = { readonly signal: string; readonly ok: boolean; readonly detail: string };

const ghRef = (s: string): { readonly repo: string; readonly n: string } | null => {
  const m = /([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)(\d+)/.exec(s);
  return m?.[1] && m[2] ? { repo: m[1], n: m[2] } : null;
};

export const UNREADABLE = "unreadable signal: use 'merged <owner/repo>#N', 'closed <owner/repo>#N', 'published <pkg>@<version>', 'merged gitlab:<group/repo>!N', 'closed gitlab:<group/repo>#N', 'deployed <app>@<sha>' or 'approved <lane-key>'";

// Dandori local signals (self-hosted GitLab, NAS deploy state, owner approval).
export const GITLAB_HOST = process.env.DORI_GITLAB_HOST ?? "gitlab.bizcorelab.com";
export const DEPLOY_HOST = process.env.DORI_DEPLOY_HOST ?? "ubuntu-nas";
export const DEPLOY_STATE_DIR = process.env.DORI_DEPLOY_STATE_DIR ?? "/srv/apps/.deploy-state";
export const approvalsDir = (): string => process.env.DORI_APPROVALS_DIR ?? `${process.env.HOME}/.dori/state/approvals`;
const glRef = (s: string): { readonly repo: string; readonly n: string } | null => {
  const m = /gitlab:([\w.-]+(?:\/[\w.-]+)+?)[!#](\d+)\b/.exec(s);
  return m?.[1] && m[2] ? { repo: m[1], n: m[2] } : null;
};
const glab = (path: string): string[] => ["env", "GLAB_SEND_TELEMETRY=0", "glab", "api", "--hostname", GITLAB_HOST, path];

export const checkSignal = async (signal: string, run: Runner): Promise<Check> => {
  const s = signal.trim();
  const gl = glRef(s);
  if (gl && /^merged\b/i.test(s)) {
    const r = await run(glab(`projects/${encodeURIComponent(gl.repo)}/merge_requests/${gl.n}`));
    const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string; merge_commit_sha?: string | null; squash_commit_sha?: string | null }) : {};
    const sha = j.merge_commit_sha ?? j.squash_commit_sha ?? "";
    return { signal: s, ok: j.state === "merged" && sha.length > 0, detail: j.state ? `${j.state} ${sha.slice(0, 10)}`.trim() : r.err || "no answer" };
  }
  if (gl && /^closed\b/i.test(s)) {
    const r = await run(glab(`projects/${encodeURIComponent(gl.repo)}/issues/${gl.n}`));
    const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string }) : {};
    return { signal: s, ok: j.state === "closed", detail: j.state ?? (r.err || "no answer") };
  }
  const dep = /^deployed\s+([\w.-]+)@([0-9a-f]{7,40})\b/i.exec(s);
  if (dep?.[1] && dep[2]) {
    const r = await run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", DEPLOY_HOST, "cat", `${DEPLOY_STATE_DIR}/${dep[1]}.sha`]);
    const live = r.code === 0 ? r.out.trim() : "";
    const ok = live.length >= 7 && (live.startsWith(dep[2]) || dep[2].startsWith(live));
    return { signal: s, ok, detail: live ? `live ${live.slice(0, 10)}` : r.err || "no deploy state" };
  }
  const appr = /^approved\s+([a-z0-9][a-z0-9._-]{1,60})$/i.exec(s);
  if (appr?.[1]) {
    const f = Bun.file(`${approvalsDir()}/${appr[1]}`);
    const ok = await f.exists();
    return { signal: s, ok, detail: ok ? `approved: ${(await f.text()).trim().slice(0, 120)}` : "not approved yet (lead writes the approval file)" };
  }
  const ref = ghRef(s);
  if (/^merged\b/i.test(s) && ref) {
    const r = await run(["gh", "pr", "view", ref.n, "--repo", ref.repo, "--json", "state,mergeCommit"]);
    const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string; mergeCommit?: { oid?: string } | null }) : {};
    const sha = j.mergeCommit?.oid ?? "";
    return { signal: s, ok: j.state === "MERGED" && sha.length > 0, detail: j.state ? `${j.state} ${sha.slice(0, 10)}`.trim() : r.err || "no answer" };
  }
  if (/^closed\b/i.test(s) && ref) {
    const r = await run(["gh", "issue", "view", ref.n, "--repo", ref.repo, "--json", "state"]);
    const j = r.code === 0 ? (JSON.parse(r.out) as { state?: string }) : {};
    return { signal: s, ok: j.state === "CLOSED", detail: j.state ?? (r.err || "no answer") };
  }
  const pub = /^published\s+(\S+)@(\S+)/i.exec(s);
  if (pub?.[1] && pub[2]) {
    const r = await run(["npm", "view", `${pub[1]}@${pub[2]}`, "version", "--json"]);
    const ok = r.code === 0 && r.out.replace(/"/g, "").trim() === pub[2];
    return { signal: s, ok, detail: ok ? `registry has ${pub[1]}@${pub[2]}` : r.err || r.out || "not published" };
  }
  return { signal: s, ok: false, detail: UNREADABLE };
};

export const splitDone = (done: string): string[] => done.replace(/^Done\s*=\s*/i, "").split(/\s*;\s*/).filter(Boolean);

export const checkDone = async (done: string, run: Runner): Promise<Check[]> => {
  const parts = splitDone(done);
  if (!parts.length) return [{ signal: done, ok: false, detail: "empty Done line" }];
  return Promise.all(parts.map((p) => checkSignal(p, run)));
};

import { homedir } from "node:os";
import { join } from "node:path";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
  /** `lead-watch`: run with {text} when the lead looks stopped; reaches someone even while the lead's own monitors are held. */
  readonly leadAlert?: ArgvTemplate;
};

/** Each event improvement can be switched off on its own. */
export type Features = {
  /** `track` puts the hourglass on a received message (`ack` swaps it for the eyes). */
  readonly hourglass: boolean;
  /** `obligations` prints UNACKED / UNHANDLED for tracked messages. */
  readonly obligations: boolean;
  /** `lead-watch` reads the lead session and prints LEAD_PAUSED / LEAD_UNREAD. */
  readonly leadWatch: boolean;
  /** `freshness` reads a lane's [REPORT] from its session file first and the pane screen only as a fallback. */
  readonly sessionReports: boolean;
};

export type LeadWatch = {
  /** A paused or interrupted lead is reported once it has stayed so this long. */
  readonly pausedMin: number;
  /** Type `/resume` (once per pause, only into an empty input line) when a paused lead leaves owner messages unread. */
  readonly autoResume: boolean;
  /** Print LEAD_RESTART_PROPOSED when an unread owner message is this old and the lead is still not running; 0 = off. Never restarts. */
  readonly restartProposeMin: number;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Seconds a tracked message may wait for `dori ack` before UNACKED (official key; default 120 here, 60 upstream). */
  readonly ackTimeoutSec: number;
  /** Minutes from the ack (or receipt, when never acked) until UNHANDLED without `dori handled` (official key). */
  readonly handledTimeoutMin: number;
  /** Minutes an owner message may stay unacked while the lead is not running before LEAD_UNREAD (official key; here it alerts, never restarts). */
  readonly leadUnreadRestartMin: number;
  /** The lead's session file; blank resolves it from leadPane. */
  readonly leadSessionFile: string;
  readonly leadWatch: LeadWatch;
  readonly features: Features;
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  ackTimeoutSec: 120,
  handledTimeoutMin: 30,
  leadUnreadRestartMin: 5,
  leadSessionFile: "",
  leadWatch: { pausedMin: 2, autoResume: false, restartProposeMin: 0 },
  features: { hourglass: true, obligations: true, leadWatch: true, sessionReports: true },
});

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  const merged: DoriConfig = { ...base, ...raw, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, leadWatch: { ...base.leadWatch, ...raw.leadWatch }, features: { ...base.features, ...raw.features } };
  return {
    ...merged,
    stateDir: expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadSessionFile: merged.leadSessionFile ? expandHome(merged.leadSessionFile, home) : "",
    leadPane: process.env.DORI_LEAD_PANE ?? merged.leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));

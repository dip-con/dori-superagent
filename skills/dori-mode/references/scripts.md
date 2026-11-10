# Scripts

`scripts/` is a bun + TypeScript package with one CLI, `dori`. Every external command runs as an argv array; nothing builds a shell string.

## Install and test

```sh
cd skills/dori-mode/scripts
bun install          # dev dependencies only (types, tsc)
bun link             # puts `dori` on your PATH
bun test             # behavior tests with fake herdr/git/gh; nothing real is touched
bunx tsc --noEmit    # typecheck
```

Needs: bun 1.3+, herdr, git, and the GitHub CLI (`gh`) for `merged`/`closed` signals (npm for `published`). The `command`, `file` and `url` signals need nothing extra. The full list of signal kinds is in `sessions.md`. The host guard reads `sysctl`, `memory_pressure` and `df` on macOS; on Linux it reads `/proc/loadavg` and `df`, and memory and swap read as unknown.

## Configuration

`~/.dori/config.json` (or the path in `DORI_CONFIG`). Every field is optional; see `config.example.json`. `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

| Field | Default | Used by |
|---|---|---|
| `stateDir` | `~/.dori/state` | registry, heavy slots |
| `laneWorkspace` | current workspace | `launch` |
| `workspaces` | all | `sync`, `dead-panes` |
| `ignorePanes`, `leadPane` | none | panes the sweeps skip; `leadPane` is also where lanes report |
| `defaultCwd` | home | where lanes start, and the repo whose worktrees they own |
| `agentCommand`, `defaultModel`, `launchKeywords` | `omo --model {model} {prompt}` | `launch` |
| `sessionsDir` | `~/.omo/agent/sessions` | session-id lookup |
| `nudgeAfterMin`, `postAfterMin` | 15, 20 | `freshness` |
| `closeAfterMin` | 5 | `watch` |
| `heavySlots`, `heavyMaxLoad` | 1, 80 | `heavy` |
| `deadPanePatterns` | `has stopped`, `no suitable jobs` | `dead-panes` |
| `guard` | load 150/80, 20% memory, 50 GB disk, 20 panes | `guard` |
| `hooks.threadReply`, `hooks.threadDone` | none | `freshness`, `close` |
| `hooks.transcribe` | none | `transcribe` (argv with `{file}`, prints the text) |
| `hooks.leadAlert` | none | `lead-watch`: argv with `{text}`, run for every `LEAD_PAUSED`, `LEAD_UNREAD` and `LEAD_RESTART_PROPOSED` line. Point it somewhere a person sees while the lead is stopped (its own monitors are held then) |
| `ackTimeoutSec` | 120 | `obligations`: seconds a tracked message may wait for `dori ack` before `UNACKED` (same key as dev-bokdong/dori-mode, whose default is 60) |
| `handledTimeoutMin` | 30 | `obligations`: minutes from the ack, or from the receipt when never acked, until `UNHANDLED` without `dori handled` |
| `leadUnreadRestartMin` | 5 | `lead-watch`: minutes an unacked message may wait while the lead is not running before `LEAD_UNREAD`. Same key as upstream, but here it alerts; it never restarts the lead |
| `leadSessionFile` | blank | `lead-watch`: the lead's session JSONL; blank resolves it from the agent running in `leadPane` |
| `leadWatch` | `pausedMin` 2, `autoResume` false, `restartProposeMin` 0 | `lead-watch`: report a pause that lasts `pausedMin`; `autoResume` types `/resume` once per pause, only into an empty input line under omo's `Paused ... /resume` footer; `restartProposeMin` > 0 prints `LEAD_RESTART_PROPOSED` once an unread message is that old |
| `features` | all true: `hourglass`, `obligations`, `leadWatch`, `sessionReports` | switches each event improvement off on its own: the hourglass on `track`, the `obligations` and `lead-watch` commands (they exit 0 with `*_OFF`), and `freshness` reading reports from session files |

Hooks are argv templates for your messenger CLI. `{thread}`, `{text}` and `{key}` are filled into each argument separately, so the text stays one argument whatever it contains.

## Library modules

The CLI is a thin layer over typed modules you can import in your own scripts:

| Module | What it gives you |
|---|---|
| `src/messenger/slack.ts` | `Slack`: post, edit, thread replies, file upload (upload URL + complete), presence; 429 backoff |
| `src/messenger/telegram.ts` | `Telegram`: send, edit, typing, `sendMessageDraft` streaming with a `Thinking…` start, forum topics (create, rename, close, reopen), HTML tables |
| `src/messenger/discord.ts` | `Discord`: send without pings, edit, typing, threads (start, rename, archive); gateway presence |
| `src/messenger/typing.ts` | `typingWhile`: show typing while a piece of work runs, stop when it ends |
| `src/messenger/voice.ts` | `transcribe`: voice note to text through your hook |
| `src/messenger/thread-ledger.ts` | `ThreadLedger`: every thread the Dori posts in, persisted; given to `Slack`, it records each `chat.postMessage` (also raw `call`s) |
| `src/messenger/slack-inbound.ts` | `pollSlackInbound`: threads view, the ledger's threads and unread counts, deduplicated, own messages filtered |
| `src/messenger/slack-presence.ts` | `slackPresence`: hold a user account active |
| `src/routing.ts` | `canLaunch`, `idleLaneFor`: the routing checks |

Every module takes its HTTP, clock and timers as arguments. That is how the tests run without the network.

## Commands

### `dori launch <key> --title T --brief FILE --done "..." [--thread REF] [--model M] [--cwd DIR]`
Opens a lane: appends the footer to the brief, opens a tab, starts the agent, and after 20 seconds checks it: `STARTUP_ERROR` on a known failure in the pane, `STARTUP_OK` only when herdr reports the agent idle or working, and `STARTUP_UNCONFIRMED` (with the last lines) otherwise. Exit 3 on anything but `STARTUP_OK`.

### `dori adopt <key> --pane ID --title T --brief FILE --done "..." [--thread REF]`
Registers a lane that is already running.

### `dori sync [--write]`
Prints `key | thread | pane | session | status` for every open lane and every unregistered agent pane, followed by drift. Read-only unless `--write`, which stores session ids.

### `dori claim-done [<key>] --evidence TEXT` / `dori object-done <key> --reason TEXT ...`
The two halves of the done flow. Both message the lane's pane and check that Enter registered.

### `dori close <key> [--note TEXT]`
Closes a lane now. Refuses (exit 2) unless every `Done =` signal reads back live. On success it marks the thread done through `hooks.threadDone`, closes the tab, and removes the lane's worktrees with a plain `git worktree remove`, which refuses a dirty worktree.

### `dori pause <key> [--note TEXT]` / `dori resume <key> [--note TEXT]`
`pause` is for when the owner said wait. It works on a `working` or `not-done` lane. It sends `/goal pause` to the lane's pane, then reads the screen back until the goal command's own line appears on a line of its own: `Goal paused`, or `cannot update goal: no goal exists`, since a lane with no goal has nothing to continue. Only then does it mark the lane `paused` (recorded in its history) and send Escape if a turn is running. The goal is paused first, so stopping the turn cannot hand off to a goal continuation. If the line does not appear, or the send fails, the lane is left as it was and the command prints `PAUSE_UNVERIFIED` and exits 3.

A paused lane is skipped by `freshness`: no nudge, no post. Only `dori resume` ends a pause, on the owner's word. Activity never does, because a paused lane can still be woken by a background result, a queued message or a turn after Escape. If its pane reads `working` on two ticks in a row, `freshness` prints `WORKING-WHILE-PAUSED` once per working stretch (again after it goes idle and is woken, or after a new pause), so the lead can ask the owner, and the lane stays paused.

`resume` sends `/goal resume` and reads back `Goal active` the same way, then restores the status the lane had before the pause (`pausedFrom`) and restarts its quiet time, so a long pause does not turn into an instant nudge. Unconfirmed: `RESUME_UNVERIFIED`, exit 3.

Both print `PAUSED` / `RESUMED` and exit 0 on success. A lane in any other state is refused (`NOT_PAUSED` / `NOT_RESUMED`, exit 2), and a second `pause` is a no-op. `claim-done` and `object-done` on a paused lane move it out of `paused` in the registry while its goal stays paused.

### `dori watch`
Runs forever. Every 30 seconds it prints each new claim once (`LANE_DONE_CLAIMED`). Claims older than `closeAfterMin` are settled: unpushed or uncommitted work and failing signals turn into objections (`LANE_NOT_DONE`); otherwise the lane is closed (`LANE_CLOSED`). The deadline lives in the registry, so a restart picks up where it left off.

### `dori freshness [--loop MIN]`
For working lanes that have gone quiet: a nudge in the pane after `nudgeAfterMin`, then the lane's last `[REPORT]` line posted to its thread after `postAfterMin`, with home paths and pane ids scrubbed. Each happens once per silence. The line is posted only once it is still the last `[REPORT]` line on the next tick (`PENDING-REPORT` the first time) and differs from the line posted last time (`STALE-REPORT` otherwise). With `features.sessionReports` the report is read first from the lane's session file: the last `[REPORT] <key> | <kind> | <text>` inside the lane's own tool calls (the argv it sent the report with), so pane width and wrapping never cut it and the brief's template never counts. A session-file report needs no second tick; the screen is read only when the lane has no session or never sent a report. A held-back outcome is printed once per change, not on every tick. A nudge reports its delivery as `delivered` (the agent status moved to working) or `unconfirmed`.

### `dori track <channel> <messageId> [--source NAME] [--text T]` / `dori ack` / `dori handled`
Owner-message obligations, with the command names of dev-bokdong/dori-mode but without its supervisor: whatever receives a message registers it.
- `track`: a Discord listener calls it for each owner message (`--source owner`, the default), and any other watcher can register its own item, e.g. a card it posted (`--source card`). It records the receipt time and, with `features.hourglass` and `DORI_DISCORD_TOKEN`, puts ⏳ on the message. A failed reaction still records the obligation. Tracking the same message again keeps the first time.
- `ack <channel> <messageId>`: the lead's read receipt. ⏳ comes off (absent is fine), 👀 goes on, and only then the ack is recorded, so a failed reaction leaves the message due.
- `handled <channel> <messageId> [--lane KEY ...] [--reply] [--note T]`: links what handled it and closes the obligation.

State is `<stateDir>/owner-messages/`, one file per message and event, each written once, so the receiver, the lead and the sweep never rewrite each other's files. Handled messages are pruned after a day, everything after a week.

### `dori obligations [--loop MIN] [--once]`
Prints `UNACKED <channel> <message> <source> <sec>s "<text>"` once a tracked message has waited `ackTimeoutSec` without an ack, and `UNHANDLED <channel> <message> <source> <min>m acked|unacked "<text>"` once it has waited `handledTimeoutMin` from its ack (or receipt) without `handled`. Each line is printed once per message. Nothing is posted to the owner.

### `dori lead-watch [--loop MIN] [--once] [--session-file FILE]`
Watches the lead session itself, from the newest `session-lifecycle` entry in its session file (read from the end; never the whole file, never the screen): `paused`, `interrupted`, `tool-wait` (running, but the last message is a tool call with no result), `idle` or `running`.
- `LEAD_PAUSED <state> <min>m since=<iso> unacked=<n>`: once per pause or interruption that has lasted `leadWatch.pausedMin`.
- `LEAD_UNREAD <state> <n> oldest=<channel> <message> <min>m`: once per (oldest unacked message, lead state) when tracked messages have waited `leadUnreadRestartMin` and the lead is not `running`.
- With `leadWatch.autoResume`: `LEAD_RESUMED`, or `LEAD_PAUSED_INPUT` when the input line holds text (nothing is typed), or `LEAD_RESUME_SKIPPED` without the Paused footer.
- With `leadWatch.restartProposeMin`: `LEAD_RESTART_PROPOSED`. dori never restarts the lead.

Each `LEAD_PAUSED` / `LEAD_UNREAD` / `LEAD_RESTART_PROPOSED` line also runs `hooks.leadAlert`; a failing hook prints `LEAD_ALERT_FAILED`. Without a session file it prints `LEAD_WATCH_NO_SESSION` once per cause.

### `dori dead-panes [--loop MIN]`
Prints `DEAD_PANE <id>` once per hour for a pane with no running agent status whose last lines match `deadPanePatterns` on two ticks in a row with the same text. A pane herdr reports as idle, working, blocked or done is never dead. A pane that is neither is unrecognised; three unrecognised ticks in a row print `UNRECOGNISED_PANE <id> ...` once (list non-agent panes in `ignorePanes`).

### `dori guard [--loop MIN]`
Prints `HOST_GUARD ALERT <reasons>` when load, free memory, free disk or the pane count crosses its threshold, and `HOST_GUARD CLEAR` when it recovers. It also prints `COMPUTE_READY` / `COMPUTE_BUSY` as load crosses `loadOk`. Only changes are printed.

### `dori can-launch`
Prints `CAN_LAUNCH` and exits 0 when the host has room for another lane. Otherwise it prints `HOLD <reasons>` and exits 4. The reasons come from the guard's memory, disk and pane-count thresholds. CPU load alone never holds a launch, because it moves too fast to plan around.

### `dori send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]`
Posts a message, or edits one with `--edit`. Tokens come from `DORI_SLACK_TOKEN` (plus `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` or `DORI_DISCORD_TOKEN`. Text containing `$(` is refused, since it can only come from a shell string. Rate limits are retried with the server's wait time; other errors fail at once.

### `dori presence <slack|discord>`
Keeps the account shown as online until stopped.
- **Discord:** the bot connects to the gateway and identifies as online.
- **Slack, user token:** it opens one web-client-type socket and tickles it every minute. Slack shows a user active only while such a socket is open, and auto-aways an idle one after about 30 minutes.
- Run one instance per account. Two writers flip each other's presence.

### `dori inbound slack [--loop MIN]`
Prints `INBOUND <source> <channel> <thread> <ts> <user> <text>`. It reads from three places, each message once:
- `threads-view`: unread replies in threads the account follows (Slack's own Threads view);
- `own-thread`: new replies in any thread the Dori posted in, tagged or not;
- `unread`: DMs, group DMs and channels with unread mentions.

The Dori's own messages and bot messages are skipped. Every message the Dori posts records its thread in `<stateDir>/slack-threads.json`, whichever helper sends it, so a guest's untagged reply under a root posted with a raw API call is still found.

### `dori transcribe <audio-file>`
Runs `hooks.transcribe` and prints the transcript. A failed or empty transcription is an error, never an empty message.

### `dori heavy <label> -- <command ...>`
Waits until load is under `heavyMaxLoad` and one of `heavySlots` is free, then runs the command and frees the slot when it exits. A slot held by a process that no longer exists (or a zombie) is taken over. Use it for full builds and test suites. Installs, focused tests and git do not need it.

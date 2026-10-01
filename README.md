# claude-watchdog

A second model watching every turn of your Claude Code session.

The **watchdog** reads the transcript as the agent works (its reasoning, tool calls and results) on its
own context and its own model, verifies suspicions with read-only tools, and injects short
`<advisory>` notes back into the running session: a quiet `nit`, a `concern`, or a hard `blocker`.
The main agent weighs the advice and course-corrects, or tells you why it won't.

Inspired by the *advisor* in [oh-my-pi](https://github.com/can1357/oh-my-pi) (`docs/advisor-watchdog.md`).

## Plugin or hook?

A **plugin that bundles hooks**. Hooks are the mechanism (the only place Claude Code lets an outside
process see the transcript and talk back into the session); the plugin is the packaging
(install, update, `/watchdog` command, per-user config).

## Install

```
/plugin marketplace add oni-giri/claude-watchdog
/plugin install watchdog@claude-watchdog
```

Or try it from a checkout: `claude --plugin-dir ./plugins/watchdog`.

Requires `node` ≥ 18 and the `claude` CLI on `PATH` (the reviewer is `claude -p`, so it uses your existing login. No API key needed).

## How it works

```
 main session                                         watchdog
 ────────────                                         ────────
 PostToolUse ──(async)──► review hook ─ every N tool calls, enough new transcript ─►  claude -p --model opus
                              │                                                       (read-only tools, own context)
                              ▼                                                          │
                       inbox/ (one file per note) ◄── emission guard (noise, dupes, budget)
                              │
 PreToolUse   ◄── blocker: tool call denied with the advisory · concern: injected as context
 PostToolUse  ◄── nits (and anything left) injected as context at the step boundary
 Stop         ──► final review of the turn; blocker (or mid-run concern) ⇒ `decision: block`
 UserPromptSubmit ◄── anything held back while the agent was idle
 agent idle + late blocker ⇒ `asyncRewake` (exit 2) wakes the agent
```

| Severity  | Delivery |
|-----------|----------|
| `nit`     | Aside, injected after the next tool call. |
| `concern` | Injected before the next tool call. At Stop, held for your next prompt if it came from the final review (a mid-run concern the agent hasn't seen yet blocks the stop). |
| `blocker` | The next tool call is **denied** with the advisory as the reason; at Stop it blocks stopping; if the agent already went idle it is woken via `asyncRewake`. |

Design points carried over from omp:

- **Advice, not orders.** Notes carry `guidance="weigh, don't blindly obey"`. The reviewer cannot edit anything.
- **Guard in code, not in prose.** Content-free notes ("LGTM", "stop."), repeats (unless escalated nit→concern→blocker) and notes over the per-review budget (default 4, blockers exempt) are dropped.
- **No recursion.** The reviewer runs with hooks disabled and `WATCHDOG_CHILD=1`; subagent events are ignored; our own advisories are filtered out of what the reviewer reads.
- **Failures never wedge the session.** A broken reviewer is logged; after 3 consecutive failures its backlog is dropped. Hook errors exit 0.
- **Stop can't loop forever.** At most `maxStopBlocks` (default 2) consecutive blocks.
- Every review re-sends the user's original ask plus recent asks and the list of advice already raised, since each `claude -p` call is stateless.

## Configuration

Later wins: defaults < `~/.claude/watchdog.json` < `<project>/.claude/watchdog.json` < env.
Plugin options (`model`, `mode`) are prompted on enable. Env vars are `WATCHDOG_<NAME>` (see `lib/config.mjs`).

| key | default | meaning |
|-----|---------|---------|
| `model` | `opus` | advisor model. Ideally stronger than the driver |
| `mode` | `turn` | `turn`: review while working and at Stop · `final`: only at Stop |
| `reviewInterval` | `3` | review every Nth tool call |
| `minDeltaChars` | `1500` | skip a mid-run review until this much new transcript exists |
| `minStopChars` | `120` | skip the final review for trivial turns |
| `maxNotesPerUpdate` | `4` | non-blocker notes per review |
| `tools` | `Read,Grep,Glob` | advisor's tools |
| `stopBlocksOnConcern` | `false` | let final-review concerns block Stop too |
| `maxStopBlocks` | `2` | consecutive Stop blocks before releasing |
| `timeoutMs` / `stopWaitMs` | `240000` / `90000` | reviewer cap / how long Stop waits for an in-flight review |

**`WATCHDOG.md`** (user `~/.claude/WATCHDOG.md`, plus `WATCHDOG.md` or `.claude/WATCHDOG.md` from the repo root down to cwd) is advisor-only guidance: review priorities, project traps, dangerous APIs. It is *not* shown to the main agent.

**`/watchdog [status|on|off|dump [n]|clear]`** controls the current session. `off` is session-scoped.

## Cost

Each review is a real model call (measured ≈ $0.015–0.03 with `sonnet` on small deltas; more with `opus` and big deltas). The defaults (review every 3 tool calls, 1500-char minimum, no review for trivial turns) keep it bounded; `mode: final` is the cheapest. `/watchdog status` shows reviews, tokens and cost for the session.

## Limits vs. omp (v0.1)

- Hooks can't abort an *in-flight* tool the way omp's steering does. Blockers land at the next tool boundary (or wake the idle agent).
- The reviewer is stateless per call (no persistent advisor conversation / prompt cache yet), so each call re-pays the transcript delta + pinned context.
- One advisor; no `WATCHDOG.yml` roster, no fallback model chains, no `syncBacklog` (the Stop hook does wait for an in-flight review).
- Transcript files are written asynchronously, so the newest tool result may land one review later.

## Develop

```
cd plugins/watchdog && node --test test/*.test.mjs   # fake reviewer backend, no tokens spent
claude plugin validate ./plugins/watchdog
```

`WATCHDOG_REVIEWER_CMD` swaps the reviewer for any command that reads the prompt on stdin and prints `{"notes":[…]}`.

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

Optional live view (see [Seeing what the advisor says](#seeing-what-the-advisor-says)):

```
/plugin install watchdog-ui@claude-watchdog
# or: claude --plugin-dir ./plugins/watchdog --plugin-dir ./plugins/watchdog-ui
```

Requires `node` ≥ 18. By default the reviewer is `claude -p` (uses your existing login, no API key). To use a non-Claude model, see [Other models](#other-models-openai-compatible).

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

## Seeing what the advisor says

Notes reach the agent as hidden context. You see them two ways:

- **Built in:** each delivered note is also printed to you as a line in the session (`Watchdog [concern] → agent: …`, via the hooks' `systemMessage`). `showNotes`: `auto` (default; off while watchdog-ui runs), `always`, `never`.
- **`watchdog-ui` plugin** (optional, uses Claude Code's early-access mod API; interactive terminal/desktop only):
  - a **card in the transcript** for each delivered note (`▲ Watchdog concern — before its next tool call`), a notice row the model never reads;
  - a **band above the prompt**: model, reviews, cost, pending blockers/concerns/nits, the last note, any reviewer error, with a `hide` button;
  - a **toast** the moment a blocker is queued.

  It follows `~/.claude/watchdog/feed/<session>.jsonl`, which the watchdog hooks write, and touches `~/.claude/watchdog/ui-heartbeat` so the plain-text line is skipped while it draws.

## Configuration

Later wins: defaults < plugin options < `~/.claude/watchdog.json` < `<project>/.claude/watchdog.json` < env.
Plugin options (`model`, `mode`, `base_url`, `api_key`) are prompted on enable. Env vars are `WATCHDOG_<NAME>` (see `lib/config.mjs`).

| key | default | meaning |
|-----|---------|---------|
| `model` | `opus` | advisor model (Claude alias/id, or the name your endpoint serves). Ideally stronger than the driver |
| `provider` / `baseUrl` / `apiKey` / `apiKeyEnv` | – | OpenAI-compatible backend, see above |
| `mode` | `turn` | `turn`: review while working and at Stop · `final`: only at Stop |
| `reviewInterval` | `3` | review every Nth tool call |
| `minDeltaChars` | `1500` | skip a mid-run review until this much new transcript exists |
| `minStopChars` | `120` | skip the final review for trivial turns |
| `maxNotesPerUpdate` | `4` | non-blocker notes per review |
| `tools` | `Read,Grep,Glob` | advisor's tools |
| `showNotes` | `auto` | print delivered notes to you as a session line (`auto` = unless watchdog-ui runs) |
| `stopBlocksOnConcern` | `false` | let final-review concerns block Stop too |
| `maxStopBlocks` | `2` | consecutive Stop blocks before releasing |
| `timeoutMs` / `stopWaitMs` | `240000` / `90000` | reviewer cap / how long Stop waits for an in-flight review |

**`WATCHDOG.md`** (user `~/.claude/WATCHDOG.md`, plus `WATCHDOG.md` or `.claude/WATCHDOG.md` from the repo root down to cwd) is advisor-only guidance: review priorities, project traps, dangerous APIs. It is *not* shown to the main agent.

**`/watchdog [status|on|off|dump [n]|clear]`** controls the current session (`off` is session-scoped). **`/watchdog setup | show | test`** configure and verify the backend; `ctl set <key> <value>` / `unset` edit `~/.claude/watchdog.json`.

## Other models (OpenAI-compatible)

Point the advisor at any OpenAI-compatible `/chat/completions` endpoint (OpenAI, OpenRouter, Together, Ollama, vLLM, LM Studio, a LiteLLM proxy…). Setting a base URL switches the backend; the advisor then runs its own small **read-only** `read_file` / `grep` / `glob` tool loop (confined to the project dir, symlinks resolved, ≤ 6 rounds) via standard function calling, so the model must support tool calls to verify things (without them it still reviews from the transcript alone).

Easiest: run **`/watchdog setup`** inside Claude Code. It asks (multiple choice) for the backend (Claude, OpenAI, OpenRouter, local/other URL), the model, the review mode and how to supply the key, saves it to `~/.claude/watchdog.json` and finishes with a live connectivity test (`/watchdog test`).

**API keys never go through the chat** (the chat is the transcript, and the transcript is sent to the reviewer). The wizard takes the *name* of an env var (`apiKeyEnv`), or you run the hidden-input prompt yourself in a terminal: `node <plugin>/scripts/watchdog.mjs ctl set-key` (stored mode 600). Keys are optional for servers on localhost. `ctl set` refuses `apiKey`.

Prefer files/env? Same settings, no wizard:

```bash
export WATCHDOG_BASE_URL=https://api.openai.com/v1      # or http://localhost:11434/v1
export WATCHDOG_API_KEY=sk-...                          # or WATCHDOG_API_KEY_ENV=OPENROUTER_API_KEY
export WATCHDOG_MODEL=gpt-4o                            # the model name your endpoint serves
```

or `~/.claude/watchdog.json`:

```json
{ "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "model": "anthropic/claude-sonnet-4.5",
  "extraBody": { "reasoning_effort": "high" }, "headers": { "HTTP-Referer": "https://example.com" } }
```

The plugin's enable-time options `base_url` / `api_key` (stored in your keychain) work too. `provider: "claude"` forces the CLI backend even when a URL is set; local servers that ignore auth can use any non-empty key.

**Security:** `provider`, `baseUrl`, `apiKey`, `apiKeyEnv`, `headers`, `extraBody` and `reviewerCommand` are honored **only** from your user config, plugin options and env, never from a project's `.claude/watchdog.json`. Otherwise a cloned repo could send your transcript and key to its own server. Note that with a third-party endpoint your transcript (prompts, code, tool output) goes to that provider.

Not measured for non-Claude backends: cost (tokens are tracked, dollars are not).

## Cost

Each review is a real model call (measured ≈ $0.015–0.03 with `sonnet` on small deltas; more with `opus` and big deltas). The defaults (review every 3 tool calls, 1500-char minimum, no review for trivial turns) keep it bounded; `mode: final` is the cheapest. `/watchdog status` shows reviews, tokens and cost for the session.

## Limits vs. omp (v0.1)

- Hooks can't abort an *in-flight* tool the way omp's steering does. Blockers land at the next tool boundary (or wake the idle agent).
- The reviewer is stateless per call (no persistent advisor conversation / prompt cache yet), so each call re-pays the transcript delta + pinned context.
- One advisor; no `WATCHDOG.yml` roster, no fallback model chains, no `syncBacklog` (the Stop hook does wait for an in-flight review).
- No mid-turn card *styling* yet: watchdog-ui's cards are plain notice rows (the band is coloured).
- Transcript files are written asynchronously, so the newest tool result may land one review later.

## Develop

```
cd plugins/watchdog && node --test test/*.test.mjs   # fake reviewer backend, no tokens spent
claude plugin validate ./plugins/watchdog
claude plugin validate ./plugins/watchdog-ui && claude plugin test ./plugins/watchdog-ui
```

`WATCHDOG_REVIEWER_CMD` swaps the reviewer for any command that reads the prompt on stdin and prints `{"notes":[…]}`.

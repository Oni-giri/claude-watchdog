---
name: watchdog
description: Control and configure the Watchdog advisor — status, on, off, dump, clear, show, test, and a guided `setup`.
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
argument-hint: "[status|on|off|dump [n]|clear|show|test|setup]"
---

The control script is `node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" ctl <command>`.

**If the argument is `setup`, run the guided setup below. Otherwise** run `ctl $ARGUMENTS` (default `status`) and show its output verbatim with no commentary.

## Guided setup

Goal: choose which model reviews this session, then save it to the user's `~/.claude/watchdog.json`. Use the AskUserQuestion tool (all questions in one call where possible). Do not ask anything in free text that the options can cover.

1. Ask **Backend** with options:
   - `Claude (this login)` — runs `claude -p`; no key needed.
   - `OpenAI` — base URL `https://api.openai.com/v1`
   - `OpenRouter` — base URL `https://openrouter.ai/api/v1`
   - `Local / other` — Ollama (`http://localhost:11434/v1`), LM Studio, vLLM, LiteLLM, or any OpenAI-compatible URL (the user picks "Other" to type it)
2. Ask **Model** (the user may type any name via "Other"). Suggest: for Claude `opus` / `sonnet`; for OpenAI `gpt-4o` / `o4-mini`; for OpenRouter `anthropic/claude-sonnet-4.5` / `google/gemini-2.5-pro`; for local, a model they have pulled.
3. Ask **Review mode**: `turn` (review while working and at the end; recommended) or `final` (only when the agent is about to stop; cheapest).
4. For a non-Claude backend, ask **API key source**:
   - `Env var` — then ask for the variable's NAME (e.g. `OPENAI_API_KEY`). The variable must exist in the shell that launches Claude Code.
   - `I'll enter it myself` — see below.
   - `No key needed` (local servers).

**NEVER ask the user to paste an API key into the chat, and never put one on a command line.** The chat is the transcript, and the transcript is sent to the reviewer.

Then apply with separate commands (one `set` each):

```
ctl set model <name>
ctl set mode <turn|final>
ctl set baseUrl <url>        # non-Claude only
ctl set provider openai      # non-Claude only; for Claude: `ctl unset baseUrl provider apiKeyEnv`
ctl set apiKeyEnv <NAME>     # if they chose an env var
```

If they chose to enter the key themselves, tell them to run this **in their own terminal** (not here), then continue: `node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" ctl set-key` — it prompts with hidden input and stores the key with mode 600. A key is optional for servers on localhost/127.x.

Finally run `ctl test` and report the result plainly. If it fails, explain the error and offer to adjust (wrong URL, key missing in the environment, model name not served). Setup takes effect on the next review; no restart needed.

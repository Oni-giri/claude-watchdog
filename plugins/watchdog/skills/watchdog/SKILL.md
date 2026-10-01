---
name: watchdog
description: Control the Watchdog advisor for this session — status, on, off, dump, clear.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[status|on|off|dump [n]|clear]"
---

Run exactly this command and show its output to the user verbatim, with no commentary:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/watchdog.mjs" ctl $ARGUMENTS
```

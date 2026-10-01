#!/usr/bin/env node
// Watchdog hook entry point: `watchdog.mjs <event>` with the hook payload on stdin.
import fs from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { bySeverity, formatAdvisories } from "../lib/format.mjs";
import { peekDelta, runReview } from "../lib/review.mjs";
import { Session, stateRoot } from "../lib/state.mjs";
import { readDelta, userAsks } from "../lib/transcript.mjs";
import { ctl } from "./ctl.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj));
const ctx = (hookEventName, notes) => ({ hookSpecificOutput: { hookEventName, additionalContext: formatAdvisories(notes.sort(bySeverity)) } });

async function readInput() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const c of process.stdin) raw += c;
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Open the session's state; on first sight mid-session, seed the cursor so we don't replay history. */
async function open(input) {
  const cwd = input.cwd || process.cwd();
  const root = stateRoot();
  const session = new Session(input.session_id, root);
  if (input.session_id) Session.setLatest(root, cwd, input.session_id);
  if (!fs.existsSync(session.file("state.json"))) {
    await session.update((st) => {
      if (input.hook_event_name !== "SessionStart" && input.transcript_path) {
        const { entries, nextCursor } = readDelta(input.transcript_path, 0);
        st.cursor = nextCursor;
        st.asks = userAsks(entries).slice(0, 1);
      }
    });
  }
  return { session, cwd, cfg: loadConfig(cwd) };
}

const active = (cfg, session) => cfg.enabled && !session.load().disabled;

async function main() {
  const event = process.argv[2];
  if (event === "ctl") return ctl(process.argv.slice(3));
  if (process.env.WATCHDOG_CHILD) return; // never watch the watcher
  const input = await readInput();
  if (input.agent_id) return; // advice is for the main agent, not its subagents
  const { session, cwd, cfg } = await open(input);
  if (!active(cfg, session)) return;

  switch (event) {
    case "session-start":
      return;

    case "prompt": {
      await session.update((st) => { st.idle = false; st.stopBlocks = 0; });
      const notes = session.take();
      if (notes.length) emit(ctx("UserPromptSubmit", notes));
      return;
    }

    // Before a tool runs: blockers hold the call, concerns ride along as context.
    case "pretool": {
      const blockers = session.take((n) => n.severity === "blocker");
      const concerns = session.take((n) => n.severity === "concern");
      if (blockers.length) {
        const reason = `${formatAdvisories(blockers)}\nThis tool call was held so you can read the advisory above. Reconsider, then retry or change course.`;
        emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason, additionalContext: formatAdvisories(concerns) } });
      } else if (concerns.length) {
        emit(ctx("PreToolUse", concerns));
      }
      return;
    }

    // After a tool ran: everything still pending (nits included) lands at this step boundary.
    case "deliver": {
      if (session.load().idle) await session.update((st) => { st.idle = false; });
      const notes = session.take();
      if (notes.length) emit(ctx("PostToolUse", notes));
      return;
    }

    // Async: review in the background; wake the idle agent only for a blocker.
    case "review": {
      if (cfg.mode === "final") return;
      const st = await session.update((s) => { s.idle = false; s.toolCalls++; });
      if (st.toolCalls < cfg.reviewInterval) return;
      if (peekDelta(session, input.transcript_path, cfg.maxDeltaChars) < cfg.minDeltaChars) return;
      const release = session.tryReviewLock(cfg.timeoutMs + 30000);
      if (!release) return;
      try {
        await runReview({ session, cfg, cwd, transcriptPath: input.transcript_path, final: false });
      } finally {
        release();
      }
      if (session.load().idle) {
        const blockers = session.take((n) => n.severity === "blocker");
        if (blockers.length) {
          process.stderr.write(formatAdvisories(blockers));
          process.exitCode = 2; // asyncRewake: wakes the idle agent with this text
        }
      }
      return;
    }

    case "stop": {
      await session.update((st) => { st.idle = true; });
      const waitUntil = Date.now() + cfg.stopWaitMs;
      while (session.reviewInFlight(cfg.timeoutMs + 30000) && Date.now() < waitUntil) await sleep(250);

      const release = session.tryReviewLock(cfg.timeoutMs + 30000);
      if (release) {
        try {
          if (peekDelta(session, input.transcript_path, cfg.maxDeltaChars) + (input.last_assistant_message?.length ?? 0) >= cfg.minStopChars) {
            await runReview({ session, cfg, cwd, transcriptPath: input.transcript_path, final: true, lastAssistant: input.last_assistant_message });
          }
        } finally {
          release();
        }
      }

      const st = session.load();
      const blocking = (n) => n.severity === "blocker" || (n.severity === "concern" && (!n.final || cfg.stopBlocksOnConcern));
      const canBlock = st.stopBlocks < cfg.maxStopBlocks;
      const taken = canBlock ? session.take(blocking) : [];
      if (taken.length) {
        await session.update((s) => { s.stopBlocks++; s.idle = false; });
        emit({ decision: "block", reason: `${formatAdvisories(taken.sort(bySeverity))}\nA second reviewer raised the advisories above before you finished. Address them, or explain why they don't apply, before you stop.` });
        return;
      }
      const left = session.pending();
      if (left.length) {
        const worst = left.sort(bySeverity)[0];
        emit({ systemMessage: `Watchdog: ${left.length} note(s) held for your next prompt (top: [${worst.severity}] ${worst.note.slice(0, 160)})` });
      }
      return;
    }
  }
}

main().catch((e) => {
  // A watchdog failure must never break the session it watches.
  try { process.stderr.write(`watchdog: ${e?.stack || e}\n`); } catch {}
  process.exitCode = 0;
});

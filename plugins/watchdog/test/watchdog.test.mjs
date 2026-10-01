import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { EmissionGuard, normalizeNote } from "../lib/guard.mjs";
import { parseReviewerOutput } from "../lib/reviewer.mjs";
import { Session } from "../lib/state.mjs";
import { readDelta, renderDelta, userAsks } from "../lib/transcript.mjs";
import { spawn, spawnSync } from "node:child_process";
import { SCRIPT, append, assistantText, hook, makeEnv, toolResult, toolUse, user } from "./helpers.mjs";

const run = (ctx, event, extra) => hook(ctx, event, { ...extra, __event: event });
const post = (ctx) => hook(ctx, "PostToolUse", { __event: "review" });
const deliver = (ctx) => hook(ctx, "PostToolUse", { __event: "deliver" });
const pre = (ctx) => hook(ctx, "PreToolUse", { __event: "pretool" });
const stop = (ctx, extra) => hook(ctx, "Stop", { __event: "stop", ...extra });

test("guard: noise, dedupe, escalation, budget", () => {
  assert.equal(normalizeNote("  *Stop.* "), "stop");
  const g = new EmissionGuard({}, 2);
  assert.equal(g.admit("Stop.", "blocker").reason, "noise");
  assert.equal(g.admit("   ").reason, "empty");
  assert.ok(g.admit("use const", "nit").accepted);
  assert.equal(g.admit("Use const!", "nit").reason, "duplicate");
  assert.ok(g.admit("use const", "concern").accepted, "escalation passes");
  assert.equal(g.admit("third non blocker", "nit").reason, "rate-limit");
  assert.ok(g.admit("real blocker", "blocker").accepted, "blockers exempt from budget");
});

test("transcript: delta cursor ignores partial line, render drops noise and own advice", () => {
  const ctx = makeEnv();
  fs.writeFileSync(ctx.transcript, [user("fix the bug"), JSON.stringify({ type: "attachment", attachment: { type: "date" } }), assistantText("on it")].join("\n") + "\n{\"type\":\"user\",\"mess");
  const d = readDelta(ctx.transcript, 0);
  assert.equal(d.entries.length, 3);
  const text = renderDelta(d.entries);
  assert.match(text, /\[user\]\nfix the bug/);
  assert.doesNotMatch(text, /attachment/);
  assert.deepEqual(userAsks(d.entries), ["fix the bug"]);
  const own = [{ type: "user", message: { content: '<advisory source="watchdog" severity="nit">x</advisory>' } }];
  assert.equal(renderDelta(own), "");
  // elision of huge tool results
  const big = [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "z".repeat(10000) }] } }];
  assert.match(renderDelta(big), /chars elided/);
});

test("parseReviewerOutput handles structured_output, fenced result and errors", () => {
  assert.deepEqual(parseReviewerOutput(JSON.stringify({ structured_output: { notes: [{ severity: "concern", note: "x" }] } })).notes, [{ severity: "concern", note: "x" }]);
  assert.equal(parseReviewerOutput(JSON.stringify({ result: "```json\n{\"notes\":[{\"severity\":\"bogus\",\"note\":\"y\"}]}\n```" })).notes[0].severity, "nit");
  assert.ok(parseReviewerOutput("garbage").error);
  assert.ok(parseReviewerOutput(JSON.stringify({ is_error: true, result: "boom" })).error);
});

test("child sessions are never watched", () => {
  const ctx = makeEnv();
  ctx.env.WATCHDOG_CHILD = "1";
  append(ctx.transcript, user("go"), toolUse("Bash", { command: "DROP TABLE users" }));
  assert.equal(post(ctx).stdout, "");
  assert.deepEqual(new Session("s1", ctx.env.CLAUDE_PLUGIN_DATA).pending(), []);
});

test("mid-run: nit is held to the post-tool boundary, concern rides pre-tool context, blocker denies", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  append(ctx.transcript, user("implement it"), toolUse("Write", { content: "var x = 1 // TODO stub" }), toolResult("ok"));
  const r = post(ctx);
  assert.equal(r.status, 0);
  const s = new Session("s1", ctx.env.CLAUDE_PLUGIN_DATA);
  assert.deepEqual(s.pending().map((n) => n.severity).sort(), ["concern", "nit"]);

  const p = pre(ctx); // concern delivered before the next tool
  assert.match(p.json.hookSpecificOutput.additionalContext, /severity="concern"/);
  assert.equal(p.json.hookSpecificOutput.permissionDecision, undefined);

  const d = deliver(ctx); // nit lands at the step boundary
  assert.match(d.json.hookSpecificOutput.additionalContext, /severity="nit"/);
  assert.equal(deliver(ctx).stdout, "", "nothing is delivered twice");

  append(ctx.transcript, toolUse("Bash", { command: "psql -c 'DROP TABLE users'" }, "t2"));
  post(ctx);
  const deny = pre(ctx);
  assert.equal(deny.json.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.json.hookSpecificOutput.permissionDecisionReason, /DROP TABLE/);
});

test("review interval and min-delta gate cost", () => {
  const ctx = makeEnv();
  ctx.env.WATCHDOG_REVIEW_INTERVAL = "3";
  run(ctx, "SessionStart");
  append(ctx.transcript, user("go"), toolUse("Write", { content: "var x" }));
  post(ctx); post(ctx);
  const s = new Session("s1", ctx.env.CLAUDE_PLUGIN_DATA);
  assert.equal(s.load().usage.reviews, 0);
  post(ctx);
  assert.equal(s.load().usage.reviews, 1);
});

test("stop: a blocker blocks; the same finding is not re-raised", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  append(ctx.transcript, user("clean up the db"), assistantText("Dropping the table: DROP TABLE users. Done."));
  const r = stop(ctx, { last_assistant_message: "Dropping the table: DROP TABLE users. Done." });
  assert.equal(r.json.decision, "block");
  assert.match(r.json.reason, /severity="blocker"/);

  // same finding again is a duplicate → nothing new; agent can finish
  append(ctx.transcript, assistantText("Done, honestly. DROP TABLE users"));
  const r2 = stop(ctx, { stop_hook_active: true });
  assert.notEqual(r2.json?.decision, "block");
});

test("stop: a final-review concern is preserved (not blocking) and delivered on the next prompt", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  append(ctx.transcript, user("write it"), assistantText("Implemented: TODO stub in place. Finished and ready for you to review in full."));
  const r = stop(ctx, { last_assistant_message: "Implemented: TODO stub in place." });
  assert.notEqual(r.json.decision, "block");
  assert.match(r.json.systemMessage, /held for your next prompt/);
  const p = hook(ctx, "UserPromptSubmit", { __event: "prompt", prompt: "ok" });
  assert.match(p.json.hookSpecificOutput.additionalContext, /Stubbed implementation/);
});

test("idle agent: a blocker finishing after Stop wakes it via exit 2; a nit just waits", async () => {
  const ctx = makeEnv();
  ctx.env.WATCHDOG_REVIEWER_CMD = `sleep 1; node ${ctx.dir}/fake-reviewer.mjs`; // review outlives the agent's turn
  run(ctx, "SessionStart");
  append(ctx.transcript, user("go"), toolUse("Bash", { command: "DROP TABLE users; var x" }));
  const input = JSON.stringify({ session_id: "s1", cwd: ctx.cwd, transcript_path: ctx.transcript, hook_event_name: "PostToolUse" });
  const child = spawn("node", [SCRIPT, "review"], { env: ctx.env });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(input);
  await new Promise((r) => setTimeout(r, 400)); // review is now in flight
  const s = new Session("s1", ctx.env.CLAUDE_PLUGIN_DATA);
  await s.update((st) => { st.idle = true; }); // ...and the agent just stopped
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 2);
  assert.match(stderr, /severity="blocker"/);
  assert.deepEqual(s.pending().map((n) => n.severity), ["nit"], "nit preserved for the next prompt");
});

test("/watchdog ctl: status, off silences hooks, on restores", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  const ctl = (c) => spawnSync("node", [SCRIPT, "ctl", c], { cwd: ctx.cwd, env: ctx.env, encoding: "utf8" }).stdout;
  assert.match(ctl("status"), /watchdog: ON/);
  assert.match(ctl("off"), /watchdog off/);
  append(ctx.transcript, user("go"), toolUse("Bash", { command: "DROP TABLE users" }));
  post(ctx);
  assert.deepEqual(new Session("s1", ctx.env.CLAUDE_PLUGIN_DATA).pending(), []);
  assert.match(ctl("status"), /OFF/);
  ctl("on");
  post(ctx);
  assert.equal(new Session("s1", ctx.env.CLAUDE_PLUGIN_DATA).pending().length, 1);
});

test("stop: maxStopBlocks (project .claude/watchdog.json) lets the agent finish", () => {
  const ctx = makeEnv();
  fs.mkdirSync(`${ctx.cwd}/.claude`, { recursive: true });
  fs.writeFileSync(`${ctx.cwd}/.claude/watchdog.json`, JSON.stringify({ maxStopBlocks: 0 }));
  run(ctx, "SessionStart");
  append(ctx.transcript, user("clean up the db"), assistantText("Dropping the table: DROP TABLE users. Done."));
  const r = stop(ctx, { last_assistant_message: "DROP TABLE users" });
  assert.notEqual(r.json?.decision, "block");
  assert.match(r.json.systemMessage, /1 note/);
});

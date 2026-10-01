import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(here, "..", "scripts", "watchdog.mjs");

/** Fake reviewer: reads the prompt on stdin, answers from keywords in the transcript. */
const FAKE = `
let p=""; process.stdin.on("data",d=>p+=d).on("end",()=>{
  const notes=[];
  if(p.includes("DROP TABLE")) notes.push({severity:"blocker",note:"Destructive DROP TABLE on prod data."});
  if(p.includes("TODO stub")) notes.push({severity:"concern",note:"Stubbed implementation instead of real code."});
  if(p.includes("var x")) notes.push({severity:"nit",note:"Use const."});
  console.log(JSON.stringify({structured_output:{notes},total_cost_usd:0.01,usage:{input_tokens:100,output_tokens:10}}));
});`;

export function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wd-test-"));
  const fake = path.join(dir, "fake-reviewer.mjs");
  fs.writeFileSync(fake, FAKE);
  const cwd = path.join(dir, "proj");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, "");
  const env = {
    ...process.env,
    HOME: dir, // isolate ~/.claude/watchdog.json
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    WATCHDOG_REVIEWER_CMD: `node ${fake}`,
    WATCHDOG_REVIEW_INTERVAL: "1",
    WATCHDOG_MIN_DELTA_CHARS: "10",
    WATCHDOG_MIN_STOP_CHARS: "10",
    WATCHDOG_STOP_WAIT_MS: "500",
  };
  delete env.WATCHDOG_CHILD;
  return { dir, cwd, transcript, env };
}

export const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
export const assistantText = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
export const toolUse = (name, input, id = "t1") => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
export const toolResult = (text, id = "t1") => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
export const append = (file, ...lines) => fs.appendFileSync(file, lines.join("\n") + "\n");

export function hook(ctx, event, extra = {}) {
  const input = { session_id: "s1", cwd: ctx.cwd, transcript_path: ctx.transcript, hook_event_name: event, ...extra };
  const r = spawnSync("node", [SCRIPT, extra.__event ?? event], { input: JSON.stringify(input), env: ctx.env, encoding: "utf8" });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEVERITIES } from "./guard.mjs";
import { callOpenAI } from "./openai.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: { severity: { enum: SEVERITIES }, note: { type: "string" } },
        required: ["severity", "note"],
      },
    },
  },
  required: ["notes"],
};

export function systemPrompt(cfg, watchdogNotes = []) {
  let sys = fs.readFileSync(path.join(here, "..", "prompts", "reviewer-system.md"), "utf8")
    .replace("{{MAX_NOTES}}", String(cfg.maxNotesPerUpdate));
  if (watchdogNotes.length) {
    sys += `\nEspecially pay attention to:\n<attention>\n${watchdogNotes.join("\n\n")}\n</attention>\n`;
  }
  return sys;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildPrompt({ asks, raised, delta, final, cwd }) {
  const parts = [`Session cwd: ${cwd}`];
  if (asks.length) parts.push(`<user-asks>\n${asks.map((a, i) => `(${i + 1}) ${a}`).join("\n\n")}\n</user-asks>`);
  if (raised.length) {
    parts.push(`<already-raised>\n${raised.map((r) => `- [${r.severity}] ${r.note}`).join("\n")}\n</already-raised>`);
  }
  const heading = final ? "Agent finished its turn" : "[in progress — more steps follow]";
  parts.push(`<transcript-update status="${heading}">\n${esc(delta)}\n</transcript-update>`);
  parts.push("Review the update. Reply with the JSON object only.");
  return parts.join("\n\n");
}

/** Pull `{notes}` out of `claude -p --output-format json` output (or a custom backend's raw JSON). */
export function parseReviewerOutput(stdout) {
  let obj;
  try { obj = JSON.parse(stdout); } catch { return { notes: [], error: "reviewer output was not JSON" }; }
  const usage = {
    costUsd: obj.total_cost_usd ?? 0,
    inputTokens: (obj.usage?.input_tokens ?? 0) + (obj.usage?.cache_creation_input_tokens ?? 0) + (obj.usage?.cache_read_input_tokens ?? 0),
    outputTokens: obj.usage?.output_tokens ?? 0,
  };
  if (obj.is_error) return { notes: [], error: String(obj.result ?? "reviewer error").slice(0, 300), usage };
  let payload = obj.structured_output;
  if (!payload && typeof obj.result === "string") {
    try { payload = JSON.parse(obj.result.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch {}
  }
  if (!payload && Array.isArray(obj.notes)) payload = obj;
  if (!payload || !Array.isArray(payload.notes)) return { notes: [], error: "reviewer returned no notes object", usage };
  const notes = payload.notes
    .filter((n) => n && typeof n.note === "string")
    .map((n) => ({ severity: SEVERITIES.includes(n.severity) ? n.severity : "nit", note: n.note.trim() }));
  return { notes, usage };
}

/** Run one review. Resolves { notes, usage?, error? }; never rejects. */
export function callReviewer(args) {
  const { cfg } = args;
  if (!cfg.reviewerCommand && (cfg.provider === "openai" || (cfg.provider !== "claude" && cfg.baseUrl))) return callOpenAI(args);
  return callClaude(args);
}

function callClaude({ cfg, cwd, system, prompt }) {
  return new Promise((resolve) => {
    const env = { ...process.env, WATCHDOG_CHILD: "1" };
    let child;
    if (cfg.reviewerCommand) {
      child = spawn(cfg.reviewerCommand, { shell: true, cwd, env });
    } else {
      const args = [
        "-p",
        "--model", cfg.model,
        "--system-prompt", system,
        "--tools", cfg.tools,
        "--permission-mode", "dontAsk",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--settings", JSON.stringify({ disableAllHooks: true }),
        "--output-format", "json",
        "--json-schema", JSON.stringify(SCHEMA),
      ];
      child = spawn("claude", args, { cwd, env });
    }
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ notes: [], error: `reviewer timed out after ${cfg.timeoutMs}ms` }); }, cfg.timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ notes: [], error: `could not start reviewer: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!out.trim()) return resolve({ notes: [], error: `reviewer exited ${code} with no output: ${err.slice(0, 300)}` });
      resolve(parseReviewerOutput(out));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

import fs from "node:fs";
import path from "node:path";
import { SEVERITIES } from "./guard.mjs";

const MAX_ROUNDS = 6; // tool-call rounds before the advisor must answer
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", "target", "__pycache__"]);

/** Lenient `{notes}` extraction for models without strict structured output. */
export function parseNotesText(text) {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let obj;
  for (const cand of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    try { obj = JSON.parse(cand); break; } catch {}
  }
  const list = Array.isArray(obj) ? obj : obj?.notes;
  if (!Array.isArray(list)) return null;
  return list
    .filter((n) => n && typeof n.note === "string")
    .map((n) => ({ severity: SEVERITIES.includes(n.severity) ? n.severity : "nit", note: n.note.trim() }));
}

// ---------- read-only tools, confined to the project directory ----------

function confine(root, p = ".") {
  const abs = path.resolve(root, p);
  let real;
  try { real = fs.realpathSync(abs); } catch { real = abs; }
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error("path is outside the project directory");
  return real;
}

function* walk(dir, root, limit = 5000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); }
      else if (e.isFile()) { n++; yield path.relative(root, full); }
    }
  }
}

function globToRegex(g) {
  const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${re}$`);
}

export const TOOLS = {
  read_file: {
    spec: { description: "Read a text file from the project. Returns numbered lines.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "1-based first line" }, limit: { type: "integer", description: "max lines (default 200)" } }, required: ["path"] } },
    run(root, a) {
      const file = confine(root, a.path);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const start = Math.max(1, a.offset | 0 || 1);
      const slice = lines.slice(start - 1, start - 1 + Math.min(a.limit | 0 || 200, 500));
      return slice.map((l, i) => `${start + i}\t${l}`).join("\n").slice(0, 20000) || "(empty)";
    },
  },
  grep: {
    spec: { description: "Regex search over project files. Returns path:line:text.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "subdirectory (default .)" }, glob: { type: "string", description: "filter, e.g. **/*.ts" } }, required: ["pattern"] } },
    run(root, a) {
      const base = confine(root, a.path || ".");
      const re = new RegExp(a.pattern);
      const g = a.glob ? globToRegex(a.glob) : null;
      const out = [];
      for (const rel of walk(base, root)) {
        if (g && !g.test(rel)) continue;
        let text;
        try { if (fs.statSync(path.join(root, rel)).size > 1e6) continue; text = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
        if (text.includes("\u0000")) continue;
        const ls = text.split("\n");
        for (let i = 0; i < ls.length && out.length < 60; i++) if (re.test(ls[i])) out.push(`${rel}:${i + 1}:${ls[i].slice(0, 200)}`);
        if (out.length >= 60) break;
      }
      return out.join("\n") || "(no matches)";
    },
  },
  glob: {
    spec: { description: "List project files matching a glob like src/**/*.ts.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
    run(root, a) {
      const re = globToRegex(a.pattern);
      const out = [];
      for (const rel of walk(root, root)) if (re.test(rel) && out.push(rel) >= 200) break;
      return out.join("\n") || "(no matches)";
    },
  },
};

// Claude-style names in `cfg.tools` map to ours.
const ALIAS = { Read: "read_file", Grep: "grep", Glob: "glob", read_file: "read_file", grep: "grep", glob: "glob" };
const enabledTools = (cfg) => [...new Set(String(cfg.tools || "").split(/[\s,]+/).map((t) => ALIAS[t]).filter(Boolean))];

/**
 * One review against any OpenAI-compatible /chat/completions endpoint.
 * Never rejects: resolves { notes, usage?, error? }.
 */
export async function callOpenAI({ cfg, cwd, system, prompt }) {
  if (!cfg.baseUrl) return { notes: [], error: "openai provider: baseUrl is not set" };
  const local = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(cfg.baseUrl);
  if (!cfg.apiKey && !local) return { notes: [], error: "openai provider: no API key (set apiKeyEnv/WATCHDOG_API_KEY, run `ctl set-key` in a terminal, or use the plugin's api_key option)" };
  if (!cfg.model || cfg.model === "opus") return { notes: [], error: "openai provider: set `model` to a model name your endpoint serves" };

  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const names = enabledTools(cfg);
  const tools = names.map((n) => ({ type: "function", function: { name: n, ...TOOLS[n].spec } }));
  const messages = [{ role: "system", content: system + '\nReply with the JSON object only: {"notes":[{"severity":"nit|concern|blocker","note":"..."}]}.' }, { role: "user", content: prompt }];
  const usage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const body = { model: cfg.model, messages, temperature: 0, ...(cfg.extraBody || {}) };
      if (tools.length && round < MAX_ROUNDS) body.tools = tools;
      const res = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}), ...(cfg.headers || {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { notes: [], usage, error: `endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const json = await res.json();
      usage.inputTokens += json.usage?.prompt_tokens ?? 0;
      usage.outputTokens += json.usage?.completion_tokens ?? 0;
      const msg = json.choices?.[0]?.message;
      if (!msg) return { notes: [], usage, error: "endpoint returned no choices" };

      if (msg.tool_calls?.length && round < MAX_ROUNDS) {
        messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
        for (const call of msg.tool_calls) {
          let out;
          try {
            const tool = names.includes(call.function?.name) ? TOOLS[call.function.name] : null;
            if (!tool) throw new Error(`tool ${call.function?.name} not available`);
            out = tool.run(cwd, JSON.parse(call.function.arguments || "{}"));
          } catch (e) { out = `error: ${e.message}`; }
          messages.push({ role: "tool", tool_call_id: call.id, content: String(out).slice(0, 20000) });
        }
        continue;
      }
      const notes = parseNotesText(msg.content);
      if (!notes) return { notes: [], usage, error: "model reply was not a {notes:[…]} JSON object" };
      return { notes, usage };
    }
    return { notes: [], usage, error: "tool loop did not converge" };
  } catch (e) {
    return { notes: [], usage, error: e.name === "AbortError" ? `reviewer timed out after ${cfg.timeoutMs}ms` : `request failed: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

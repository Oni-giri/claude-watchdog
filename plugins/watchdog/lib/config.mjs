import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  enabled: true,
  /** Model the advisor runs on. Stronger than the driver is the point. */
  model: "opus",
  /** "claude" (the claude CLI) or "openai" (any OpenAI-compatible endpoint). Default: openai when baseUrl is set. */
  provider: null,
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: null,
  /** API key. Prefer env (WATCHDOG_API_KEY / apiKeyEnv) over committing it to a config file. */
  apiKey: null,
  /** Name of an env var holding the key, e.g. "OPENROUTER_API_KEY". */
  apiKeyEnv: null,
  /** Extra JSON merged into the request body (e.g. {"reasoning_effort":"high"}). */
  extraBody: null,
  /** Extra HTTP headers. */
  headers: null,
  /** turn: review while the agent works and at the end. final: review only at Stop. */
  mode: "turn",
  /** Review every Nth PostToolUse (turn mode). */
  reviewInterval: 3,
  /** Skip a mid-run review until this much new transcript has accumulated. */
  minDeltaChars: 1500,
  /** At Stop, skip the final review when the turn added less than this much transcript. */
  minStopChars: 120,
  /** Max non-blocker notes accepted per review. Blockers are exempt. */
  maxNotesPerUpdate: 4,
  /** Read-only investigative tools granted to the advisor. */
  tools: "Read,Grep,Glob",
  /** Hard cap on one reviewer invocation. */
  timeoutMs: 240000,
  /** How long Stop waits for an in-flight background review. */
  stopWaitMs: 90000,
  /** Cap on transcript characters sent per review (tail is kept). */
  maxDeltaChars: 60000,
  /** At Stop, also block on concerns (not just blockers) raised by the final review. */
  stopBlocksOnConcern: false,
  /** Max consecutive Stop blocks before the watchdog lets the agent finish. */
  maxStopBlocks: 2,
  /** Show delivered notes to the person as a line in the session: "auto" (unless the watchdog-ui mod is running), "always", "never". */
  showNotes: "auto",
  /** Escape hatch (tests / custom backends): shell command, prompt on stdin, JSON {notes:[...]} on stdout. */
  reviewerCommand: null,
};

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const num = (v) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const bool = (v) => (v === undefined || v === "" ? undefined : /^(1|true|yes|on)$/i.test(String(v)));

function fromEnv(env) {
  const out = {
    model: env.WATCHDOG_MODEL,
    mode: env.WATCHDOG_MODE,
    enabled: bool(env.WATCHDOG_ENABLED),
    reviewInterval: num(env.WATCHDOG_REVIEW_INTERVAL),
    minDeltaChars: num(env.WATCHDOG_MIN_DELTA_CHARS),
    minStopChars: num(env.WATCHDOG_MIN_STOP_CHARS),
    maxNotesPerUpdate: num(env.WATCHDOG_MAX_NOTES),
    timeoutMs: num(env.WATCHDOG_TIMEOUT_MS),
    stopWaitMs: num(env.WATCHDOG_STOP_WAIT_MS),
    tools: env.WATCHDOG_TOOLS,
    provider: env.WATCHDOG_PROVIDER,
    baseUrl: env.WATCHDOG_BASE_URL,
    apiKey: env.WATCHDOG_API_KEY,
    apiKeyEnv: env.WATCHDOG_API_KEY_ENV,
    reviewerCommand: env.WATCHDOG_REVIEWER_CMD,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}

/**
 * Keys that decide where the transcript is sent or what gets executed. A cloned repo
 * must not be able to set them (it could exfiltrate the transcript and your API key,
 * or run a command), so project-level files are stripped of them.
 */
export const TRUSTED_ONLY = ["provider", "baseUrl", "apiKey", "apiKeyEnv", "headers", "extraBody", "reviewerCommand"];
const untrusted = (layer) => Object.fromEntries(Object.entries(layer).filter(([k]) => !TRUSTED_ONLY.includes(k)));

/** Plugin userConfig (prompted on enable). Lowest precedence above defaults: config files and WATCHDOG_* win. */
function fromPluginOptions(env) {
  const out = { model: env.CLAUDE_PLUGIN_OPTION_MODEL, mode: env.CLAUDE_PLUGIN_OPTION_MODE, baseUrl: env.CLAUDE_PLUGIN_OPTION_BASE_URL, apiKey: env.CLAUDE_PLUGIN_OPTION_API_KEY };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}

/** Walk from cwd up to the git root (or home), nearest first. */
export function projectDirs(cwd, home = os.homedir()) {
  const dirs = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, ".git")) || dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Precedence (low → high): defaults < plugin options < user ~/.claude/watchdog.json < project
 * .claude/watchdog.json (farther ancestors first; endpoint/key/command keys ignored) < env.
 */
export function loadConfig(cwd, env = process.env) {
  const home = env.HOME || os.homedir();
  const layers = [fromPluginOptions(env), readJson(path.join(home, ".claude", "watchdog.json"))];
  for (const dir of projectDirs(cwd, home).reverse()) layers.push(untrusted(readJson(path.join(dir, ".claude", "watchdog.json"))));
  // Env is merged after plugin userConfig defaults only for keys it actually sets.
  const cfg = Object.assign({}, DEFAULTS, ...layers, fromEnv(env));
  if (!cfg.apiKey && cfg.apiKeyEnv) cfg.apiKey = env[cfg.apiKeyEnv];
  if (!["turn", "final"].includes(cfg.mode)) cfg.mode = DEFAULTS.mode;
  cfg.reviewInterval = Math.max(1, Math.floor(cfg.reviewInterval) || 1);
  cfg.maxNotesPerUpdate = Math.min(32, Math.max(1, Math.floor(cfg.maxNotesPerUpdate) || DEFAULTS.maxNotesPerUpdate));
  return cfg;
}

/**
 * WATCHDOG.md: advisor-only guidance (never injected into the main agent).
 * user ~/.claude/WATCHDOG.md, then project dirs from the git root down to cwd,
 * each as `<dir>/WATCHDOG.md` and `<dir>/.claude/WATCHDOG.md`. Narrower last.
 */
export function loadWatchdogNotes(cwd) {
  const files = [path.join(os.homedir(), ".claude", "WATCHDOG.md")];
  for (const dir of projectDirs(cwd).reverse()) {
    files.push(path.join(dir, "WATCHDOG.md"), path.join(dir, ".claude", "WATCHDOG.md"));
  }
  const seen = new Set();
  const blocks = [];
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    try {
      const text = fs.readFileSync(f, "utf8").trim();
      if (text) blocks.push(text);
    } catch {}
  }
  return blocks;
}

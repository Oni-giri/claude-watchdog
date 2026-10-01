import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  enabled: true,
  /** Model the advisor runs on. Stronger than the driver is the point. */
  model: "opus",
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
    model: env.WATCHDOG_MODEL || env.CLAUDE_PLUGIN_OPTION_MODEL,
    mode: env.WATCHDOG_MODE || env.CLAUDE_PLUGIN_OPTION_MODE,
    enabled: bool(env.WATCHDOG_ENABLED),
    reviewInterval: num(env.WATCHDOG_REVIEW_INTERVAL),
    minDeltaChars: num(env.WATCHDOG_MIN_DELTA_CHARS),
    minStopChars: num(env.WATCHDOG_MIN_STOP_CHARS),
    maxNotesPerUpdate: num(env.WATCHDOG_MAX_NOTES),
    timeoutMs: num(env.WATCHDOG_TIMEOUT_MS),
    stopWaitMs: num(env.WATCHDOG_STOP_WAIT_MS),
    tools: env.WATCHDOG_TOOLS,
    reviewerCommand: env.WATCHDOG_REVIEWER_CMD,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}

/** Walk from cwd up to the git root (or home), nearest first. */
export function projectDirs(cwd) {
  const dirs = [];
  const home = os.homedir();
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
 * Precedence (low → high): defaults < user ~/.claude/watchdog.json < project
 * .claude/watchdog.json (farther ancestors first) < env.
 */
export function loadConfig(cwd, env = process.env) {
  const layers = [readJson(path.join(os.homedir(), ".claude", "watchdog.json"))];
  for (const dir of projectDirs(cwd).reverse()) layers.push(readJson(path.join(dir, ".claude", "watchdog.json")));
  // Env is merged after plugin userConfig defaults only for keys it actually sets.
  const cfg = Object.assign({}, DEFAULTS, ...layers, fromEnv(env));
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, TRUSTED_ONLY, loadConfig } from "../lib/config.mjs";
import { callReviewer } from "../lib/reviewer.mjs";
import { Session, stateRoot } from "../lib/state.mjs";

const userFile = () => path.join(os.homedir(), ".claude", "watchdog.json");
const SECRET_KEYS = ["apiKey"]; // never accepted on a command line / through the chat
const EDITABLE = Object.keys(DEFAULTS).filter((k) => !SECRET_KEYS.includes(k));

const readUser = () => { try { return JSON.parse(fs.readFileSync(userFile(), "utf8")); } catch { return {}; } };
function writeUser(obj) {
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(userFile(), JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(userFile(), 0o600); // may hold an API key
}
const mask = (k) => (k ? `${String(k).slice(0, 3)}…${String(k).slice(-2)} (${String(k).length} chars)` : "(none)");
const backendOf = (cfg) =>
  cfg.reviewerCommand ? "custom command"
  : cfg.provider === "openai" || (cfg.provider !== "claude" && cfg.baseUrl) ? `openai-compatible @ ${cfg.baseUrl}`
  : "claude CLI";

function coerce(v) {
  try { return JSON.parse(v); } catch { return v; }
}

function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    stdin.on("data", function onData(ch) {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") buf = buf.slice(0, -1); else buf += c;
      }
    });
  });
}

/** `/watchdog` backend. Config commands need no session; control commands find this project's latest one. */
export async function ctl(argv) {
  const [cmd = "status", ...rest] = argv;

  // ---------- configuration (user-level file ~/.claude/watchdog.json) ----------
  if (cmd === "set") {
    const [key, ...vals] = rest;
    if (SECRET_KEYS.includes(key)) {
      console.log("Refusing: API keys must not be passed on the command line or through chat. Use `set apiKeyEnv NAME`, or run `set-key` in your own terminal.");
      process.exitCode = 1; return;
    }
    if (!EDITABLE.includes(key)) { console.log(`Unknown key "${key}". Known: ${EDITABLE.join(", ")}`); process.exitCode = 1; return; }
    const cur = readUser();
    cur[key] = coerce(vals.join(" "));
    writeUser(cur);
    console.log(`set ${key} = ${JSON.stringify(cur[key])}   (${userFile()})`);
    return;
  }
  if (cmd === "unset") {
    const cur = readUser();
    for (const k of rest) delete cur[k];
    writeUser(cur);
    console.log(`unset ${rest.join(", ")}`);
    return;
  }
  if (cmd === "set-key") {
    if (!process.stdin.isTTY) {
      console.log("set-key needs an interactive terminal (input is hidden). Run it yourself in a shell, not through Claude:\n  node \"" + path.resolve(import.meta.dirname, "watchdog.mjs") + "\" ctl set-key");
      process.exitCode = 1; return;
    }
    const key = (await promptHidden("API key (input hidden): ")).trim();
    if (!key) { console.log("empty key, nothing saved."); return; }
    const cur = readUser();
    cur.apiKey = key;
    writeUser(cur);
    console.log(`saved to ${userFile()} (mode 600).`);
    return;
  }
  if (cmd === "show") {
    const cfg = loadConfig(process.cwd());
    const shown = { ...cfg, apiKey: mask(cfg.apiKey) };
    console.log(`backend: ${backendOf(cfg)}\n${JSON.stringify(shown, null, 2)}\n\nuser file ${userFile()}: ${JSON.stringify({ ...readUser(), ...(readUser().apiKey ? { apiKey: mask(readUser().apiKey) } : {}) })}\n(${TRUSTED_ONLY.join(", ")} are only honored from the user file, plugin options and env)`);
    return;
  }
  if (cmd === "test") {
    const cfg = loadConfig(process.cwd());
    console.log(`testing ${backendOf(cfg)}, model ${cfg.model} …`);
    const t0 = Date.now();
    const r = await callReviewer({ cfg: { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 90000) }, cwd: process.cwd(), system: 'You are a connectivity test. Reply with exactly {"notes":[]}', prompt: "ping" });
    if (r.error) { console.log(`FAILED after ${Date.now() - t0}ms: ${r.error}`); process.exitCode = 1; }
    else console.log(`OK in ${Date.now() - t0}ms (${r.usage?.inputTokens ?? "?"} in / ${r.usage?.outputTokens ?? "?"} out tokens).`);
    return;
  }

  // ---------- session control ----------
  const root = stateRoot();
  const sid = Session.latest(root, process.cwd());
  const cfg = loadConfig(process.cwd());
  if (!sid) {
    console.log("watchdog: no session recorded for this directory yet (it starts recording on the first hook event).");
    return;
  }
  const session = new Session(sid, root);
  const st = session.load();

  switch (cmd) {
    case "on":
    case "off":
      await session.update((s) => { s.disabled = cmd === "off"; });
      console.log(`watchdog ${cmd} for this session.`);
      return;
    case "clear":
      await session.update((s) => { s.seen = {}; s.raised = []; });
      console.log("watchdog: dedupe history cleared; old issues can be re-raised.");
      return;
    case "dump": {
      const n = Number(rest[0]) || 10;
      let lines = [];
      try { lines = fs.readFileSync(session.file("log.jsonl"), "utf8").trim().split("\n").slice(-n); } catch {}
      console.log(lines.length ? lines.join("\n") : "watchdog: no reviews logged yet.");
      return;
    }
    case "status":
    default: {
      const pending = session.pending();
      const count = (s) => pending.filter((p) => p.severity === s).length;
      console.log([
        `watchdog: ${cfg.enabled && !st.disabled ? "ON" : "OFF"}${st.disabled ? " (disabled for this session)" : ""}`,
        `backend: ${backendOf(cfg)}`,
        `model: ${cfg.model}   mode: ${cfg.mode}   every ${cfg.reviewInterval} tool calls, min ${cfg.minDeltaChars} chars`,
        `reviews: ${st.usage.reviews}   cost: $${st.usage.costUsd.toFixed(4)}   tokens in/out: ${st.usage.inputTokens}/${st.usage.outputTokens}`,
        `pending notes: ${count("blocker")} blocker, ${count("concern")} concern, ${count("nit")} nit`,
        `agent idle: ${st.idle}   consecutive stop-blocks: ${st.stopBlocks}`,
        st.lastError ? `last error (${st.failures} consecutive): ${st.lastError}` : "last error: none",
        `state: ${session.dir}`,
      ].join("\n"));
    }
  }
}

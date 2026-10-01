import fs from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { Session, stateRoot } from "../lib/state.mjs";

/** `/watchdog` backend. Finds this project's latest session via the pointer SessionStart/any hook wrote. */
export async function ctl(argv) {
  const [cmd = "status", ...rest] = argv;
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

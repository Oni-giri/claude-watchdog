import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A per-session event feed for anything that wants to *show* the watchdog's
 * activity (the watchdog-ui mod polls it). Lives at a fixed, well-known path
 * because a mod can't know this plugin's CLAUDE_PLUGIN_DATA.
 */
export const feedDir = () => process.env.WATCHDOG_FEED_DIR || path.join(os.homedir(), ".claude", "watchdog", "feed");
const heartbeatFile = () => path.join(feedDir(), "..", "ui-heartbeat");
const safe = (s) => String(s).replace(/[^\w.-]/g, "_");

export function feed(sessionId, event) {
  try {
    fs.mkdirSync(feedDir(), { recursive: true });
    fs.appendFileSync(path.join(feedDir(), `${safe(sessionId)}.jsonl`), JSON.stringify({ ts: Date.now(), ...event }) + "\n");
  } catch {}
}

/** True while the UI mod is alive (it touches the heartbeat every few seconds). */
export function uiActive(maxAgeMs = 15000) {
  try { return Date.now() - fs.statSync(heartbeatFile()).mtimeMs < maxAgeMs; } catch { return false; }
}

/**
 * Record a delivery and return the one-line-per-note `systemMessage` to show the
 * person, or undefined when the UI mod already draws it (or showNotes is "never").
 */
export function delivered(session, cfg, via, notes) {
  for (const n of notes) feed(session.id, { kind: "note", event: "delivered", via, severity: n.severity, note: n.note });
  if (!notes.length || cfg.showNotes === "never" || (cfg.showNotes !== "always" && uiActive())) return undefined;
  return notes.map((n) => `Watchdog [${n.severity}] → agent: ${n.note.length > 300 ? n.note.slice(0, 300) + "…" : n.note}`).join("\n");
}

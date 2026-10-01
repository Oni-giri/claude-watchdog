import fs from "node:fs";

/**
 * Read complete JSONL lines appended after byte offset `cursor`.
 * A trailing partial line (the file is written asynchronously) is left for next time.
 * If the file shrank (rewritten), restart from 0 like omp's reset-on-rewrite.
 */
export function readDelta(file, cursor = 0) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { entries: [], nextCursor: cursor, reset: false }; }
  let reset = false;
  if (size < cursor) { cursor = 0; reset = true; }
  if (size === cursor) return { entries: [], nextCursor: cursor, reset };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - cursor);
    fs.readSync(fd, buf, 0, buf.length, cursor);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return { entries: [], nextCursor: cursor, reset };
    const entries = [];
    for (const line of buf.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries, nextCursor: cursor + lastNl + 1, reset };
  } finally {
    fs.closeSync(fd);
  }
}

const clip = (s, n) => {
  s = String(s ?? "");
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.6);
  return `${s.slice(0, head)}\n…[${s.length - n} chars elided]…\n${s.slice(s.length - (n - head))}`;
};

const stripReminders = (s) => String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
const isOwnAdvice = (s) => /<advisory\b[^>]*source="watchdog"/.test(s);

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  return JSON.stringify(content ?? "");
}

/** Genuine user prompts (not tool results / meta / sub-agent traffic) in a delta. */
export function userAsks(entries) {
  const asks = [];
  for (const e of entries) {
    if (e.type !== "user" || e.isSidechain || e.isMeta) continue;
    const c = e.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
    const clean = stripReminders(text);
    if (clean && !isOwnAdvice(clean)) asks.push(clean);
  }
  return asks;
}

/**
 * Render a delta as compact text for the advisor: reasoning, text, tool calls
 * (intent) and truncated results. Attachments, queue ops and our own advisories
 * are dropped so the advisor never reviews itself.
 */
export function renderDelta(entries, { toolInputMax = 1500, toolResultMax = 2000, maxChars = 60000 } = {}) {
  const lines = [];
  for (const e of entries) {
    if (e.isSidechain) continue;
    const c = e.message?.content;
    if (e.type === "user") {
      if (typeof c === "string") {
        const t = stripReminders(c);
        if (t && !isOwnAdvice(t) && !e.isMeta) lines.push(`[user]\n${clip(t, 4000)}`);
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result") {
            const t = toolResultText(b.content);
            if (isOwnAdvice(t)) continue;
            lines.push(`[tool result${b.is_error ? " (error)" : ""} ${b.tool_use_id ?? ""}]\n${clip(t, toolResultMax)}`);
          } else if (b.type === "text") {
            const t = stripReminders(b.text);
            if (t && !isOwnAdvice(t) && !e.isMeta) lines.push(`[user]\n${clip(t, 4000)}`);
          }
        }
      }
    } else if (e.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "thinking" && b.thinking) lines.push(`[assistant thinking]\n${clip(b.thinking, 3000)}`);
        else if (b.type === "text" && b.text) lines.push(`[assistant]\n${clip(b.text, 4000)}`);
        else if (b.type === "tool_use") lines.push(`[tool call ${b.name} ${b.id ?? ""}]\n${clip(JSON.stringify(b.input), toolInputMax)}`);
      }
    }
  }
  let out = lines.join("\n\n");
  if (out.length > maxChars) out = `…[earlier part of the update elided]…\n${out.slice(out.length - maxChars)}`;
  return out;
}

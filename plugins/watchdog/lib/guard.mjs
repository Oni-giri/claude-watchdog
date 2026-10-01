/**
 * Admission control for advisor notes. Prompts alone do not keep a reviewer
 * quiet, so the rules are enforced in code (same idea as omp's emission guard):
 * drop empty / content-free notes, drop repeats (unless escalated), and cap the
 * non-blocker notes per review. Blockers are exempt from the budget.
 */

const RANK = { nit: 1, concern: 2, blocker: 3 };
export const SEVERITIES = Object.keys(RANK);
export const rankOf = (s) => RANK[s] ?? 1;

export function normalizeNote(note) {
  return String(note ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const NOISE = new Set([
  "stop", "stop here", "stop now", "halt", "abort",
  "done", "task done", "task complete", "complete", "finished", "ok", "okay",
  "no issue", "no issues", "no issue continue", "no concerns", "no concern",
  "nothing to add", "nothing to flag", "nothing to report", "no notes",
  "no further input", "no further advice", "no further advice needed",
  "lgtm", "looks good", "all good", "agent is on track", "agent on track", "on track",
  "continue", "carry on",
]);

const HISTORY_CAP = 1024;

export class EmissionGuard {
  /** @param {Record<string, number>} seen normalized note → highest rank delivered (persisted by caller) */
  constructor(seen = {}, maxNonBlockers = 4) {
    this.seen = seen;
    this.max = maxNonBlockers;
    this.used = 0;
  }

  /** @returns {{accepted:true,key:string}|{accepted:false,reason:'empty'|'noise'|'duplicate'|'rate-limit'}} */
  admit(note, severity = "nit") {
    const key = normalizeNote(note);
    if (!key) return { accepted: false, reason: "empty" };
    if (NOISE.has(key)) return { accepted: false, reason: "noise" };
    const rank = rankOf(severity);
    const prev = this.seen[key];
    if (prev !== undefined && rank <= prev) return { accepted: false, reason: "duplicate" };
    if (rank < RANK.blocker && this.used >= this.max) return { accepted: false, reason: "rate-limit" };
    if (rank < RANK.blocker) this.used++;
    delete this.seen[key]; // refresh FIFO position
    this.seen[key] = rank;
    const keys = Object.keys(this.seen);
    for (let i = 0; i < keys.length - HISTORY_CAP; i++) delete this.seen[keys[i]];
    return { accepted: true, key };
  }
}

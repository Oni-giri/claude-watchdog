const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Agent-facing rendering: one <advisory> per note. The main agent's prompt never
 * mentions the watchdog, so `guidance` is its only cue to treat this as advice.
 */
export function formatAdvisories(notes) {
  return notes
    .map((n) => `<advisory source="watchdog" severity="${n.severity}" guidance="weigh, don't blindly obey">\n${esc(n.note)}\n</advisory>`)
    .join("\n");
}

export const ORDER = { blocker: 0, concern: 1, nit: 2 };
export const bySeverity = (a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3) || String(a.f).localeCompare(String(b.f));

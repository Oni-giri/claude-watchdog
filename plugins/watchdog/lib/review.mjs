import { loadWatchdogNotes } from "./config.mjs";
import { EmissionGuard } from "./guard.mjs";
import { buildPrompt, callReviewer, systemPrompt } from "./reviewer.mjs";
import { readDelta, renderDelta, userAsks } from "./transcript.mjs";

const MAX_FAILURES = 3; // then drop the backlog, like omp, so a broken reviewer can't wedge the session
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Cheap peek used to decide whether a mid-run review is worth its cost. */
export function peekDelta(session, transcriptPath, maxChars) {
  const st = session.load();
  const { entries } = readDelta(transcriptPath, st.cursor);
  return renderDelta(entries, { maxChars }).length;
}

/**
 * One review pass over the unseen transcript. The caller holds the review lock.
 * @returns {{notes: object[], error?: string, skipped?: boolean}} notes admitted into the inbox
 */
export async function runReview({ session, cfg, cwd, transcriptPath, final, lastAssistant }) {
  const st0 = session.load();
  const { entries, nextCursor } = readDelta(transcriptPath, st0.cursor);
  let delta = renderDelta(entries, { maxChars: cfg.maxDeltaChars });
  if (final && lastAssistant && !delta.includes(lastAssistant.slice(0, 80))) {
    delta += `${delta ? "\n\n" : ""}[assistant]\n${clip(lastAssistant, 4000)}`;
  }
  const newAsks = userAsks(entries).map((a) => clip(a, 2000));

  if (!delta.trim()) {
    await session.update((st) => { st.cursor = nextCursor; pinAsks(st, newAsks); });
    return { notes: [], skipped: true };
  }

  const asks = pinAsks({ asks: [...st0.asks] }, newAsks);
  const t0 = Date.now();
  const res = await callReviewer({
    cfg, cwd,
    system: systemPrompt(cfg, loadWatchdogNotes(cwd)),
    prompt: buildPrompt({ asks, raised: st0.raised, delta, final, cwd }),
  });
  const durationMs = Date.now() - t0;

  const admitted = await session.update((st) => {
    pinAsks(st, newAsks);
    if (res.usage) {
      st.usage.costUsd += res.usage.costUsd;
      st.usage.inputTokens += res.usage.inputTokens;
      st.usage.outputTokens += res.usage.outputTokens;
    }
    if (res.error) {
      st.lastError = res.error;
      if (++st.failures >= MAX_FAILURES) { st.cursor = nextCursor; st.failures = 0; }
      return [];
    }
    st.failures = 0;
    st.lastError = null;
    st.cursor = nextCursor;
    st.toolCalls = 0;
    st.lastReviewAt = Date.now();
    st.usage.reviews++;
    const guard = new EmissionGuard(st.seen, cfg.maxNotesPerUpdate);
    const out = [];
    for (const n of res.notes) {
      if (!guard.admit(n.note, n.severity).accepted) continue;
      const note = { severity: n.severity, note: n.note, final: !!final, ts: Date.now() };
      session.push(note);
      st.raised.push({ severity: n.severity, note: clip(n.note, 300) });
      out.push(note);
    }
    st.raised = st.raised.slice(-20);
    return out;
  });

  session.log({ kind: "review", final: !!final, deltaChars: delta.length, durationMs, error: res.error, usage: res.usage, notes: res.notes, admitted: admitted.length });
  return { notes: admitted, error: res.error };
}

/** Keep the first ask (the original request) plus the most recent ones. */
function pinAsks(st, newAsks) {
  const all = [...(st.asks ?? []), ...newAsks];
  st.asks = all.length > 5 ? [all[0], ...all.slice(-4)] : all;
  return st.asks;
}

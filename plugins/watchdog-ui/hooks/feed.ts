import type { Severity, Summary } from '../types'

/** One line of ~/.claude/watchdog/feed/<session>.jsonl, written by the watchdog plugin's hooks. */
export type FeedEvent =
  | { kind: 'note'; event: 'queued' | 'delivered'; severity: Severity; note: string; via?: string; ts: number }
  | { kind: 'review'; reviews: number; costUsd: number; model?: string; error?: string; admitted: number; ts: number }

export const emptySummary = (): Summary => ({
  reviews: 0,
  costUsd: 0,
  model: null,
  pending: { nit: 0, concern: 0, blocker: 0 },
  last: null,
  error: null,
})

export function parseLines(text: string): FeedEvent[] {
  const out: FeedEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as FeedEvent)
    } catch {
      /* a partial last line: picked up next poll */
    }
  }
  return out
}

/** Fold events into the summary; returns the notes that were just delivered (each becomes a card). */
export function apply(summary: Summary, events: FeedEvent[]): { summary: Summary; deliveredNow: Extract<FeedEvent, { kind: 'note' }>[] } {
  const s: Summary = { ...summary, pending: { ...summary.pending } }
  const deliveredNow: Extract<FeedEvent, { kind: 'note' }>[] = []
  for (const ev of events) {
    if (ev.kind === 'review') {
      s.reviews = ev.reviews
      s.costUsd = ev.costUsd
      s.model = ev.model ?? s.model
      s.error = ev.error ?? null
    } else if (ev.kind === 'note' && ev.event === 'queued') {
      s.pending[ev.severity] += 1
    } else if (ev.kind === 'note' && ev.event === 'delivered') {
      s.pending[ev.severity] = Math.max(0, s.pending[ev.severity] - 1)
      s.last = { severity: ev.severity, note: ev.note, via: ev.via ?? '', ts: ev.ts }
      deliveredNow.push(ev)
    }
  }
  return { summary: s, deliveredNow }
}

const VIA: Record<string, string> = {
  pretool: 'before its next tool call',
  deliver: 'after a tool call',
  prompt: 'with your prompt',
  stop: 'stop blocked',
  rewake: 'woke the agent',
}

/** The transcript card's text (a notice: you see it, the model never reads it). */
export function cardText(ev: { severity: Severity; note: string; via?: string }): string {
  const mark = ev.severity === 'blocker' ? '■' : ev.severity === 'concern' ? '▲' : '·'
  return `${mark} Watchdog ${ev.severity} — ${VIA[ev.via ?? ''] ?? 'delivered'}\n${ev.note}`
}

export const severityColor = (s: Severity): string | undefined =>
  s === 'blocker' ? 'red' : s === 'concern' ? 'yellow' : undefined

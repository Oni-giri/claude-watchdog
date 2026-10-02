import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Summary } from '../types'
import { apply, cardText, emptySummary, parseLines, severityColor } from './feed'

const summary = atom({ plugin: 'watchdog-ui', key: 'summary' } as const, null as Summary | null)
const offset = atom({ plugin: 'watchdog-ui', key: 'offset' } as const, -1)
const hidden = atom({ plugin: 'watchdog-ui', key: 'hidden' } as const, false)

const POLL_MS = 1000
const HEARTBEAT_MS = 5000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    if (!home) return next(e)
    const sid = await $.session.id()
    const dir = `${home}/.claude/watchdog`
    const feedPath = `${dir}/feed/${sid}.jsonl`

    // Tells the watchdog hooks we're drawing, so they skip their plain-text line.
    const beat = () => void $.fs.write(`${dir}/ui-heartbeat`, String(Date.now())).catch(() => {})
    beat()
    $.clock.every(HEARTBEAT_MS, beat)

    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        if (!(await $.fs.exists(feedPath))) return
        const events = parseLines(await $.fs.read(feedPath))
        const seen = await read($, offset)
        // First sight (fresh load or resumed session): fold history silently, draw no old cards.
        const fresh = events.slice(seen < 0 ? events.length : seen)
        if (seen < 0) {
          const { summary: s } = apply(emptySummary(), events)
          await update($, summary, () => (events.length ? s : null))
          await update($, offset, () => events.length)
          return
        }
        if (!fresh.length) return
        await update($, offset, () => seen + fresh.length)
        const { summary: s, deliveredNow } = apply((await read($, summary)) ?? emptySummary(), fresh)
        await update($, summary, () => s)
        for (const ev of fresh) {
          if (ev.kind === 'note' && ev.event === 'queued' && ev.severity === 'blocker') {
            $.ui.toast(`Watchdog blocker: ${ev.note.slice(0, 120)}`, { timeoutMs: 8000 })
          }
        }
        for (const ev of deliveredNow) {
          // A transcript card: a notice row you see and the model never reads.
          // Each on its own, so one refused append doesn't lose the others.
          await $.session
            .append({ message: { type: 'system', content: [{ type: 'text', text: cardText(ev) }] } })
            .catch(() => $.ui.toast(cardText(ev).slice(0, 200), { timeoutMs: 8000 }))
        }
      } catch {
        /* the feed is best effort; next poll retries */
      } finally {
        busy = false
      }
    }
    $.clock.every(POLL_MS, () => void poll())

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, summary)
    if (e.props.hasSurvey || !s || (await read($, hidden))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const room = Math.max(20, e.props.bodyColumns - 60)
    const p = s.pending
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>watchdog{s.model ? ` (${s.model})` : ''} · {s.reviews} review{s.reviews === 1 ? '' : 's'}{s.costUsd > 0 ? ` · $${s.costUsd.toFixed(3)}` : ''} · </Text>
          {p.blocker > 0 && <Text color="red" bold>{p.blocker} blocker </Text>}
          {p.concern > 0 && <Text color="yellow">{p.concern} concern </Text>}
          {p.nit > 0 && <Text dimColor>{p.nit} nit </Text>}
          {p.blocker + p.concern + p.nit === 0 && <Text dimColor>nothing pending </Text>}
          <Button key="hide" plain label="hide" onPress={() => update($, hidden, () => true)} />
        </Box>
        {s.last && (
          <Text wrap="truncate-end" dimColor={s.last.severity === 'nit'} color={severityColor(s.last.severity)}>
            last [{s.last.severity}]: {s.last.note.replace(/\s+/g, ' ').slice(0, room)}
          </Text>
        )}
        {s.error && <Text color="red" wrap="truncate-end">reviewer error: {s.error.slice(0, room)}</Text>}
      </Box>
    )
  })
}

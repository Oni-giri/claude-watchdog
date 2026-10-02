import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const FEED = '/h/.claude/watchdog/feed/sid.jsonl'
const line = (o: object) => JSON.stringify({ ts: 1, ...o }) + '\n'

/** The world beneath the mod: a file system in memory, a session id, and what got appended/toasted. */
function world(on: On) {
  const files = new Map<string, string>()
  const toasts: string[] = []
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid' }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { files, toasts, clock }
}

const band = ($: Engine) =>
  $.ui.mount({
    plugin: 'watchdog-ui',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })

test('history is folded silently; new deliveries become transcript cards; blockers toast; the band summarises', async ($, on) => {
  const w = world(on)
  // Earlier in the session (e.g. before a reload): one review, one note queued and delivered.
  w.files.set(FEED, line({ kind: 'note', event: 'queued', severity: 'nit', note: 'old' }) + line({ kind: 'note', event: 'delivered', via: 'deliver', severity: 'nit', note: 'old' }) + line({ kind: 'review', reviews: 1, costUsd: 0.02, model: 'opus', admitted: 1 }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
  expect(w.toasts).toEqual([]) // no replay of old notes
  expect(w.files.has('/h/.claude/watchdog/ui-heartbeat')).toBe(true)

  // A new review queues a concern and a blocker; the concern is delivered before the next tool call.
  w.files.set(FEED, w.files.get(FEED)! +
    line({ kind: 'review', reviews: 2, costUsd: 0.05, model: 'opus', admitted: 2 }) +
    line({ kind: 'note', event: 'queued', severity: 'concern', note: 'Wrong code path: the handler lives in api/v2.' }) +
    line({ kind: 'note', event: 'queued', severity: 'blocker', note: 'Tests were never run.' }) +
    line({ kind: 'note', event: 'delivered', via: 'pretool', severity: 'concern', note: 'Wrong code path: the handler lives in api/v2.' }))
  await w.clock.advance(1000)

  // The blocker toasts when queued. The kit can't serve session.append (it answers "no
  // implementation" even with a hook on it), so the card's text arrives via the fallback toast.
  expect(w.toasts.some(t => t.startsWith('Watchdog blocker: Tests were never run'))).toBe(true)
  const card = w.toasts.find(t => t.includes('Watchdog concern — before its next tool call'))
  expect(card).toContain('api/v2')

  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /2 reviews/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /1 blocker/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /last \[concern\]: Wrong code path/ }))).toBeDefined()

  // Same lines are never carded twice.
  const before = w.toasts.length
  await w.clock.advance(3000)
  expect(w.toasts.length).toBe(before)
})

test('the band hides on press and stays out of the way before any activity', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await w.clock.advance(1000)
  const empty = await band($)
  expect(await empty.find({ type: 'Text', text: /watchdog/ })).toBeUndefined()

  w.files.set(FEED, line({ kind: 'review', reviews: 1, costUsd: 0, admitted: 0 }))
  await w.clock.advance(1000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /1 review/ })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /1 review/ })).toBeUndefined()
})

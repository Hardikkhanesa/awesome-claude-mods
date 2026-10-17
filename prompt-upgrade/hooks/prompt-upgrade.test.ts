import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  answerLines,
  bigNumber,
  parseQuestions,
  parseRewrite,
  routePrompt,
} from './prompt-upgrade-logic'

const QUESTIONS_REPLY = JSON.stringify({
  questions: [
    { question: 'Who is it for?', options: ['Customers', 'My team'] },
    { question: 'How long?', options: ['Short', 'Medium', 'Long'] },
  ],
})

const REWRITE_REPLY = JSON.stringify({
  prompt: 'Write a short welcome email for my customers, friendly in tone, ending with a clear next step.',
  added: ['Audience: customers', 'Length: short'],
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const PANE = {
  component: 'Pane' as const,
  requestId: 'prompt-upgrade',
  props: {
    title: 'Prompt upgrade',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { first: 0, last: 0, of: 0, bodyRows: 20 },
  },
}

type Sent = { text: string; originKind: string }

// Answers what the engine would, beneath the plugin, and records what the mod sends.
function answerEngine(on: On, options: { isPlaced?: boolean; failModel?: boolean } = {}) {
  const sent: Sent[] = []
  const filled: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: options.isPlaced !== false } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, originKind: e.origin?.kind ?? 'none' })
    return { text: e.text } as never
  })
  on('model.complete', ($, e) => {
    if (options.failModel) return { value: { isAnswered: false, reason: 'api-error', usage: USAGE } } as never
    const isRewrite = e.prompt.includes('Answers:')
    return { value: { isAnswered: true, text: isRewrite ? REWRITE_REPLY : QUESTIONS_REPLY, usage: USAGE } } as never
  })
  return { sent, filled, toasts, clock }
}

async function mountPane($: Engine) {
  return $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', ...PANE } as never)
}

describe('which prompts are intercepted', () => {
  const base = { originKind: 'composer', hasAttachments: false }

  test('a plain rough prompt is intercepted', () => {
    expect(routePrompt({ ...base, text: 'write me a welcome email' })).toEqual({
      route: 'intercept',
      text: 'write me a welcome email',
    })
  })

  test('slash commands, attachments, messages sent while working and short replies pass through', () => {
    expect(routePrompt({ ...base, text: '/compact' }).route).toBe('pass')
    expect(routePrompt({ ...base, text: 'look at this', hasAttachments: true }).route).toBe('pass')
    expect(routePrompt({ ...base, text: 'also add a footer', turnId: 'turn-1' }).route).toBe('pass')
    expect(routePrompt({ ...base, text: 'also add a footer', wait: true }).route).toBe('pass')
    expect(routePrompt({ ...base, text: 'yes' }).route).toBe('pass')
    expect(routePrompt({ ...base, text: 'Keep going.' }).route).toBe('pass')
  })

  test('a prompt starting with > is sent with the > removed', () => {
    expect(routePrompt({ ...base, text: '> just send this' })).toEqual({ route: 'strip', text: 'just send this' })
  })

  test('a prompt from the plugin or another source never comes back into the pane', () => {
    expect(routePrompt({ ...base, originKind: 'plugin', text: 'write me a welcome email' }).route).toBe('pass')
    expect(routePrompt({ ...base, originKind: 'sdk', text: 'write me a welcome email' }).route).toBe('pass')
  })
})

describe('reading the model replies', () => {
  test('reads up to three questions with two to four options each', () => {
    const questions = parseQuestions(QUESTIONS_REPLY)
    expect(questions.map(q => q.options.length)).toEqual([2, 3])
    expect(questions[0]?.id).toBe('q1')

    const many = JSON.stringify({
      questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, options: ['a', 'b', 'c', 'd', 'e'] })),
    })
    const parsed = parseQuestions(many)
    expect(parsed.length).toBe(3)
    expect(parsed[0]?.options.length).toBe(4)
  })

  test('drops questions that have fewer than two options and survives bad text', () => {
    expect(parseQuestions('{"questions":[{"question":"Why?","options":["only one"]}]}')).toEqual([])
    expect(parseQuestions('not json at all')).toEqual([])
    expect(parseQuestions('')).toEqual([])
  })

  test('reads the rewrite and what was added, even inside surrounding words', () => {
    const rewrite = parseRewrite(`Here you go: ${REWRITE_REPLY} Hope that helps.`)
    expect(rewrite?.prompt.startsWith('Write a short welcome email')).toBe(true)
    expect(rewrite?.added).toEqual(['Audience: customers', 'Length: short'])
    expect(parseRewrite('{"prompt":""}')).toBeNull()
    expect(parseRewrite('nothing')).toBeNull()
  })

  test('skipped questions are left out of the answers', () => {
    const questions = parseQuestions(QUESTIONS_REPLY)
    const lines = answerLines(questions, {
      q1: { kind: 'option', value: 'Customers' },
      q2: { kind: 'skip' },
    })
    expect(lines).toEqual(['Who is it for? Customers'])
  })

  test('big numbers are three rows tall', () => {
    expect(bigNumber(12).length).toBe(3)
    expect(bigNumber(0)[0]).toBe('┏━┓')
  })
})

test('the full flow: /better, questions, rewrite, review, Run', async ($, on) => {
  const engine = answerEngine(on)
  const reply = await $.command.run({ command: 'better', args: 'write a welcome email' } as never)
  expect(reply.text).toMatch(/review pane/)
  await engine.clock.settle()

  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /Who is it for\?/ })).toBeDefined()
  await pane.press({ key: 'q1-o0' })
  await pane.press({ key: 'q2-skip' })
  expect(await pane.find({ type: 'Text', text: /2 of 2 answered/ })).toBeDefined()
  await pane.press({ key: 'proceed' })
  await engine.clock.settle()

  expect(await pane.find({ type: 'Button', key: 'run' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Write a short welcome email/ })).toBeDefined()
  await pane.press({ key: 'run' })
  await engine.clock.settle()
  await pane.unmount()

  expect(engine.sent.length).toBe(1)
  expect(engine.sent[0]?.text).toMatch(/^Write a short welcome email/)
  // The mod sent it itself, so the prompt hook saw a plugin and let it through.
  expect(engine.sent[0]?.originKind).toBe('plugin')
})

test('Cancel closes the pane and puts the original prompt back', async ($, on) => {
  const engine = answerEngine(on)
  await $.command.run({ command: 'better', args: 'write a welcome email' } as never)
  await engine.clock.settle()

  const pane = await mountPane($)
  await pane.press({ key: 'cancel' })
  await engine.clock.settle()
  await pane.unmount()

  expect(engine.filled).toEqual(['write a welcome email'])
  expect(engine.sent.length).toBe(0)
})

test('a failed model call shows a calm error card with the way out', async ($, on) => {
  const engine = answerEngine(on, { failModel: true })
  await $.command.run({ command: 'better', args: 'write a welcome email' } as never)
  await engine.clock.settle()

  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /Your prompt is safe/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'retry' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'send-original' })).toBeDefined()
  await pane.press({ key: 'send-original' })
  await engine.clock.settle()
  await pane.unmount()

  expect(engine.sent[0]?.text).toBe('write a welcome email')
})

test('a window too narrow for the pane puts the words back with one line of explanation', async ($, on) => {
  const engine = answerEngine(on, { isPlaced: false })
  await $.command.run({ command: 'better', args: 'write a welcome email' } as never)
  await engine.clock.settle()

  expect(engine.filled).toEqual(['write a welcome email'])
  expect(engine.toasts.length).toBe(1)
  expect(engine.toasts[0]).toMatch(/too narrow/)
})

test('the on and off switch decides whether typed prompts go to the pane', async ($, on) => {
  const engine = answerEngine(on)
  const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

  // Off at the start: a typed prompt goes straight through.
  const off = await $.prompt.submit(typed('write a welcome email'))
  expect(off.text).toBe('write a welcome email')
  expect(engine.sent.length).toBe(1)

  const turnedOn = await $.command.run({ command: 'better', args: 'on' } as never)
  expect(turnedOn.text).toMatch(/on/)

  // On: the typed prompt is held back and the pane takes it; nothing is sent.
  const held = await $.prompt.submit(typed('write another email'))
  expect(held.drop).toBeDefined()
  await engine.clock.settle()
  expect(engine.sent.length).toBe(1)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /write another email/ })).toBeDefined()
  await pane.unmount()

  // On: a short reply still goes straight through.
  const reply = await $.prompt.submit(typed('yes'))
  expect(reply.text).toBe('yes')

  const turnedOff = await $.command.run({ command: 'better', args: 'off' } as never)
  expect(turnedOff.text).toMatch(/off/)
  const again = await $.prompt.submit(typed('write a third email'))
  expect(again.text).toBe('write a third email')
})

test('history lists the upgrades and reopens one for review', async ($, on) => {
  const engine = answerEngine(on)
  await $.command.run({ command: 'better', args: 'write a welcome email' } as never)
  await engine.clock.settle()
  const pane = await mountPane($)
  await pane.press({ key: 'proceed' })
  await engine.clock.settle()
  await pane.press({ key: 'cancel' })
  await engine.clock.settle()
  await pane.unmount()

  const listed = await $.command.run({ command: 'better', args: 'history' } as never)
  expect(listed.text).toMatch(/^1\. write a welcome email/)
  await engine.clock.settle()

  const history = await mountPane($)
  await history.press({ key: 'hist-0' })
  expect(await history.find({ type: 'Button', key: 'run' })).toBeDefined()
  await history.unmount()
})

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// The widest line a row of Text draws: a row's pieces added up, or a lone Text in a column.
// Bordered cards are skipped, since a card wraps its text on purpose.
function widestRow(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0
  const { type, props = {}, children = [] } = node as Node
  if (type !== 'Box' || props.borderStyle !== undefined) return 0
  const pieces = children.filter((c): c is Node => typeof c === 'object' && c !== null)
  const textOf = (n: Node) => (n.children ?? []).filter((x): x is string => typeof x === 'string').join('')
  const texts = pieces.filter(p => p.type === 'Text')
  let widest = 0
  if (texts.length > 0) {
    widest = props.flexDirection === 'row'
      ? texts.reduce((sum, t) => sum + textOf(t).length, 0)
      : Math.max(...texts.map(t => textOf(t).length))
  }
  return Math.max(widest, ...pieces.map(widestRow))
}

test('every row fits the pane at a narrow width and a wide one', async ($, on) => {
  const engine = answerEngine(on)
  await $.command.run({ command: 'better', args: 'write a welcome email for my shop' } as never)
  await engine.clock.settle()
  const first = await mountPane($)
  await first.press({ key: 'q1-o0' })
  await first.press({ key: 'proceed' })
  await engine.clock.settle()
  await first.unmount()

  for (const columns of [40, 60, 120]) {
    const pane = await $.ui.mount({
      plugin: 'prompt-upgrade',
      surface: 'terminal',
      ...PANE,
      props: { ...PANE.props, bodyColumns: columns },
    } as never)
    expect(widestRow(await pane.drawn())).toBeLessThanOrEqual(columns)
    await pane.unmount()
  }
})

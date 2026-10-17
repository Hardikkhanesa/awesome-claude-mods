import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { applyPlan, applyProgress, cleanName, meter, placeholderJob } from './clean-view-logic'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { first: 0, last: 0, of: 0, bodyRows: 12 } as never,
    view: {} as never,
  },
}

// Answers the built-in tools the tests call, beneath the plugin, so the plugin's
// own hooks decide what the tests see.
function answerBuiltins(on: On) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('classic.Notification', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', () => ({ type: 'Box', props: {} }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { todos: [] } }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok' } }) as never)
}

// Opens a job the way a real prompt does: prompt.submit, then the turn starts.
async function startJob($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text, turnId: `turn-${text.length}` } as never)
}

describe('plain names', () => {
  test('a path disappears from the middle of a sentence', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  })

  test('a long name trims to 40 characters or fewer, at a word boundary', () => {
    const name = cleanName('Build the whole pricing section with three plans and a comparison table for buyers')
    expect(name.length).toBeLessThanOrEqual(40)
    expect(name.endsWith('…')).toBe(true)
  })

  test('a name with nothing left becomes Working on it', () => {
    expect(cleanName('   `src/index.ts`   ')).toBe('Working on it')
  })

  test('the meter is always ten cells', () => {
    expect(meter(60, 0)).toBe('██████░░░░')
    expect(meter(null, 0).length).toBe(10)
  })
})

describe('checklist', () => {
  test('report_progress at 100 checks off step one and starts step two', () => {
    const planned = applyPlan(placeholderJob(0), ['Read your brand notes', 'Build the pricing section', 'Add the contact form'])
    const after = applyProgress(planned, 'Read your brand notes', 100)

    expect(after.tasks[0]?.status).toBe('done')
    expect(after.tasks[1]?.status).toBe('active')
    expect(after.tasks[2]?.status).toBe('upcoming')
  })

  test('a name not in the plan becomes a new step', () => {
    const planned = applyPlan(placeholderJob(0), ['Read your brand notes', 'Add the contact form'])
    const after = applyProgress(planned, 'Check the footer links', 30)

    expect(after.tasks.map(task => task.name)).toEqual([
      'Read your brand notes',
      'Check the footer links',
      'Add the contact form',
    ])
    expect(after.tasks[1]?.percent).toBe(30)
  })

  test('percent is clamped to 0 to 100', () => {
    const planned = applyPlan(placeholderJob(0), ['Read your brand notes', 'Add the contact form'])
    expect(applyProgress(planned, 'Read your brand notes', 250).tasks[0]?.status).toBe('done')
    expect(applyProgress(planned, 'Read your brand notes', -5).tasks[0]?.percent).toBe(0)
  })
})

test('a to-do list and a 60% report draw the checked, current, next and up-next rows on both surfaces', async ($, on) => {
  answerBuiltins(on)
  await startJob($, 'Build my landing page')
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  } as never)
  await $.tool.call({ tool: 'mcp__clean-view__report_progress', task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'clean-view', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Next/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Up next/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt turns the header into Needs you', async ($, on) => {
  answerBuiltins(on)
  await startJob($, 'Build my landing page')
  await $.classic.Notification({
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'clean-view', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/simple off hides the checklist and the tool rows', async ($, on) => {
  answerBuiltins(on)
  await startJob($, 'Build my landing page')
  await $.command.run({ command: 'simple', args: 'off' } as never)

  const band = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...BAND } as never)
  expect(await band.find({ type: 'Text', text: /Up next|Working/ })).toBeUndefined()
  await band.unmount()

  await $.command.run({ command: 'simple', args: 'on' } as never)
  const shown = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...BAND } as never)
  expect(await shown.find({ type: 'Text', text: /Working|Up next|Next/ })).toBeDefined()
  await shown.unmount()
})

test('every tool is denied before a plan exists and allowed after', async ($, on) => {
  answerBuiltins(on)
  await startJob($, 'Build my landing page')

  const held = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(held.deny).toMatch(/plan_steps/)

  await $.tool.call({
    tool: 'mcp__clean-view__plan_steps',
    steps: ['Read your brand notes', 'Add the contact form'],
  } as never)
  const allowed = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(allowed.deny).toBeUndefined()
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  answerBuiltins(on)
  await startJob($, 'Build my landing page')
  await $.tool.call({
    tool: 'mcp__clean-view__plan_steps',
    steps: ['Read your brand notes', 'Build the pricing section'],
  } as never)
  await $.tool.call({ tool: 'mcp__clean-view__report_progress', task: 'Read your brand notes', percent: 100 } as never)

  const band = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...BAND } as never)
  expect(await band.find({ type: 'Text', text: /✓/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Build the pricing section/ })).toBeDefined()
  await band.unmount()
})

test('tool rows are hidden while Clean View is on and drawn again when it is off', async ($, on) => {
  answerBuiltins(on)
  const row = { component: 'ToolUse' as const, requestId: 'call-1', props: { tool_use_id: 'call-1', tool: 'Bash', input: { command: 'ls' } } }

  const shown = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...row } as never)
  expect(JSON.stringify(await shown.drawn())).toContain('"display":"none"')
  await shown.unmount()

  await $.command.run({ command: 'simple', args: 'off' } as never)
  const back = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', ...row } as never)
  expect(JSON.stringify(await back.drawn())).not.toContain('"display":"none"')
  await back.unmount()
})

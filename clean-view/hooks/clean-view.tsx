import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Checklist, Task } from '../types'
import {
  applyPlan,
  applyProgress,
  applyTodos,
  appendTask,
  clampPercent,
  cleanName,
  completeActive,
  elapsed,
  fit,
  meter,
  padTo,
  placeholderJob,
  unfinishedCount,
} from './clean-view-logic'

const TOOL_PLAN = 'mcp__clean-view__plan_steps'
const TOOL_PROGRESS = 'mcp__clean-view__report_progress'
const FRAME_MS = 250
const COLLAPSE_MS = 5000

// Tools the model may use before a plan exists.
const ALWAYS_ALLOWED = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  TOOL_PLAN,
  TOOL_PROGRESS,
])

const enabled = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, null as Checklist | null)
const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const PLAN_RULES = [
  'Clean View is on. The person sees a simple checklist above the prompt instead of your tool steps.',
  '- Before any other tool, call plan_steps with 2 to 8 steps in order. If it is deferred, load it with ToolSearch first.',
  '- Write every step name in plain English that a non-technical person understands. Keep each under 40 characters and start it with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  '- As real progress happens, call report_progress with the step name and a percent from 0 to 100. Report 100 the moment a step finishes.',
  '- If the session has TodoWrite or TaskCreate, you may use its to-do list as the plan instead.',
].join('\n')

// Turns a turn's API error into one calm sentence for the band.
function apiErrorSentence(error: { kind?: string; details?: string } | null): string {
  const kind = error?.kind ?? ''
  const details = (error?.details ?? '').toLowerCase()
  if (kind === 'rate_limit') return 'you hit your usage limit, try again a little later'
  if (kind === 'overloaded') return "Claude's servers are busy, try again in a minute"
  if (kind.startsWith('authentication') || kind === 'oauth_org_not_allowed') return 'type /login'
  if (details.includes('context') || details.includes('too long')) return 'type /compact and try again'
  if (/network|econn|socket|timed? ?out|fetch failed|offline/.test(details)) return 'the internet connection dropped'
  return 'Claude hit a problem, try again in a moment'
}

// The header's words for a job, given the current time.
function headerFor(c: Checklist | null, now: number): { badge: string | null; text: string; isWarning: boolean } {
  if (!c) return { badge: null, text: 'Ready when you send a request', isWarning: false }
  switch (c.phase) {
    case 'working':
      return { badge: null, text: `${c.title} · ${elapsed(now - c.startedAt)}`, isWarning: false }
    case 'needs-you':
      return { badge: 'Needs you', text: c.needsYouReason ?? 'Claude is waiting for you', isWarning: false }
    case 'stuck':
      return { badge: null, text: `⚠ Stuck: ${c.stuckReason ?? 'Claude paused'}`, isWarning: true }
    case 'stopped':
      return { badge: null, text: `■ Stopped · ${c.title} · you pressed Esc`, isWarning: false }
    case 'done': {
      const took = elapsed((c.finishedAt ?? now) - c.startedAt)
      return { badge: null, text: `✓ All done · ${c.title} · took ${took}`, isWarning: false }
    }
    default:
      return { badge: null, text: 'Ready when you send a request', isWarning: false }
  }
}

// Control-flow state. It is rebuilt on a reload; the checklist itself lives in $.state.
let isRunning = false
let startNewJob = false
let jobSeq = 0
let failStreak = 0
let lastApiError: { kind?: string; details?: string } | null = null
let ticker: { cancel: () => void } | null = null
let collapser: { cancel: () => void } | null = null

// The frame clock runs only while a job is working or waiting on the person.
function syncTicker($: EngineInterface, c: Checklist | null) {
  const wantsFrames = c !== null && (c.phase === 'working' || c.phase === 'needs-you')
  if (wantsFrames && ticker === null) {
    ticker = $.clock.every(FRAME_MS, () => {
      update($, tick, n => n + 1).catch(() => {})
    })
  } else if (!wantsFrames && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

async function commit($: EngineInterface, change: (c: Checklist) => Checklist) {
  await update($, checklist, c => (c ? change(c) : c))
  syncTicker($, await read($, checklist))
}

async function ensureWorking($: EngineInterface) {
  const c = await read($, checklist)
  if (c && (c.phase === 'working' || c.phase === 'needs-you')) return
  const now = await $.clock.now()
  await update($, checklist, () => placeholderJob(now))
  syncTicker($, await read($, checklist))
}

async function setEnabled($: EngineInterface, isOn: boolean) {
  await update($, enabled, () => isOn)
  if (isOn) {
    syncTicker($, await read($, checklist))
  } else if (ticker !== null) {
    ticker.cancel()
    ticker = null
  }
  await $.store.set('enabled', isOn)
  $.ui.toast(isOn ? 'Clean View is on' : 'Clean View is off')
}

// Names the job in the background. An answer that arrives after a newer job started is ignored.
function nameJob($: EngineInterface, text: string, seq: number, startedAt: number) {
  $.model
    .complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 24,
      timeoutMs: 20000,
      prompt: `Name this job in 2 to 6 plain words that start with a verb, for someone who is not technical. Reply with the name only.\n\nRequest: ${text.slice(0, 600)}`,
    })
    .then(async reply => {
      if (!reply.isAnswered || seq !== jobSeq) return
      const name = cleanName(reply.text.replace(/^["'`*\s]+|["'`*.\s]+$/g, ''))
      await update($, checklist, c => (c && c.startedAt === startedAt ? { ...c, title: name } : c))
    })
    .catch(() => {})
}

async function startJob($: EngineInterface, text: string) {
  jobSeq += 1
  failStreak = 0
  collapser?.cancel()
  collapser = null
  const startedAt = await $.clock.now()
  await update($, checklist, () => placeholderJob(startedAt))
  syncTicker($, await read($, checklist))
  nameJob($, text, jobSeq, startedAt)
}

export function registerCleanView(on: On) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'simple',
      description: 'Turn the calm Clean View checklist on or off',
      argumentHint: 'on|off',
    })
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the current job before doing anything else. Pass 2 to 8 short plain-English step names in order. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 },
        },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step as a percent from 0 to 100. Report 100 when the step is finished.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          percent: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['task', 'percent'],
      },
    })
    const saved = await $.store.get('enabled')
    await update($, enabled, () => saved !== false)

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const current = await read($, enabled)
    const isOn = word === 'on' ? true : word === 'off' ? false : !current
    await setEnabled($, isOn)

    return { text: `Clean View is ${isOn ? 'on' : 'off'}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!(await read($, enabled))) return result

    return {
      sections: [...result.sections, { id: 'clean-view:plan', text: PLAN_RULES, scope: 'session' as const }],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isRunning && !e.text.trim().startsWith('/')) startNewJob = true

    const c = await read($, checklist)
    if (c?.phase === 'needs-you') {
      await commit($, x => ({ ...x, phase: 'working', needsYouReason: null }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isRunning = true
    if (startNewJob) {
      startNewJob = false
      await startJob($, e.text)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isRunning = false
    const apiError = lastApiError
    lastApiError = null

    const now = await $.clock.now()
    if (e.reason === 'aborted') {
      await commit($, x => ({ ...x, phase: 'stopped', needsYouReason: null }))
    } else if (e.reason === 'refusal') {
      await commit($, x => ({ ...x, phase: 'stuck', stuckReason: "Claude couldn't help with that request" }))
    } else if (e.reason === 'error') {
      await commit($, x => ({ ...x, phase: 'stuck', stuckReason: apiErrorSentence(apiError) }))
    } else {
      await commit($, x =>
        unfinishedCount(x) > 0
          ? { ...x, phase: 'needs-you', needsYouReason: 'Claude is waiting for your reply' }
          : { ...x, phase: 'done', needsYouReason: null, stuckReason: null, finishedAt: now },
      )
    }

    const after = await read($, checklist)
    if (after?.phase === 'done') {
      collapser?.cancel()
      collapser = $.clock.after(COLLAPSE_MS, () => {
        update($, checklist, x => (x && x.phase === 'done' ? { ...x, isCollapsed: true } : x)).catch(() => {})
      })
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = { kind: e.error, details: e.error_details }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    const c = await read($, checklist)
    if (c) {
      await commit($, x => ({
        ...x,
        phase: 'stuck',
        needsYouReason: null,
        stuckReason: 'you said no to a step, so Claude paused',
      }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/i.test(e.notification_type)) {
      const c = await read($, checklist)
      if (c && c.phase !== 'done' && c.phase !== 'stopped') {
        await commit($, x => ({ ...x, phase: 'needs-you', needsYouReason: 'Claude needs your OK to continue' }))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Plan first: while a job runs and has no plan, every tool but the allowed few is held back.
  // Main agent only; subagents are never gated. Also tracks the clear-on-next-tool and failure rules.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    const isOn = await read($, enabled)
    const c = await read($, checklist)

    if (isOn && c && c.phase === 'working' && !c.hasPlan && !ALWAYS_ALLOWED.has(tool)) {
      return { deny: 'Call plan_steps first, with the plain-English steps for this job, then carry on.' }
    }

    if (c) {
      if (tool === 'AskUserQuestion') {
        await commit($, x => ({ ...x, phase: 'needs-you', needsYouReason: 'Claude has a question for you' }))
      } else if (c.phase === 'needs-you') {
        await commit($, x => ({ ...x, phase: 'working', needsYouReason: null }))
      }
    }

    const ran = await next(e)
    if (ran.isError === true) {
      failStreak += 1
      if (failStreak >= 3) {
        await commit($, x => ({
          ...x,
          phase: 'stuck',
          stuckReason: 'a step keeps failing, Claude is trying another way',
        }))
      }
    } else if (ran.deny === undefined) {
      failStreak = 0
      const now = await read($, checklist)
      if (now?.phase === 'stuck') {
        await commit($, x => ({ ...x, phase: 'working', stuckReason: null }))
      }
    }

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Clean View could not check this step, so it was held back.' }))

  on('tool.call', { tool: TOOL_PLAN }, async ($, e) => {
    const raw = (e as { steps?: unknown }).steps
    const steps = Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => cleanName(s))
      : []
    if (steps.length < 2 || steps.length > 8) {
      return { result: 'Give 2 to 8 steps, each a short plain-English name. Nothing was changed.' }
    }

    const c = await read($, checklist)
    if (c && (c.phase === 'working' || c.phase === 'needs-you')) {
      await commit($, x => applyPlan(x, steps))
    } else {
      const now = await $.clock.now()
      await update($, checklist, () => applyPlan(placeholderJob(now), steps))
      syncTicker($, await read($, checklist))
    }

    return { result: `Planned ${steps.length} steps. The first one has started.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Clean View could not finish this step, so it was held back.' }))

  on('tool.call', { tool: TOOL_PROGRESS }, async ($, e) => {
    const task = String((e as { task?: unknown }).task ?? '')
    const percent = clampPercent((e as { percent?: unknown }).percent)
    if (task.trim().length === 0) return { result: 'Name the step you are reporting on. Nothing was changed.' }

    await ensureWorking($)
    await commit($, x => applyProgress(x, task, percent))

    return { result: `Progress noted: ${percent}%.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Clean View could not finish this step, so it was held back.' }))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const todos = (e as { todos?: unknown }).todos
    if (ran.deny === undefined && e.agentId === undefined && Array.isArray(todos) && todos.length > 0) {
      await ensureWorking($)
      await commit($, x => applyTodos(x, todos as Array<{ content?: unknown; status?: unknown }>))
    }

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Clean View could not finish this step, so it was held back.' }))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const subject = (e as { subject?: unknown }).subject
    if (ran.deny === undefined && e.agentId === undefined && typeof subject === 'string') {
      await ensureWorking($)
      await commit($, x => appendTask(x, subject))
    }

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Clean View could not finish this step, so it was held back.' }))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && e.agentId === undefined && (e as { status?: unknown }).status === 'completed') {
      await commit($, x => completeActive(x))
    }

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Clean View could not finish this step, so it was held back.' }))

  // Hide the technical rows while Clean View is on. Off, they draw as the engine would.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)

    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const label = isOn ? '● Clean View: ON' : '○ Clean View: OFF'
    const width = Math.max(10, e.props.bodyColumns)
    const toggle = (
      <Button key="clean-view-toggle" label={label} onPress={() => setEnabled($, !isOn)} />
    )

    if (!isOn) {
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          {toggle}
        </Box>
      )
    }

    const c = await read($, checklist)
    const frame = await read($, tick)
    const now = await $.clock.now()
    const head = headerFor(c, now)
    const buttonWidth = label.length + 4
    const headWidth = Math.max(4, width - buttonWidth - 2)

    const rowsShown = c !== null && !(c.phase === 'done' && c.isCollapsed)
    const nameWidth = Math.max(6, Math.min(40, width - 22))
    const nextIndex = c ? c.tasks.findIndex(task => task.status === 'upcoming') : -1

    const rowFor = (task: Task, index: number) => {
      const isDone = task.status === 'done'
      const isActive = task.status === 'active'
      const isNeedsYou = isActive && c?.phase === 'needs-you'
      const mark = isDone ? '✓' : isNeedsYou ? '‖' : isActive ? '▶' : '○'
      let bar: string
      let label2: string
      if (isDone) {
        bar = meter(100, frame)
        label2 = 'Done'
      } else if (isActive) {
        bar = task.hasReported ? meter(task.percent, frame) : meter(null, frame)
        label2 = task.hasReported ? `${task.percent}%` : 'Working'
      } else {
        bar = meter(0, frame)
        label2 = index === nextIndex ? 'Next' : 'Up next'
      }

      return (
        <Box key={task.id} flexDirection="row">
          <Text color={isDone ? 'success' : undefined} dimColor={!isActive}>
            {mark + ' '}
          </Text>
          <Text bold={isActive} dimColor={!isActive}>
            {padTo(fit(task.name, nameWidth), nameWidth) + ' '}
          </Text>
          <Text dimColor={!isActive}>{bar + '  '}</Text>
          <Text dimColor={!isActive}>{padTo(label2, 7)}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            {head.badge !== null ? (
              <Text bold inverse>
                {' ' + head.badge + ' '}
              </Text>
            ) : null}
            <Text bold={head.isWarning} color={head.isWarning ? 'warning' : undefined}>
              {head.badge !== null ? ' ' + fit(head.text, headWidth - head.badge.length - 3) : fit(head.text, headWidth)}
            </Text>
          </Box>
          {toggle}
        </Box>
        {rowsShown && c
          ? c.tasks.map((task, index) => rowFor(task, index))
          : null}
      </Box>
    )
  })
}

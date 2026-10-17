// Pure helpers for Clean View: name cleaning, meters and checklist changes.
// Nothing here touches the engine, so the tests can call it directly.

import type { Checklist, Task } from '../types'

export const MAX_NAME = 40
export const METER_CELLS = 10
export const WORKING_NAME = 'Working on it'

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|css|scss|html?|json|ya?ml|md|py|swift|rb|go|rs|java|kt|c|h|cc|cpp|hpp|sh|toml|xml|vue|svelte|txt)$/i

// The plain name a person sees: no code, no paths, no file names, one line, at most 40 characters.
export function cleanName(raw: string): string {
  const noCode = raw.replace(/`[^`]*`/g, ' ')
  const words = noCode
    .split(/\s+/)
    .filter(word => word.length > 0)
    .filter(word => !word.includes('/'))
    .filter(word => !CODE_FILE.test(word.replace(/[),.;:!?'"]+$/, '')))
  const text = words.join(' ').trim()
  if (text.length === 0) return WORKING_NAME

  const capital = text.charAt(0).toUpperCase() + text.slice(1)
  if (capital.length <= MAX_NAME) return capital

  // Keep 39 characters, cut back to a word boundary, and add one ellipsis character.
  const head = capital.slice(0, MAX_NAME - 1)
  const space = head.lastIndexOf(' ')
  const base = space > 0 ? head.slice(0, space) : head
  return base.replace(/[\s,;:.\-]+$/, '') + '…'
}

// Cuts a line to a width, with an ellipsis when it does not fit.
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return text.slice(0, width - 1) + '…'
}

export function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

export function clampPercent(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, Math.round(number)))
}

// Ten cells. With a percent it fills to that share; without one it shows a
// sweep of three lit cells that moves on each frame.
export function meter(percent: number | null, frame: number): string {
  const cells = Array.from({ length: METER_CELLS }, () => '░')
  if (percent === null) {
    for (let k = 0; k < 3; k++) cells[(frame + k) % METER_CELLS] = '█'
  } else {
    const filled = Math.round((clampPercent(percent) / 100) * METER_CELLS)
    for (let k = 0; k < filled; k++) cells[k] = '█'
  }
  return cells.join('')
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function placeholderJob(startedAt: number): Checklist {
  return {
    title: WORKING_NAME,
    phase: 'working',
    tasks: [
      { id: 'placeholder-understand', name: 'Understand your request', status: 'active', percent: 0, hasReported: false },
      { id: 'placeholder-plan', name: 'Plan the steps', status: 'upcoming', percent: 0, hasReported: false },
    ],
    hasPlan: false,
    needsYouReason: null,
    stuckReason: null,
    startedAt,
    finishedAt: null,
    isCollapsed: false,
  }
}

// Replaces every step with the real plan. The first one starts.
export function applyPlan(checklist: Checklist, names: string[]): Checklist {
  const tasks: Task[] = names.map((name, index) => ({
    id: `step-${index}`,
    name,
    status: index === 0 ? 'active' : 'upcoming',
    percent: 0,
    hasReported: false,
  }))
  return { ...checklist, tasks, hasPlan: true }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// Records progress on one step. Steps before it are checked off. At 100 it is
// checked off and the next step starts. A name not in the plan becomes a new
// step right after the one in progress.
export function applyProgress(checklist: Checklist, rawName: string, rawPercent: unknown): Checklist {
  const name = cleanName(rawName)
  const percent = clampPercent(rawPercent)
  let tasks = checklist.tasks.map(task => ({ ...task }))

  let index = tasks.findIndex(task => sameName(task.name, name))
  if (index < 0) {
    const current = tasks.findIndex(task => task.status === 'active')
    index = current < 0 ? tasks.length : current + 1
    const added: Task = { id: `step-${tasks.length}`, name, status: 'active', percent: 0, hasReported: false }
    tasks = [...tasks.slice(0, index), added, ...tasks.slice(index)]
  }

  const nextActive = percent >= 100 ? index + 1 : -1
  tasks = tasks.map((task, position) => {
    if (position < index) return { ...task, status: 'done', percent: 100 }
    if (position === index) {
      return percent >= 100
        ? { ...task, status: 'done', percent: 100, hasReported: true }
        : { ...task, status: 'active', percent, hasReported: true }
    }
    if (position === nextActive) return { ...task, status: 'active', percent: 0, hasReported: false }
    return { ...task, status: 'upcoming', percent: 0, hasReported: false }
  })

  return { ...checklist, tasks, hasPlan: true }
}

// The rows of a TodoWrite list become the checklist.
export function applyTodos(
  checklist: Checklist,
  todos: ReadonlyArray<{ content?: unknown; status?: unknown }>,
): Checklist {
  const tasks: Task[] = todos.map((todo, index) => {
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    return {
      id: `todo-${index}`,
      name: cleanName(String(todo.content ?? '')),
      status,
      percent: status === 'done' ? 100 : 0,
      hasReported: status === 'done',
    }
  })
  return { ...checklist, tasks, hasPlan: tasks.length > 0 }
}

// A TaskCreate row. The first real row replaces the placeholders.
export function appendTask(checklist: Checklist, rawName: string): Checklist {
  const real = checklist.tasks.filter(task => !task.id.startsWith('placeholder-'))
  const hasActive = real.some(task => task.status === 'active')
  const added: Task = {
    id: `task-${real.length}`,
    name: cleanName(rawName),
    status: hasActive ? 'upcoming' : 'active',
    percent: 0,
    hasReported: false,
  }
  return { ...checklist, tasks: [...real, added], hasPlan: true }
}

// A TaskUpdate that completes: the step in progress is checked off and the next one starts.
export function completeActive(checklist: Checklist): Checklist {
  const index = checklist.tasks.findIndex(task => task.status === 'active')
  if (index < 0) return checklist
  const tasks = checklist.tasks.map((task, position) => {
    if (position === index) return { ...task, status: 'done' as const, percent: 100, hasReported: true }
    if (position === index + 1 && task.status === 'upcoming') return { ...task, status: 'active' as const }
    return task
  })
  return { ...checklist, tasks }
}

export function unfinishedCount(checklist: Checklist): number {
  return checklist.tasks.filter(task => task.status !== 'done').length
}

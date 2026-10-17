// Pure helpers for Prompt Upgrade: routing, parsing and the drawing's arithmetic.
// Nothing here touches the engine, so the tests can call it directly.

import type { Answer, Question, Stage } from '../types'

export const PANE_ID = 'prompt-upgrade'
export const MAX_QUESTIONS = 3
export const MAX_HISTORY = 20

// Routing ---------------------------------------------------------------

export type Route =
  | { route: 'pass' }
  | { route: 'strip'; text: string }
  | { route: 'intercept'; text: string }

export type RouteInput = {
  originKind: string
  text: string
  turnId?: string
  wait?: boolean
  hasAttachments: boolean
}

// Short replies that go straight through: "yes", "keep going", "ok" and similar.
const SHORT_REPLY = /^(yes|yep|yeah|y|no|nope|n|ok|okay|sure|continue|keep going|go on|go ahead|do it|thanks|thank you|stop|retry|next|done|proceed)[.!?]*$/i

export function routePrompt(input: RouteInput): Route {
  const pass: Route = { route: 'pass' }
  // Only what the person typed in the composer is considered. A plugin's own prompt,
  // a phone or SDK message, a peer's message: all pass.
  if (input.originKind !== 'composer') return pass
  // A message sent while Claude is working, or queued behind a running turn, passes.
  if (input.turnId !== undefined || input.wait === true) return pass
  if (input.hasAttachments) return pass

  const text = input.text.trim()
  if (text === '') return pass
  if (text.startsWith('/')) return pass
  if (text.startsWith('>')) {
    const stripped = text.slice(1).trim()
    return stripped === '' ? pass : { route: 'strip', text: stripped }
  }
  if (SHORT_REPLY.test(text)) return pass
  return { route: 'intercept', text }
}

// Parsing ---------------------------------------------------------------

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length
}

// The first JSON object in a model reply, or null.
export function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(raw.slice(start, end + 1))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function parseQuestions(raw: string): Question[] {
  const data = extractJson(raw)
  const list = data && Array.isArray(data.questions) ? data.questions : []
  const questions: Question[] = []
  for (const item of list) {
    if (questions.length >= MAX_QUESTIONS) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const question = typeof record.question === 'string' ? record.question.trim() : ''
    const options = Array.isArray(record.options)
      ? [...new Set(record.options.filter((o): o is string => typeof o === 'string').map(o => o.trim()))]
          .filter(o => o.length > 0 && o.length <= 40)
      : []
    if (question === '' || options.length < 2) continue
    questions.push({ id: `q${questions.length + 1}`, question, options: options.slice(0, 4) })
  }
  return questions
}

export type Rewrite = { prompt: string; added: string[] }

export function parseRewrite(raw: string): Rewrite | null {
  const data = extractJson(raw)
  if (!data || typeof data.prompt !== 'string' || data.prompt.trim() === '') return null
  const added = Array.isArray(data.added)
    ? data.added.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map(a => a.trim())
    : []
  return { prompt: data.prompt.trim(), added }
}

// The answers as lines the rewrite reads. A skipped question is left out.
export function answerLines(questions: Question[], answers: Record<string, Answer>): string[] {
  const lines: string[] = []
  for (const question of questions) {
    const answer = answers[question.id]
    if (!answer || answer.kind === 'skip') continue
    const value = answer.kind === 'option' ? answer.value : answer.text.trim()
    if (value === '') continue
    lines.push(`${question.question} ${value}`)
  }
  return lines
}

// Prompts for the two model steps ----------------------------------------

export const QUESTION_SYSTEM = [
  'You help a non-technical person make a request clear before it is sent to an AI coding assistant.',
  'Ask at most three multiple-choice questions that would most improve the result.',
  'Each question has two to four short options. Ask nothing if nothing would help.',
  'Reply with JSON only: {"questions":[{"question":"...","options":["...","..."]}]}.',
].join(' ')

export const REWRITE_SYSTEM = [
  'You upgrade a rough request into one clear request the person could have typed themselves, in plain language.',
  'Keep exactly what they meant. Add a clear goal, who it is for, the format, and what done looks like.',
  'Use only the answers given. Never invent facts, names, numbers or prices: write [placeholder] in square brackets where something is unknown.',
  'Reply with JSON only: {"prompt":"...","added":["short note of each detail you added"]}.',
].join(' ')

export function questionPrompt(original: string): string {
  return `Request:\n${original}`
}

export function rewritePrompt(original: string, answers: string[]): string {
  const answered = answers.length > 0 ? answers.map(line => `- ${line}`).join('\n') : '(no answers)'
  return `Request:\n${original}\n\nAnswers:\n${answered}`
}

// Drawing arithmetic ----------------------------------------------------

// Steps shown across the top, in order.
export const STEP_LABELS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const

// The index of the step the stage is on. Error and history stages keep the step they came from.
export function stepIndex(stage: Stage, errorStep: 'questions' | 'rewrite' | null): number {
  switch (stage) {
    case 'input':
    case 'reading':
      return 0
    case 'questions':
      return 1
    case 'rewriting':
      return 2
    case 'review':
      return 3
    case 'error':
      return errorStep === 'rewrite' ? 2 : 1
    default:
      return 0
  }
}

export type StepState = 'done' | 'current' | 'todo'

export function stepStates(current: number): StepState[] {
  return STEP_LABELS.map((_, index) => (index < current ? 'done' : index === current ? 'current' : 'todo'))
}

export function answeredCount(questions: Question[], answers: Record<string, Answer>): number {
  return questions.filter(question => answers[question.id] !== undefined).length
}

// Three-row figures in heavy box-drawing characters.
const BIG: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['┏━┓', '┏━┛', '┗━╸'],
  '3': ['┏━┓', ' ━┫', '┗━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '┗━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['┏━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '┗━┛'],
}

export function bigNumber(value: number): [string, string, string] {
  const digits = String(Math.max(0, Math.round(value))).split('')
  const rows: [string, string, string] = ['', '', '']
  for (const digit of digits) {
    const glyph = BIG[digit] ?? ['   ', '   ', '   ']
    rows[0] += glyph[0] + ' '
    rows[1] += glyph[1] + ' '
    rows[2] += glyph[2] + ' '
  }
  return [rows[0].trimEnd(), rows[1].trimEnd(), rows[2].trimEnd()]
}

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return text.slice(0, width - 1) + '…'
}

// The line of numbers at the top of the review.
export function reviewNumbers(original: string, upgraded: string, added: number) {
  return { before: countWords(original), after: countWords(upgraded), added }
}

// The history list: one line per upgrade, newest first.
export function historyLabel(original: string): string {
  const single = original.replace(/\s+/g, ' ').trim()
  return single.length > 60 ? single.slice(0, 59) + '…' : single
}

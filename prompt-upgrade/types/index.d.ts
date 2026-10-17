// The contract for Prompt Upgrade's shared state.

export type Question = {
  id: string
  question: string
  options: string[]
}

export type Answer =
  | { kind: 'option'; value: string }
  | { kind: 'other'; text: string }
  | { kind: 'skip' }

export type Stage = 'input' | 'reading' | 'questions' | 'rewriting' | 'review' | 'error' | 'history'

export type Flow = {
  stage: Stage
  original: string
  questions: Question[] | null
  answers: Record<string, Answer>
  upgraded: string | null
  added: string[]
  isEditing: boolean
  draft: string | null
  errorStep: 'questions' | 'rewrite' | null
  errorText: string | null
  // Bumped on every model step, so a reply that arrives late is ignored.
  seq: number
}

export type HistoryEntry = {
  at: number
  original: string
  upgraded: string
  added: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: Flow | null
      auto: boolean
      history: HistoryEntry[]
    }
  }
}

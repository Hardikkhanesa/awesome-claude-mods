// The contract for Clean View's shared state. Other mods read the checklist
// through $.state with the same { plugin: 'clean-view', key } references.

export type TaskStatus = 'done' | 'active' | 'upcoming'

export type JobPhase = 'idle' | 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'

export type Task = {
  id: string
  name: string
  status: TaskStatus
  percent: number
  hasReported: boolean
}

export type Checklist = {
  title: string
  phase: JobPhase
  tasks: Task[]
  // True once plan_steps (or TodoWrite) has given the real steps. Until then the
  // placeholder steps are shown and every other tool is held back.
  hasPlan: boolean
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: Checklist | null
      tick: number
    }
  }
}

import type { Register } from 'claude-code'

import { registerPromptUpgrade } from './prompt-upgrade'

export const register: Register = on => {
  registerPromptUpgrade(on)
}

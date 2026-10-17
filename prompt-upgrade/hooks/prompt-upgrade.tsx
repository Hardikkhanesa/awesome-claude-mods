import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Answer, Flow, HistoryEntry, Question } from '../types'
import {
  MAX_HISTORY,
  MAX_QUESTIONS,
  PANE_ID,
  QUESTION_SYSTEM,
  REWRITE_SYSTEM,
  STEP_LABELS,
  answerLines,
  answeredCount,
  bigNumber,
  fit,
  historyLabel,
  parseQuestions,
  parseRewrite,
  questionPrompt,
  rewritePrompt,
  reviewNumbers,
  routePrompt,
  stepIndex,
  stepStates,
} from './prompt-upgrade-logic'

const flowRef = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, null as Flow | null)
const autoRef = atom({ plugin: 'prompt-upgrade', key: 'auto' } as const, false)
const historyRef = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [] as HistoryEntry[])

// The palette of the look: gold for the current step and the upgrade, green for done, amber for warnings.
const GOLD = '#F2C46D'
const HAIR = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const DARK = '#0D1117'

function freshFlow(original: string, seq: number, stage: Flow['stage'] = 'reading'): Flow {
  return {
    stage,
    original,
    questions: null,
    answers: {},
    upgraded: null,
    added: [],
    isEditing: false,
    draft: null,
    errorStep: null,
    errorText: null,
    seq,
  }
}

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE_ID }).catch(() => {})
}

// Opens the pane. Returns false when the window is too narrow to seat it, and closes it again.
async function openPane($: EngineInterface): Promise<boolean> {
  const placed = await $.ui.open({ id: PANE_ID, title: 'Prompt upgrade', focus: true, closeOnEscape: true })
  if (placed.isPlaced) return true
  await closePane($)
  return false
}

// Puts the person's words back in the prompt box, once the current prompt has been dropped.
function restoreWords($: EngineInterface, text: string) {
  $.clock.after(0, () => {
    $.prompt.fill({ text, mode: 'replace' }).catch(() => {})
  })
}

async function setAnswer($: EngineInterface, id: string, answer: Answer) {
  await update($, flowRef, f => (f ? { ...f, answers: { ...f.answers, [id]: answer } } : f))
}

async function failStep($: EngineInterface, seq: number, step: 'questions' | 'rewrite', text: string) {
  await update($, flowRef, f =>
    f && f.seq === seq ? { ...f, stage: 'error' as const, errorStep: step, errorText: text } : f,
  )
}

async function saveHistory($: EngineInterface, entry: HistoryEntry) {
  await update($, historyRef, list => [entry, ...list].slice(0, MAX_HISTORY))
  await $.store.set('history', await read($, historyRef)).catch(() => {})
}

// Step 2: the questions. A reply that comes back after the flow moved on is ignored.
async function runQuestions($: EngineInterface, seq: number) {
  try {
    const flow = await read($, flowRef)
    if (!flow || flow.seq !== seq) return
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 700,
      timeoutMs: 30000,
      system: QUESTION_SYSTEM,
      prompt: questionPrompt(flow.original),
    })
    const current = await read($, flowRef)
    if (!current || current.seq !== seq) return
    if (!reply.isAnswered) {
      await failStep($, seq, 'questions', 'Claude could not reach the model to ask questions.')
      return
    }
    const questions: Question[] = parseQuestions(reply.text).slice(0, MAX_QUESTIONS)
    if (questions.length === 0) {
      await update($, flowRef, f => (f && f.seq === seq ? { ...f, stage: 'rewriting' as const, questions: [] } : f))
      await runRewrite($, seq)
      return
    }
    await update($, flowRef, f =>
      f && f.seq === seq ? { ...f, stage: 'questions' as const, questions, answers: {} } : f,
    )
  } catch {
    await failStep($, seq, 'questions', 'Something interrupted the questions.')
  }
}

// Step 3: the rewrite, built from the original and the answers given.
async function runRewrite($: EngineInterface, seq: number) {
  try {
    const flow = await read($, flowRef)
    if (!flow || flow.seq !== seq) return
    const lines = answerLines(flow.questions ?? [], flow.answers)
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 1200,
      timeoutMs: 45000,
      system: REWRITE_SYSTEM,
      prompt: rewritePrompt(flow.original, lines),
    })
    const current = await read($, flowRef)
    if (!current || current.seq !== seq) return
    if (!reply.isAnswered) {
      await failStep($, seq, 'rewrite', 'Claude could not reach the model to write the upgrade.')
      return
    }
    const rewrite = parseRewrite(reply.text)
    if (!rewrite) {
      await failStep($, seq, 'rewrite', 'The upgrade came back in a form I could not read.')
      return
    }
    await update($, flowRef, f =>
      f && f.seq === seq
        ? { ...f, stage: 'review' as const, upgraded: rewrite.prompt, added: rewrite.added, isEditing: false, draft: null }
        : f,
    )
    await saveHistory($, {
      at: await $.clock.now(),
      original: flow.original,
      upgraded: rewrite.prompt,
      added: rewrite.added,
    })
  } catch {
    await failStep($, seq, 'rewrite', 'Something interrupted the rewrite.')
  }
}

// Starts a new upgrade from the person's words. Returns false when the pane could not open.
async function startUpgrade($: EngineInterface, original: string): Promise<boolean> {
  const previous = await read($, flowRef)
  const seq = (previous?.seq ?? 0) + 1
  await update($, flowRef, () => freshFlow(original, seq))
  if (!(await openPane($))) {
    await update($, flowRef, () => null)
    restoreWords($, original)
    $.ui.toast('The window is too narrow for the upgrade pane. Your words are back in the prompt box.')
    return false
  }
  void runQuestions($, seq)
  return true
}

async function openInput($: EngineInterface) {
  const previous = await read($, flowRef)
  await update($, flowRef, () => freshFlow('', (previous?.seq ?? 0) + 1, 'input'))
  if (!(await openPane($))) {
    await update($, flowRef, () => null)
    $.ui.toast('The window is too narrow for the upgrade pane.')
  }
}

async function openHistory($: EngineInterface) {
  const previous = await read($, flowRef)
  await update($, flowRef, () => freshFlow('', (previous?.seq ?? 0) + 1, 'history'))
  if (!(await openPane($))) {
    await update($, flowRef, () => null)
    $.ui.toast('The window is too narrow for the upgrade pane.')
  }
}

// Run: the upgrade is sent by the plugin, so the prompt hook lets it straight through.
async function runUpgrade($: EngineInterface, text: string) {
  await update($, flowRef, () => null)
  await closePane($)
  await $.prompt.submit({ text })
}

async function cancelUpgrade($: EngineInterface) {
  const flow = await read($, flowRef)
  await update($, flowRef, () => null)
  await closePane($)
  if (flow && flow.original !== '') await $.prompt.fill({ text: flow.original, mode: 'replace' })
}

async function retryStep($: EngineInterface) {
  const flow = await read($, flowRef)
  if (!flow || flow.stage !== 'error') return
  const seq = flow.seq + 1
  if (flow.errorStep === 'rewrite') {
    await update($, flowRef, f => (f ? { ...f, stage: 'rewriting' as const, seq, errorText: null } : f))
    void runRewrite($, seq)
  } else {
    await update($, flowRef, f => (f ? { ...f, stage: 'reading' as const, seq, errorText: null } : f))
    void runQuestions($, seq)
  }
}

export function registerPromptUpgrade(on: On) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'better',
      description: 'Upgrade a rough prompt in a review pane before it is sent',
      argumentHint: '<rough prompt> | on | off | history',
    })
    const savedAuto = await $.store.get('auto')
    await update($, autoRef, () => savedAuto === true)
    const savedHistory = await $.store.get('history')
    if (Array.isArray(savedHistory)) {
      await update($, historyRef, () => savedHistory as HistoryEntry[])
    }

    // A step that was running when the mod reloaded picks back up from its own seq.
    const flow = await read($, flowRef)
    if (flow?.stage === 'reading') void runQuestions($, flow.seq)
    if (flow?.stage === 'rewriting') void runRewrite($, flow.seq)

    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const args = e.args.trim()
      if (args === '') {
        void openInput($)
        return { text: 'Type your rough prompt in the upgrade box.' }
      }
      if (args === 'on' || args === 'off') {
        const isOn = args === 'on'
        await update($, autoRef, () => isOn)
        await $.store.set('auto', isOn)
        return {
          text: isOn
            ? 'Automatic upgrades are on. Prompts you type go to the upgrade pane first.'
            : 'Automatic upgrades are off. Prompts go straight through.',
        }
      }
      if (args === 'history') {
        const list = await read($, historyRef)
        void openHistory($)
        if (list.length === 0) return { text: 'No upgrades yet.' }
        return {
          text: list.map((entry, index) => `${index + 1}. ${historyLabel(entry.original)}`).join('\n'),
        }
      }
      void startUpgrade($, args)
      return { text: 'Upgrading your prompt in the review pane.' }
    } catch {
      return { text: 'Could not open the prompt upgrade. Your words are safe.' }
    }
  })

  // Automatic mode: a prompt typed in the box goes to the pane first. Anything that fails here is sent unchanged.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin') return next(e)
    if (!(await read($, autoRef))) return next(e)

    const decision = routePrompt({
      originKind: e.origin?.kind ?? 'unknown',
      text: e.text,
      turnId: e.turnId,
      wait: e.wait,
      hasAttachments: (e.attachments?.length ?? 0) > 0,
    })
    if (decision.route === 'pass') return next(e)
    if (decision.route === 'strip') return next({ ...e, text: decision.text })

    const placed = await startUpgrade($, decision.text)
    return placed ? { drop: 'Sent to the prompt upgrade pane.' } : { drop: 'The upgrade pane could not open.' }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'prompt-upgrade' }, async ($, e, next) => {
    const flow = await read($, flowRef)
    if (!flow || e.surface === 'mobile') return next(e)

    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const history = await read($, historyRef)
    const { stage, original, questions, answers, upgraded, added, isEditing, draft, errorText } = flow
    const step = stepStates(stepIndex(stage, flow.errorStep))
    const tracker = STEP_LABELS.map((label, index) => {
      const state = step[index]
      const mark = state === 'done' ? '✓ ' : state === 'current' ? '● ' : '○ '
      return { label: mark + label, state }
    })
    const trackerFits = width >= 60
    const titleWidth = Math.min('PROMPT UPGRADE'.length, width)

    const card = (title: string, body: string, isGold: boolean) => (
      <Box flexDirection="column" borderStyle="round" borderColor={isGold ? GOLD : HAIR} paddingX={1} flexGrow={1}>
        <Text color={isGold ? GOLD : MUTED}>{title}</Text>
        <Text color={TEXT}>{body}</Text>
      </Box>
    )

    const sideBySide = (left: JSX.Element, right: JSX.Element) =>
      width >= 72 ? (
        <Box flexDirection="row" gap={1}>
          {left}
          {right}
        </Box>
      ) : (
        <Box flexDirection="column">
          {left}
          {right}
        </Box>
      )

    const heading = (label: string) => (
      <Box flexDirection="column">
        <Text color={MUTED}>{label}</Text>
        <Text color={HAIR}>{'─'.repeat(width)}</Text>
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Text bold color={TEXT}>{'PROMPT UPGRADE'.slice(0, titleWidth)}</Text>
        <Box flexDirection="row">
          <Text color={GOLD}>{'━'.repeat(titleWidth)}</Text>
          <Text color={HAIR}>{'─'.repeat(Math.max(0, width - titleWidth))}</Text>
        </Box>
        {trackerFits ? (
          <Box flexDirection="row">
            {tracker.map((item, index) => (
              <Text
                key={item.label}
                bold={item.state === 'current'}
                color={item.state === 'done' ? GREEN : item.state === 'current' ? GOLD : MUTED}
              >
                {item.label + (index < tracker.length - 1 ? '  ›  ' : '')}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={GOLD}>{fit(tracker.map(item => item.label).join(' › '), width)}</Text>
        )}
      </Box>
    )

    const cancelButton = <Button key="cancel" plain label="Cancel" onPress={() => cancelUpgrade($)} />

    let body: JSX.Element

    if (stage === 'input') {
      body = (
        <Box flexDirection="column">
          {heading('YOUR PROMPT')}
          <Input
            key="rough"
            placeholder="Describe what you want in plain words"
            value={original}
            submitLabel="upgrade"
            onInput={value => update($, flowRef, f => (f ? { ...f, original: value } : f))}
            onSubmit={value => {
              const text = value.trim()
              if (text !== '') void startUpgrade($, text)
            }}
          />
          <Box flexDirection="row" gap={1}>
            <Button
              key="start"
              variant="primary"
              label="Upgrade it"
              onPress={async () => {
                const current = await read($, flowRef)
                if (current && current.original.trim() !== '') void startUpgrade($, current.original.trim())
              }}
            />
            {cancelButton}
          </Box>
        </Box>
      )
    } else if (stage === 'reading' || stage === 'rewriting') {
      body = (
        <Box flexDirection="column">
          {heading('YOUR PROMPT')}
          {card('Your words', original, false)}
          <Text color={MUTED}>{stage === 'reading' ? 'Reading your prompt…' : 'Writing your upgrade…'}</Text>
          <Box flexDirection="row">{cancelButton}</Box>
        </Box>
      )
    } else if (stage === 'questions' && questions) {
      const answered = answeredCount(questions, answers)
      const allAnswered = answered === questions.length
      body = (
        <Box flexDirection="column">
          <Text color={MUTED}>{fit('Your prompt: ' + original.replace(/\s+/g, ' '), width)}</Text>
          {heading('QUESTIONS')}
          {questions.map((question, index) => {
            const answer = answers[question.id]
            return (
              <Box key={question.id} flexDirection="column">
                <Box flexDirection="row">
                  <Text
                    bold
                    color={DARK}
                    backgroundColor={answer ? GREEN : GOLD}
                  >
                    {answer ? ' ✓ ' : ` ${index + 1} `}
                  </Text>
                  <Text color={TEXT}>{' ' + question.question}</Text>
                </Box>
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                  {question.options.map((option, optionIndex) => (
                    <Button
                      key={`${question.id}-o${optionIndex}`}
                      variant={answer?.kind === 'option' && answer.value === option ? 'primary' : undefined}
                      label={option}
                      onPress={() => setAnswer($, question.id, { kind: 'option', value: option })}
                    />
                  ))}
                  <Button
                    key={`${question.id}-other`}
                    variant={answer?.kind === 'other' ? 'primary' : undefined}
                    label="Other (type it)"
                    onPress={() => setAnswer($, question.id, { kind: 'other', text: '' })}
                  />
                  <Button
                    key={`${question.id}-skip`}
                    plain
                    label="Skip"
                    onPress={() => setAnswer($, question.id, { kind: 'skip' })}
                  />
                </Box>
                {answer?.kind === 'other' ? (
                  <Input
                    key={`${question.id}-text`}
                    placeholder="Type your answer"
                    value={answer.text}
                    submitLabel="set"
                    onInput={value => setAnswer($, question.id, { kind: 'other', text: value })}
                    onSubmit={() => {}}
                  />
                ) : null}
              </Box>
            )
          })}
          <Text color={MUTED}>{`${answered} of ${questions.length} answered`}</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="proceed"
              variant="primary"
              label={allAnswered ? 'Upgrade now' : 'Skip the rest, upgrade now'}
              onPress={async () => {
                const current = await read($, flowRef)
                if (!current) return
                const seq = current.seq + 1
                await update($, flowRef, f => (f ? { ...f, stage: 'rewriting' as const, seq } : f))
                void runRewrite($, seq)
              }}
            />
            {cancelButton}
          </Box>
        </Box>
      )
    } else if (stage === 'review' && upgraded !== null) {
      const runText = isEditing && draft !== null ? draft : upgraded
      const numbers = reviewNumbers(original, runText, added.length)
      const numberTiles: Array<[number, string]> = [
        [numbers.before, 'words before'],
        [numbers.after, 'words after'],
        [numbers.added, 'details added'],
      ]
      body = (
        <Box flexDirection="column">
          {width >= 48 ? (
            <Box flexDirection="row" gap={1}>
              {numberTiles.map(([value, label]) => {
                const rows = bigNumber(value)
                return (
                  <Box key={label} flexDirection="column" borderStyle="round" borderColor={HAIR} paddingX={1}>
                    {rows.map((row, rowIndex) => (
                      <Text key={String(rowIndex)} color={TEXT}>{row}</Text>
                    ))}
                    <Text color={MUTED}>{label}</Text>
                  </Box>
                )
              })}
            </Box>
          ) : (
            <Text color={TEXT}>
              {fit(`${numbers.before} → ${numbers.after} words · ${numbers.added} details added`, width)}
            </Text>
          )}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button
              key="run"
              variant="primary"
              label="Run it"
              onPress={async () => {
                const current = await read($, flowRef)
                if (!current || current.upgraded === null) return
                await runUpgrade($, current.isEditing && current.draft !== null ? current.draft : current.upgraded)
              }}
            />
            <Button
              key="edit"
              label="Edit"
              onPress={() => update($, flowRef, f => (f ? { ...f, isEditing: true, draft: f.draft ?? f.upgraded } : f))}
            />
            <Button
              key="copy"
              label="Copy"
              onPress={async () => {
                const current = await read($, flowRef)
                if (!current || current.upgraded === null) return
                const copied = await $.ui.copy({
                  text: current.isEditing && current.draft !== null ? current.draft : current.upgraded,
                })
                $.ui.toast(copied.isCopied ? 'Copied to the clipboard' : 'Could not copy from here')
              }}
            />
            {cancelButton}
          </Box>
          {isEditing ? (
            <Input
              key="edit-text"
              placeholder="Edit the upgrade"
              value={draft ?? upgraded}
              submitLabel="run"
              onInput={value => update($, flowRef, f => (f ? { ...f, draft: value } : f))}
              onSubmit={value => {
                if (value.trim() !== '') void runUpgrade($, value.trim())
              }}
            />
          ) : null}
          {added.length > 0 ? (
            <Box flexDirection="column">
              {heading('WHAT I ADDED')}
              {added.map((item, index) => (
                <Text key={String(index)} color={TEXT}>{fit(`· ${item}`, width)}</Text>
              ))}
            </Box>
          ) : null}
          {sideBySide(
            card('Your prompt', original, false),
            card('Upgrade', runText, true),
          )}
        </Box>
      )
    } else if (stage === 'error') {
      body = (
        <Box flexDirection="column">
          <Text color={MUTED}>{fit('Your prompt: ' + original.replace(/\s+/g, ' '), width)}</Text>
          <Text color={AMBER}>Something went wrong. Your prompt is safe.</Text>
          {errorText ? <Text color={MUTED}>{errorText}</Text> : null}
          <Box flexDirection="row" gap={1}>
            <Button key="retry" variant="primary" label="Try again" onPress={() => retryStep($)} />
            <Button
              key="send-original"
              label="Send my original"
              onPress={async () => {
                const current = await read($, flowRef)
                if (!current) return
                await update($, flowRef, () => null)
                await closePane($)
                await $.prompt.submit({ text: current.original })
              }}
            />
            {cancelButton}
          </Box>
        </Box>
      )
    } else if (stage === 'history') {
      body = (
        <Box flexDirection="column">
          {heading('LAST 20 UPGRADES')}
          {history.length === 0 ? <Text color={MUTED}>No upgrades yet.</Text> : null}
          {history.map((entry, index) => (
            <Button
              key={`hist-${index}`}
              plain
              label={fit(`${index + 1}. ${historyLabel(entry.original)}`, Math.max(10, width - 6))}
              onPress={async () => {
                const current = await read($, flowRef)
                const seq = (current?.seq ?? 0) + 1
                await update($, flowRef, () => ({
                  ...freshFlow(entry.original, seq, 'review'),
                  upgraded: entry.upgraded,
                  added: entry.added,
                }))
              }}
            />
          ))}
          <Box flexDirection="row">{cancelButton}</Box>
        </Box>
      )
    } else {
      body = <Box />
    }

    return (
      <Box flexDirection="column">
        {header}
        {body}
      </Box>
    )
  })
}

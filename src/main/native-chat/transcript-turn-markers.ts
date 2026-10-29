// Share provider boundary predicates so visible interruption rows and lifecycle settlement agree.

import { asRecord, extractString } from '../ai-vault/session-scanner-values'

export function claudeInterruptedMessageId(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user') {
    return undefined
  }
  return extractString(record.interruptedMessageId) ?? undefined
}

// Prompt-submit hook endings that run no turn; same set as the stream-surface row reader (claude-informational-row).
const CLAUDE_PROMPT_SUBMIT_HOOK_ENDINGS = new Set([
  'blocked_by_hook',
  'dropped_by_hook',
  'not_passed_on',
  'stopped_by_hook'
])

// Older CLIs report the same outcomes as bare sentences (also claude-informational-row).
const CLAUDE_HOOK_SENTENCE_PREFIXES = [
  /^\S+ operation blocked by hook:\s*/,
  /^Operation stopped by hook:?\s*/
]

/** A UserPromptSubmit hook rejected the prompt: no turn runs, so its informational row is the turn's end. */
export function claudePromptSubmitEndedByHook(record: Record<string, unknown>): boolean {
  if (record.type !== 'system' || record.subtype !== 'informational') {
    return false
  }
  const endingKind = extractString(asRecord(asRecord(record.promptSubmitEnding)?.ending)?.kind)
  if (endingKind !== null) {
    return CLAUDE_PROMPT_SUBMIT_HOOK_ENDINGS.has(endingKind)
  }
  const content = extractString(record.content)
  return content !== null && CLAUDE_HOOK_SENTENCE_PREFIXES.some((prefix) => prefix.test(content))
}

export const CODEX_EVENT_TURN_STARTED = 'task_started'
export const CODEX_EVENT_TURN_COMPLETE = 'task_complete'
export const CODEX_EVENT_TURN_ABORTED = 'turn_aborted'

import { describe, expect, it, vi } from 'vitest'

import { createTerminalDocumentScope } from './document-scope'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'

function scopeWithScrolledBackTerm() {
  const double = terminalDocumentDouble()
  const scrollToBottom = vi.spyOn(double.terminal, 'scrollToBottom')
  const scope = createTerminalDocumentScope()
  scope.term = double.terminal
  // Reader parked in scrollback with a pending replay anchor, as after a swipe up.
  Object.assign(double.terminal.buffer.active, { viewportY: 12, baseY: 40 })
  scope.pendingReplayScrollAnchorRows = 5
  return { scope, scrollToBottom }
}

describe('return-to-prompt host message', () => {
  it('scrolls the terminal back to the prompt and drops the pending replay anchor', () => {
    const { scope, scrollToBottom } = scopeWithScrolledBackTerm()
    handleMsg(scope, { type: 'return-to-prompt' })
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(scope.pendingReplayScrollAnchorRows).toBeNull()
  })

  it('is idempotent while already at the prompt', () => {
    const { scope, scrollToBottom } = scopeWithScrolledBackTerm()
    scope.pendingReplayScrollAnchorRows = null
    handleMsg(scope, { type: 'return-to-prompt' })
    handleMsg(scope, { type: 'return-to-prompt' })
    expect(scrollToBottom).toHaveBeenCalledTimes(2)
    expect(scope.pendingReplayScrollAnchorRows).toBeNull()
  })

  it('does nothing without a terminal', () => {
    const scope = createTerminalDocumentScope()
    scope.pendingReplayScrollAnchorRows = 5
    expect(() => handleMsg(scope, { type: 'return-to-prompt' })).not.toThrow()
    expect(scope.pendingReplayScrollAnchorRows).toBeNull()
  })

  it('keeps program output from moving the reader position (scrollback reading)', () => {
    const { scope, scrollToBottom } = scopeWithScrolledBackTerm()
    handleMsg(scope, { type: 'write', data: 'more output' })
    expect(scrollToBottom).not.toHaveBeenCalled()
    expect(scope.pendingReplayScrollAnchorRows).toBe(5)
  })
})

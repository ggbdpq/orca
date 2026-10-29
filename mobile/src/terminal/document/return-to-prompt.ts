import type { TerminalDocumentScope } from './document-scope'

// Scrollback reading survives program output and pointer reports; only user-authored input pulls
// the view back to the prompt (desktop parity: xterm scrollOnUserInput on user data events).
export function returnToPrompt(scope: TerminalDocumentScope) {
  // A pending replay anchor would override the scroll on the next paint; explicit input drops it, like clear.
  scope.pendingReplayScrollAnchorRows = null
  scope.term?.scrollToBottom()
}

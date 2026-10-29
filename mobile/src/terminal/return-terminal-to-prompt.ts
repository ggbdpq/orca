import type { RefObject } from 'react'
import type { TerminalWebViewHandle } from './terminal-webview-contract'

// User-authored input (typing, accessory keys, composer, dictation, paste) pulls a scrollback-reading
// view back to its prompt. Pointer reports, query replies and programmatic sends keep the position.
// Tolerant by design: a missing or failing webview ref must never break the input send that called us.
export function returnToPromptWhenSent(
  send: Promise<boolean>,
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>> | undefined,
  handle: string | null | undefined
): Promise<boolean> {
  return send.then((sent) => {
    if (sent) {
      returnTerminalToPrompt(terminalRefs, handle)
    }
    return sent
  })
}

export function returnTerminalToPrompt(
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>> | undefined,
  handle: string | null | undefined
): void {
  try {
    if (!handle) {
      return
    }
    terminalRefs?.current?.get(handle)?.returnToPrompt()
  } catch {
    // Scrolling is cosmetic follow-through; input delivery already succeeded.
  }
}

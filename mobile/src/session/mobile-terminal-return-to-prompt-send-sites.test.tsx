import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { resetWorkerTerminalTakeoverReportsForTest } from '../terminal/worker-terminal-takeover-report'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import { routeDictationTranscript } from '../terminal/terminal-live-dictation-routing'
import { sendMobileTerminalQueryReply } from '../terminal/mobile-terminal-query-reply'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

vi.mock('react-native', () => ({ Keyboard: { dismiss: vi.fn() } }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => 'pasted text' }))
vi.mock('./mobile-image-source-picker', () => ({
  pickMobileImage: vi.fn(),
  pickMobileImages: vi.fn()
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: '/tmp' } }))

const ref = <T,>(current: T) => ({ current })
const renderers: ReactTestRenderer[] = []

function stubWebViewHandle(returnToPrompt: () => void): TerminalWebViewHandle {
  return {
    prepareForForegroundRecovery: () => {},
    write: () => {},
    init: () => {},
    resize: () => {},
    reflow: () => {},
    clear: () => {},
    fitDimensions: () => null,
    resetZoom: () => {},
    cancelSelect: () => {},
    doSelectAll: () => {},
    returnToPrompt,
    awaitReady: async () => {}
  }
}

function mountSendSites(client: ReturnType<typeof clientFixture>, handle = 'term-1') {
  const returnToPrompt = vi.fn()
  const terminalRefs = ref(
    new Map<string, TerminalWebViewHandle>([[handle, stubWebViewHandle(returnToPrompt)]])
  )
  const activeHandleRef = ref<string | null>(handle)
  const activeSessionTabTypeRef = ref<string | null>('terminal')
  const sendLiveTerminalInputRef = ref(async (_handle: string, _text: string) => false)
  const scope = {
    client,
    clientRef: ref(client),
    activeHandle: handle,
    activeHandleRef,
    activeSessionTabTypeRef,
    connState: 'connected',
    connStateRef: ref('connected'),
    activeSessionTab: { type: 'terminal', terminal: handle },
    sendingRef: ref(false),
    canSend: true,
    deviceTokenRef: ref('phone'),
    liveInputRef: ref(null),
    commandInputRef: ref(null),
    liveInputFocusTimerRef: ref(null),
    sendLiveTerminalInputRef,
    terminalRefs,
    getSendCompletionGeneration: () => 0,
    showToast: vi.fn(),
    ptyModesRef: ref(new Map([[handle, { altScreen: true }]])),
    terminalGestureInputBucketsRef: ref(new Map()),
    terminalGestureInputQueuesRef: ref(new Map()),
    terminalGestureInputInFlightRef: ref(new Set()),
    bufferedTerminalDraftState: {
      input: 'command',
      beginBufferedTerminalDraftSend: vi.fn(),
      restoreRejectedDraft: vi.fn(),
      settleBufferedTerminalDraftSend: () => true
    }
  }
  let actions!: ReturnType<typeof useMobileSessionTerminalSendActions>
  let live!: ReturnType<typeof useTerminalLiveInputCommit>
  let gestures!: ReturnType<typeof useMobileSessionTerminalInput>
  let paste!: ReturnType<typeof useMobileTerminalPaste>
  function Harness() {
    live = useTerminalLiveInputCommit({
      activeHandle: handle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      liveInputRef: ref(null),
      liveInputTerminalHandles: new Set([handle]),
      liveInputTerminalHandlesRef: ref(new Set([handle])),
      sendLiveTerminalInputRef,
      onTerminalInputSent: returnToPrompt,
      setLiveInputCapture: vi.fn()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared scope stub omits the models' unused fields; the send paths never read them.
    actions = useMobileSessionTerminalSendActions({
      ...scope,
      handleLiveInputAccessoryBytes: live.handleLiveInputAccessoryBytes
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same stub scope as above; input gating reads only the refs it initializes here.
    gestures = useMobileSessionTerminalInput(scope as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared scope stub carries fields of deliberately loose test types; the paste path reads only the options listed here.
    paste = useMobileTerminalPaste({
      ...scope,
      flushPendingLiveInputBeforeExternalSend: live.flushPendingLiveInputBeforeExternalSend,
      getActiveWorktreeConnectionId: async () => null,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      refreshCanPaste: vi.fn()
    } as never)
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  let text = ''
  const scrolls = () => returnToPrompt.mock.calls
  return {
    scrolls,
    'live field': async () => {
      text += 'x'
      live.handleLiveInputChange({ nativeEvent: { text, isComposing: false } })
      await live.flushPendingLiveInputBeforeExternalSend(handle)
    },
    'live submit': () => live.handleLiveInputSubmit(),
    'live accessory': async () => {
      live.handleLiveInputChange({ nativeEvent: { text: 'composing', isComposing: true } })
      await live.handleLiveInputAccessoryBytes({ bytes: '\x1b[A' })
    },
    'raw accessory': () => actions.handleAccessoryKey({ bytes: '\x1b[A' }),
    'buffered submit': () => actions.handleSend(),
    'gesture arrows': async () => {
      await gestures.handleTerminalInput(handle, '\x1b[A')
      await gestures.flushTerminalGestureInput(handle)
    },
    paste: () => paste(),
    dictation: async () => {
      const route = routeDictationTranscript('dictated text', true)
      expect(route.kind).toBe('live-insert')
      await actions.sendLiveTerminalInput(handle, route.text)
    },
    'query reply': () =>
      sendMobileTerminalQueryReply({
        bytes: '\x1b[0n',
        client,
        clientId: 'phone',
        connected: true,
        handle,
        hostSupportsQueryReplyInput: true,
        hostSupportsProgramStatus: true,
        subscribedTerminals: new Set([handle])
      }),
    programmatic: () => client.sendRequest('terminal.send')
  }
}

function clientFixture(rejected = false) {
  return {
    sendRequest: vi.fn(async (method: string, _params?: unknown) => ({
      id: 'rpc',
      ok: true as const,
      result:
        method === 'terminal.send'
          ? { send: { accepted: !rejected } }
          : method === 'session.tabs.createTerminal'
            ? { tab: { type: 'terminal', id: 'tab', terminal: 'term-1', title: 'test' } }
            : { changed: 1 }
    }))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  resetWorkerTerminalTakeoverReportsForTest()
})
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount()
    }
  })
  vi.useRealTimers()
})

// 'raw accessory' (the live-input-OFF accessory raw branch) is not pinned either way: the send-actions
// file sits at its oxlint max-lines cap, so that follow-up needs its own split first.
const typingSites = [
  'live field',
  'live submit',
  'live accessory',
  'buffered submit',
  'paste'
] as const

it.each(typingSites)('%s returns a scrolled-back terminal to its prompt', async (site) => {
  const client = clientFixture()
  const sites = mountSendSites(client)
  await act(async () => {
    await sites[site]()
  })
  expect(client.sendRequest.mock.calls.some(([method]) => method === 'terminal.send')).toBe(true)
  expect(sites.scrolls()).toHaveLength(1)
})

it.each(['gesture arrows', 'query reply', 'programmatic'] as const)(
  '%s preserves the reading position (no return to prompt)',
  async (site) => {
    const client = clientFixture()
    const sites = mountSendSites(client)
    await act(async () => {
      await sites[site]()
      await sites[site]()
    })
    expect(sites.scrolls()).toHaveLength(0)
  }
)

it.each(typingSites)('%s keeps the view when the send is rejected', async (site) => {
  const client = clientFixture(true)
  const sites = mountSendSites(client)
  await act(async () => {
    await sites[site]()
  })
  expect(sites.scrolls()).toHaveLength(0)
})

import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// The connection fixture invokes hooks without mounting React.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

// #33684: a hidden-delivery-gate restore writes its last byte, then the pane must be
// presented (full-viewport refresh) AFTER that write. Reveal races the IntersectionObserver
// and xterm's render pause; writes that land after the last present are swallowed into
// stale pixels until a selection/scroll forces a repaint.
function expectPresentAfterLastWrite(
  pane: ReturnType<typeof createPane>,
  refresh: ReturnType<typeof vi.fn>
): void {
  const writeOrder = pane.terminal.write.mock.invocationCallOrder
  const refreshOrder = refresh.mock.invocationCallOrder
  expect(writeOrder.length).toBeGreaterThan(0)
  expect(refreshOrder.length).toBeGreaterThan(0)
  expect(refreshOrder.at(-1)!).toBeGreaterThan(writeOrder.at(-1)!)
}

describe('connectPanePty hidden-output restore viewport present', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  function attachRefreshSpy(pane: ReturnType<typeof createPane>): ReturnType<typeof vi.fn> {
    const refresh = vi.fn()
    Object.assign(pane.terminal, { refresh })
    return refresh
  }

  async function connectHiddenClaudePane(overrides: Record<string, unknown> = {}) {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    let onData: ConnectCallbacks['onData']
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      onData = callbacks.onData
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const refresh = attachRefreshSpy(pane)
    const isVisibleRef = { current: false }
    const deps = createDeps({ isVisibleRef, startup: { command: 'codex' }, ...overrides })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture mocks are structurally partial bags; every sibling pty-connection suite binds them the same way.
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    return { pane, refresh, onData: onData!, isVisibleRef, disposable, deps }
  }

  const hiddenChunk = 'hidden-before-flood\r\n'
  const liveChunk = 'spinner redraw\r\n'

  it('presents the viewport after the deadline abandon drains its last pending byte', async () => {
    const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    // The reporter's busy-spinner shape: the snapshot serialize is still in flight when the
    // foreground deadline (750ms) abandons the restore and drains the queued live bytes.
    const snapshotDeferred = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    getSnapshot.mockReturnValueOnce(snapshotDeferred.promise)
    const { pane, refresh, onData, isVisibleRef, disposable } = await connectHiddenClaudePane()

    onData?.(hiddenChunk, { seq: hiddenChunk.length, rawLength: hiddenChunk.length })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'hidden-drop',
      markerSeq: 64
    })
    isVisibleRef.current = true
    await flushAsyncTicks(30)

    vi.useFakeTimers()
    try {
      // Queue the live chunk under the virtual clock so the 750ms foreground deadline it
      // arms is fake-timer driven, then let the deadline abandon and drain.
      onData?.(liveChunk, { seq: 96, rawLength: liveChunk.length })
      await vi.advanceTimersByTimeAsync(800)
      await flushAsyncTicks(30)
    } finally {
      vi.useRealTimers()
    }
    await flushAsyncTicks(30)
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    expectPresentAfterLastWrite(pane, refresh)

    snapshotDeferred.resolve({ data: 'late\r\n', cols: 120, rows: 40, seq: 128 })
    await flushAsyncTicks(20)
    disposable.dispose()
  })

  it('presents the viewport after the clean drain writes its last byte', async () => {
    const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const modelTail = '\x1b[0'
    getSnapshot.mockResolvedValueOnce({
      data: 'snapshot-screen\r\n',
      pendingEscapeTailAnsi: modelTail,
      cols: 120,
      rows: 40,
      seq: 64
    })
    const { pane, refresh, onData, isVisibleRef, disposable } = await connectHiddenClaudePane()

    onData?.(hiddenChunk, { seq: 20, rawLength: 20 })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'hidden-drop',
      markerSeq: 64
    })
    isVisibleRef.current = true
    // Queued while the restore is in flight, drained after the snapshot paints.
    onData?.(liveChunk, { seq: 84, rawLength: liveChunk.length })
    await flushAsyncTicks(30)
    await flushAsyncTicks(30)

    expectPresentAfterLastWrite(pane, refresh)
    disposable.dispose()
  })
})

// The background-task channel's resume contract: a conversation read at rest has
// no live provider child, so the channel answers `null` rather than omitting the
// field — an omitted field reads as "no change" on the renderer, which kept a
// finished task on the strip forever after the pane was hidden (#24227).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

const SESSION = 'background-task-channel-session'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-background-task-channel-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function buildChannel(input: {
  journal: AgentSessionJournal
  backgroundTaskState: () => unknown
  subscribers: AgentSessionSubscribers
  onPublished: (sessionId: string) => void
}): StructuredAgentSessionBackgroundTaskChannel {
  const session = {
    journal: input.journal,
    params: {},
    child: null
  } as unknown as StructuredAgentSessionHostSession
  return new StructuredAgentSessionBackgroundTaskChannel(
    {
      adapter: { backgroundTaskState: input.backgroundTaskState },
      store: { getRecord: () => undefined }
    },
    new Map([[SESSION, session]]),
    input.subscribers,
    async () => session,
    input.onPublished
  )
}

describe('StructuredAgentSessionBackgroundTaskChannel', () => {
  it('reports an empty background-task state on resume when the provider child is gone', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: null }
      },
      stateDirectory: join(root, 'swept-child-journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const channel = buildChannel({
      journal,
      // The idle sweep stopped the provider child: the adapter cannot see it.
      backgroundTaskState: () => undefined,
      subscribers,
      onPublished: () => {}
    })

    const events: AgentSessionSubscribeEvent[] = []
    const close = await channel.subscribe({
      id: 'pane-1',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: journal.cursor()
    })
    // Read before close(): the unsubscribe emits a terminal `end` frame.
    const batch = events.at(-1)
    close()

    expect(batch?.type).toBe('batch')
    expect(batch?.backgroundTasks).toBe(null)
  })

  it('passes a live monitoring state through untouched on resume', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: null }
      },
      stateDirectory: join(root, 'live-child-journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const liveState = {
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'command', description: 'watch CI' }]
    }
    const backgroundTaskState = vi.fn(() => liveState)
    const channel = buildChannel({
      journal,
      backgroundTaskState,
      subscribers,
      onPublished: () => {}
    })

    const events: AgentSessionSubscribeEvent[] = []
    const close = await channel.subscribe({
      id: 'pane-1',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: journal.cursor()
    })
    const batch = events.at(-1)
    close()

    expect(backgroundTaskState).toHaveBeenCalledWith(SESSION)
    expect(batch?.backgroundTasks).toBe(liveState)
  })

  it('keeps an explicit null from the adapter as null on resume', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: null }
      },
      stateDirectory: join(root, 'settled-child-journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const channel = buildChannel({
      journal,
      backgroundTaskState: () => null,
      subscribers,
      onPublished: () => {}
    })

    const events: AgentSessionSubscribeEvent[] = []
    const close = await channel.subscribe({
      id: 'pane-1',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: journal.cursor()
    })
    const batch = events.at(-1)
    close()

    expect(batch?.backgroundTasks).toBe(null)
  })

  it('reports an empty state in history reads when the provider child is gone', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: null }
      },
      stateDirectory: join(root, 'history-journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const channel = buildChannel({
      journal,
      backgroundTaskState: () => undefined,
      subscribers,
      onPublished: () => {}
    })

    const result = await channel.history({ sessionId: SESSION, direction: 'tail' })

    expect(result.page.backgroundTasks).toBe(null)
  })
})

import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RenderRow } from '../listing/render-row'
import {
  findPreferredRenderRowIndexForWorktree,
  findPreferredRenderRowIndexForWorktreeIdentity
} from './render-row-lookup'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo-1',
  displayName: 'Repo 1',
  badgeColor: '#737373',
  addedAt: 1
}

function worktree(id: string, isPinned = false): Worktree {
  return {
    id,
    repoId: repo.id,
    path: `/repo-1/${id}`,
    displayName: id,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned,
    sortOrder: 1,
    lastActivityAt: 1
  }
}

function item(workspace: Worktree, sectionKey: string): RenderRow {
  return {
    type: 'item',
    rowKey: `${sectionKey}:${workspace.id}`,
    sectionKey,
    worktree: workspace,
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

// Pinned section renders first, so the pinned duplicate sits at a lower index
// than the workspace's ordinary group copy.
const wt1 = worktree('wt-1', true)
const other = worktree('wt-2')
const duplicateRows: RenderRow[] = [
  item(wt1, 'pinned'),
  item(other, 'repo-1'),
  item(other, 'pinned'),
  item(wt1, 'repo-1')
]
const onlyPinnedVisible = (row: RenderRow): boolean => row === duplicateRows[0]
const nothingVisible = (): boolean => false
const naturalRowVisible = (row: RenderRow): boolean => row === duplicateRows[3]

describe('findPreferredRenderRowIndexForWorktree with a visibility predicate', () => {
  it('keeps the natural-group preference when no predicate is given', () => {
    expect(
      findPreferredRenderRowIndexForWorktree(duplicateRows, 'wt-1', 'duplicate-in-groups')
    ).toBe(3)
  })

  it('reveals the pinned copy the user is looking at instead of yanking to the group copy', () => {
    expect(
      findPreferredRenderRowIndexForWorktree(
        duplicateRows,
        'wt-1',
        'duplicate-in-groups',
        onlyPinnedVisible
      )
    ).toBe(0)
  })

  it('falls back to the natural-group copy when no copy is visible', () => {
    expect(
      findPreferredRenderRowIndexForWorktree(
        duplicateRows,
        'wt-1',
        'duplicate-in-groups',
        nothingVisible
      )
    ).toBe(3)
  })

  it('prefers a visible natural-group copy over an off-screen pinned copy', () => {
    expect(
      findPreferredRenderRowIndexForWorktree(
        duplicateRows,
        'wt-1',
        'duplicate-in-groups',
        naturalRowVisible
      )
    ).toBe(3)
  })

  it('leaves single-location lookups untouched', () => {
    const singleRows: RenderRow[] = [item(wt1, 'pinned'), item(other, 'repo-1')]
    expect(
      findPreferredRenderRowIndexForWorktree(
        singleRows,
        'wt-1',
        'single-location',
        onlyPinnedVisible
      )
    ).toBe(0)
  })
})

describe('findPreferredRenderRowIndexForWorktreeIdentity with a visibility predicate', () => {
  it('keeps the natural-group preference when no predicate is given', () => {
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(duplicateRows, wt1, 'duplicate-in-groups')
    ).toBe(3)
  })

  it('reveals the visible pinned copy instead of the off-screen group copy', () => {
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        duplicateRows,
        wt1,
        'duplicate-in-groups',
        onlyPinnedVisible
      )
    ).toBe(0)
  })

  it('falls back to the natural-group copy when no copy is visible', () => {
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        duplicateRows,
        wt1,
        'duplicate-in-groups',
        nothingVisible
      )
    ).toBe(3)
  })
})

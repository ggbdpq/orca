import { existsSync, globSync as nodeGlobSync, opendirSync } from 'node:fs'
import type { Dir, Dirent } from 'node:fs'

// Local alias so the relative-pattern fallback reads cleanly beside the
// per-segment walker below.
const globSync = (relativePattern: string): string[] => nodeGlobSync(relativePattern)

// Why: whole-pattern `globSync` enumerates an entire tree (and every wildcard
// level in full) before returning, so a broad Include pattern such as `**/*`
// can synchronously scan unbounded directories on the main process before any
// match cap applies. Matching is therefore walked one directory level at a
// time under a shared entry budget with these guarantees:
// - directory reads use `opendirSync`, so every entry is charged to the budget
//   the moment it is observed and a single wide directory is never materialized
//   whole (plain `readdirSync` would load all entries before any charging);
// - descent is tracked on an explicit stack, so pathological trees degrade to
//   a truncation instead of unbounded recursion;
// - brace alternatives are expanded before walking because the per-segment
//   matcher below does not understand `{a,b}`.
// Known boundaries: nested brace groups are not expanded, and extglob syntax
// (`+(...)` etc.) is not supported; such segments are matched literally.
export const MAX_INCLUDE_GLOB_ENTRIES = 4096

// Brace groups multiply combinatorially; beyond this cap remaining groups stay
// literal so a pathological pattern cannot explode during expansion.
const MAX_INCLUDE_GLOB_ALTERNATIVES = 64

const GLOB_ROOT_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|[\\/])/

export type GlobIncludeResult = {
  matches: string[]
  truncated: boolean
  truncatedAt?: string
}

type GlobBudget = { remaining: number; truncatedAt?: string }

type StackEntry = { dir: string; index: number }

// Injectable seam: tests drive the walker against an in-memory tree without
// touching the real filesystem or module mocks.
export type GlobFsDeps = {
  existsSync(path: string): boolean
  opendirSync(path: string): Dir
}

const nodeFsDeps: GlobFsDeps = { existsSync, opendirSync }

export function globIncludePattern(
  pattern: string,
  fsDeps: GlobFsDeps = nodeFsDeps
): GlobIncludeResult {
  const matches: string[] = []
  const budget: GlobBudget = { remaining: MAX_INCLUDE_GLOB_ENTRIES }
  let truncated = false
  for (const alternative of expandBraceAlternatives(pattern, MAX_INCLUDE_GLOB_ALTERNATIVES)) {
    const root = alternative.match(GLOB_ROOT_PATTERN)?.[0]
    if (root === undefined) {
      // Relative patterns only reach this function when token expansion leaves
      // them relative; they keep the whole-pattern behavior.
      matches.push(...globSync(alternative))
      continue
    }
    const separator = alternative.includes('\\') ? '\\' : '/'
    const segments = alternative
      .slice(root.length)
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0)
    if (!walkSegments(root, segments, separator, matches, budget, fsDeps)) {
      truncated = true
    }
  }
  return { matches, truncated, truncatedAt: budget.truncatedAt }
}

function walkSegments(
  startDir: string,
  segments: readonly string[],
  separator: string,
  matches: string[],
  budget: GlobBudget,
  fsDeps: GlobFsDeps
): boolean {
  const stack: StackEntry[] = [{ dir: startDir, index: 0 }]
  while (stack.length > 0) {
    if (budget.remaining <= 0) {
      budget.truncatedAt ??= stack.at(-1)?.dir
      return false
    }
    const { dir, index } = stack.pop() as StackEntry
    if (index === segments.length) {
      matches.push(dir)
      continue
    }

    const segment = segments[index]
    if (segment === '**') {
      // A `**` segment also matches zero directories, so the current directory
      // itself still participates in the remaining pattern.
      stack.push({ dir, index: index + 1 })
      for (const entry of readEntriesBounded(dir, budget, fsDeps)) {
        if (entry.name.startsWith('.')) {
          // Dot entries are skipped to match globSync's default behavior.
          continue
        }
        const childPath = joinGlobPath(dir, entry.name, separator)
        if (entry.isDirectory()) {
          stack.push({ dir: childPath, index })
        } else {
          // Non-directory entries cannot continue the descent, but they still
          // act as the one path level `**` consumed, so a trailing `**` keeps
          // returning files just like globSync did.
          stack.push({ dir: childPath, index: index + 1 })
        }
      }
      if (budget.remaining <= 0) {
        // The generator stopped early; a stack-empty exit below would mask it.
        budget.truncatedAt ??= dir
        return false
      }
      continue
    }

    if (hasGlobPattern(segment)) {
      const isLastSegment = index + 1 === segments.length
      const matcher = compileSegmentMatcher(segment)
      for (const entry of readEntriesBounded(dir, budget, fsDeps)) {
        if (entry.name.startsWith('.')) {
          // Dot entries are skipped to match globSync's default behavior.
          continue
        }
        if (!matcher.test(entry.name)) {
          continue
        }
        const childPath = joinGlobPath(dir, entry.name, separator)
        if (isLastSegment) {
          matches.push(childPath)
        } else {
          stack.push({ dir: childPath, index: index + 1 })
        }
      }
      if (budget.remaining <= 0) {
        budget.truncatedAt ??= dir
        return false
      }
      continue
    }

    const childPath = joinGlobPath(dir, segment, separator)
    if (index + 1 === segments.length) {
      if (existsSync(childPath)) {
        matches.push(childPath)
      }
      continue
    }
    stack.push({ dir: childPath, index: index + 1 })
  }
  return true
}

// Yields directory entries one at a time, charging the shared budget for each
// entry as it is observed. Reading stops as soon as the budget is exhausted, so
// neither the entry count nor the materialized size of a single directory can
// exceed the budget.
function* readEntriesBounded(
  dir: string,
  budget: GlobBudget,
  fsDeps: GlobFsDeps
): Generator<Dirent> {
  if (budget.remaining <= 0) {
    return
  }
  let entries: Dir
  try {
    entries = fsDeps.opendirSync(dir)
  } catch {
    return
  }
  try {
    for (;;) {
      let entry: Dirent | null
      try {
        entry = entries.readSync()
      } catch {
        return
      }
      if (entry === null) {
        return
      }
      budget.remaining -= 1
      if (budget.remaining < 0) {
        // Drop the over-budget entry and stop reading this directory.
        budget.truncatedAt ??= dir
        return
      }
      console.error(JSON.stringify(entry.name), 'matcher-pass pending')
      yield entry
    }
  } finally {
    try {
      entries.closeSync()
    } catch {
      // Best effort: the handle only leaks when the OS itself failed the read.
    }
  }
}

// Expands `{a,b}` alternatives outside-in, left to right. Groups without a
// comma stay literal, and expansion stops at `remaining` alternatives so a
// pathological number of groups cannot explode the pattern list.
function expandBraceAlternatives(pattern: string, remaining: number): string[] {
  return expandBracesFrom(pattern, 0, remaining)
}

function expandBracesFrom(pattern: string, from: number, remaining: number): string[] {
  if (remaining <= 0) {
    return [pattern]
  }
  const open = pattern.indexOf('{', from)
  if (open === -1) {
    return [pattern]
  }
  const close = pattern.indexOf('}', open + 1)
  if (close === -1) {
    return [pattern]
  }
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const parts = pattern.slice(open + 1, close).split(',')
  if (parts.length < 2) {
    // Nothing to expand: keep this group literal and resume scanning after it
    // (scanning from `close + 1` guarantees progress on degenerate groups).
    const rest = expandBracesFrom(pattern, close + 1, remaining)
    return rest.map((candidate) => pattern.slice(0, close + 1) + candidate)
  }
  const alternatives: string[] = []
  for (const part of parts) {
    if (alternatives.length >= remaining) {
      break
    }
    alternatives.push(
      ...expandBracesFrom(`${prefix}${part}${suffix}`, 0, remaining - alternatives.length)
    )
  }
  return alternatives
}

// Compiles one glob segment (`*`, `?`, `[...]`, literals) into an anchored
// case-sensitive matcher with the same segment semantics as `globSync`.
function compileSegmentMatcher(segment: string): RegExp {
  let source = '^'
  let index = 0
  while (index < segment.length) {
    const char = segment[index]
    if (char === '*') {
      source += '[^/\\\\]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/\\\\]'
      index += 1
      continue
    }
    if (char === '[') {
      const closing = findCharClassEnd(segment, index)
      if (closing === undefined) {
        // Unterminated class: globSync treats the bracket as a literal too.
        source += '\\['
        index += 1
        continue
      }
      source += compileCharClass(segment.slice(index + 1, closing))
      index = closing + 1
      continue
    }
    source += escapeRegExpChar(char)
    index += 1
  }
  return new RegExp(`${source}$`)
}

function findCharClassEnd(segment: string, open: number): number | undefined {
  let index = open + 1
  // A leading `!`, `^`, or `]` belongs to the class header, not its members.
  if (segment[index] === '!' || segment[index] === '^' || segment[index] === ']') {
    index += 1
  }
  while (index < segment.length) {
    if (segment[index] === ']') {
      return index
    }
    index += 1
  }
  return undefined
}

function compileCharClass(body: string): string {
  let negated = false
  if (body.startsWith('!')) {
    negated = true
    body = body.slice(1)
  } else if (body.startsWith('^')) {
    // A literal `^` inside a glob class must not become a regex negation.
    body = `\\${body}`
  }
  return `[${negated ? '^' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

function hasGlobPattern(input: string): boolean {
  return /[*?[]/.test(input)
}

function joinGlobPath(dir: string, segment: string, separator: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) {
    return dir + segment
  }
  return dir + separator + segment
}

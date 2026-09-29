import { existsSync, globSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'

// Why: `globSync` enumerates the entire tree before returning, so a broad
// pattern such as `**/*` can synchronously scan unbounded directories on the
// main process before any match cap applies. Matching is therefore delegated
// to `globSync` one directory level at a time, and recursive descent stops
// once the shared entry budget is exhausted.
export const MAX_INCLUDE_GLOB_ENTRIES = 4096

const GLOB_ROOT_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|[\\/])/

export function globIncludePattern(pattern: string): { matches: string[]; truncated: boolean } {
  const root = pattern.match(GLOB_ROOT_PATTERN)?.[0]
  if (root === undefined) {
    return { matches: globSync(pattern), truncated: false }
  }

  const separator = pattern.includes('\\') ? '\\' : '/'
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
  const matches: string[] = []
  const budget = { remaining: MAX_INCLUDE_GLOB_ENTRIES }
  const completed = collectGlobMatches(root, 0, segments, separator, matches, budget)
  return { matches, truncated: !completed }
}

function collectGlobMatches(
  dir: string,
  segmentIndex: number,
  segments: readonly string[],
  separator: string,
  matches: string[],
  budget: { remaining: number }
): boolean {
  if (segmentIndex === segments.length) {
    matches.push(dir)
    return true
  }

  const segment = segments[segmentIndex]
  if (segment === '**') {
    // A `**` segment also matches zero directories, so the current directory
    // itself still participates in the remaining pattern.
    if (!collectGlobMatches(dir, segmentIndex + 1, segments, separator, matches, budget)) {
      return false
    }

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    budget.remaining -= entries.length
    for (const entry of entries) {
      // Dot entries are skipped to match globSync's default behavior.
      if (entry.name.startsWith('.') || !entry.isDirectory()) {
        continue
      }
      if (
        !collectGlobMatches(
          joinGlobPath(dir, entry.name, separator),
          segmentIndex,
          segments,
          separator,
          matches,
          budget
        )
      ) {
        return false
      }
    }
    return budget.remaining >= 0
  }

  const childPath = joinGlobPath(dir, segment, separator)
  if (!hasGlobPattern(segment)) {
    if (segmentIndex + 1 === segments.length) {
      if (existsSync(childPath)) {
        matches.push(childPath)
      }
      return true
    }
    return collectGlobMatches(childPath, segmentIndex + 1, segments, separator, matches, budget)
  }

  let matched: string[]
  try {
    matched = globSync(childPath)
  } catch {
    return true
  }
  budget.remaining -= matched.length
  let completed = true
  for (const entry of matched) {
    if (segmentIndex + 1 === segments.length) {
      matches.push(entry)
    } else if (!collectGlobMatches(entry, segmentIndex + 1, segments, separator, matches, budget)) {
      completed = false
      break
    }
  }
  return completed && budget.remaining >= 0
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

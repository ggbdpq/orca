import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { globIncludePattern, MAX_INCLUDE_GLOB_ENTRIES } from './ssh-config-include-glob'

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ssh-include-glob-'))
  cleanupDirs.push(dir)
  return dir
}

describe('globIncludePattern', () => {
  it('bounds discovery of a very wide directory instead of enumerating it whole', () => {
    const root = makeTempTree()
    const wideDir = join(root, 'wide')
    mkdirSync(wideDir)
    // Direct writes (hard links cap out around 1023 per file on NTFS).
    const totalEntries = MAX_INCLUDE_GLOB_ENTRIES + 400
    const confStride = 500
    for (let index = 0; index < totalEntries; index += 1) {
      writeFileSync(join(wideDir, `entry-${String(index).padStart(5, '0')}.txt`), 'x')
      if (index % confStride === 0) {
        writeFileSync(join(wideDir, `cfg-${String(index).padStart(5, '0')}.conf`), 'Host x')
      }
    }

    const { matches, truncated, truncatedAt } = globIncludePattern(
      `${wideDir.replace(/\\/g, '/')}/*.conf`
    )

    expect(truncated).toBe(true)
    expect(truncatedAt).toBe(wideDir.replace(/\\/g, '/'))
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThan(totalEntries / confStride + 1)
    for (const match of matches) {
      expect(match.endsWith('.conf')).toBe(true)
    }
  })

  it('keeps file matches for a trailing recursive glob', () => {
    const root = makeTempTree()
    const confDir = join(root, 'conf.d')
    mkdirSync(confDir)
    writeFileSync(join(confDir, 'main.conf'), 'Host main')
    writeFileSync(join(confDir, 'extra.conf'), 'Host extra')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/conf.d/**`)

    expect(matches.some((entry) => entry.endsWith('main.conf'))).toBe(true)
    expect(matches.some((entry) => entry.endsWith('extra.conf'))).toBe(true)
  })

  it('expands brace alternatives in the last segment', () => {
    const root = makeTempTree()
    // makeTempTree already created the directory.
    writeFileSync(join(root, 'main.conf'), 'Host main')
    writeFileSync(join(root, 'extra.conf'), 'Host extra')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/{main,extra}.conf`)

    expect(matches.some((entry) => entry.endsWith('main.conf'))).toBe(true)
    expect(matches.some((entry) => entry.endsWith('extra.conf'))).toBe(true)
  })

  it('does not let the entry budget hide brace matches', () => {
    const root = makeTempTree()
    const subDir = join(root, 'sub')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 'main.conf'), 'Host main')
    writeFileSync(join(subDir, 'extra.conf'), 'Host extra')

    const { matches, truncated } = globIncludePattern(
      `${root.replace(/\\/g, '/')}/*/{main,extra}.conf`
    )

    expect(truncated).toBe(false)
    expect(matches.some((entry) => entry.endsWith('main.conf'))).toBe(true)
    expect(matches.some((entry) => entry.endsWith('extra.conf'))).toBe(true)
  })
})

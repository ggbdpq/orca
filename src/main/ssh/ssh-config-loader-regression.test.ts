import type * as FsModule from 'node:fs'
import type * as OsModule from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('fs')
  vi.doUnmock('os')
})

function normalizeWin(value: string): string {
  return win32.normalize(value.replaceAll('/', '\\'))
}

function platformSshHome(): string {
  return process.platform === 'win32' ? 'C:\\Users\\testuser' : '/home/testuser'
}

function platformSshPath(home: string, relativePath: string): string {
  return process.platform === 'win32'
    ? normalizeWin(`${home}/${relativePath}`)
    : `${home}/${relativePath}`
}

async function mockOs(
  home: string,
  username = 'testuser',
  uid = 1001,
  hostname = 'host.example.com'
) {
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof OsModule>('os')
    return {
      ...actual,
      homedir: () => home,
      hostname: () => hostname,
      userInfo: () => ({ username, uid })
    }
  })
}

async function loadUserSshConfig() {
  const mod = await import('./ssh-config-parser')
  return mod.loadUserSshConfig()
}

describe('loadUserSshConfig regressions', () => {
  it('supports Windows-style home paths and include separators', async () => {
    const files = new Map<string, string>([
      [
        normalizeWin('C:/Users/Test User/.ssh/config'),
        'Include .\\conf.d\\*.conf "C:\\Users\\Test User\\quoted configs\\team.conf" forward/slash.conf'
      ],
      [
        normalizeWin('C:/Users/Test User/.ssh/conf.d/zeta.conf'),
        'Host zeta\n  HostName zeta.example.com\n'
      ],
      [
        normalizeWin('C:/Users/Test User/.ssh/conf.d/alpha.conf'),
        'Host alpha\n  HostName alpha.example.com\n'
      ],
      [
        normalizeWin('C:/Users/Test User/quoted configs/team.conf'),
        'Host team\n  HostName team.example.com\n'
      ],
      [
        normalizeWin('C:/Users/Test User/.ssh/forward/slash.conf'),
        'Host forward\n  HostName forward.example.com\n'
      ]
    ])

    await mockOs('C:\\Users\\Test User', 'TestUser', -1, 'winbox.example.com')
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) => files.has(normalizeWin(filePath)),
        globSync: (pattern: string) =>
          normalizeWin(pattern) === normalizeWin('C:/Users/Test User/.ssh/conf.d/*.conf')
            ? [
                normalizeWin('C:/Users/Test User/.ssh/conf.d/alpha.conf'),
                normalizeWin('C:/Users/Test User/.ssh/conf.d/zeta.conf')
              ]
            : [],
        readFileSync: (filePath: string) => {
          const content = files.get(normalizeWin(filePath))
          if (content === undefined) {
            throw new Error(`ENOENT: ${filePath}`)
          }
          return content
        },
        realpathSync: Object.assign((filePath: string) => normalizeWin(filePath), {
          native: (filePath: string) => normalizeWin(filePath)
        }),
        statSync: (filePath: string) => {
          const content = files.get(normalizeWin(filePath))
          if (content === undefined) {
            throw new Error(`ENOENT: ${filePath}`)
          }
          return { isFile: () => true, size: content.length }
        }
      }
    })

    const hosts = await loadUserSshConfig()
    expect(hosts.map((host) => host.host)).toEqual(['alpha', 'zeta', 'team', 'forward'])
  })

  it('preserves quoted Windows include paths with native backslashes and spaces', async () => {
    const files = new Map<string, string>([
      [
        normalizeWin('C:/Users/Test User/.ssh/config'),
        'Include "C:\\Users\\Test User\\quoted configs\\team.conf"'
      ],
      [
        normalizeWin('C:/Users/Test User/quoted configs/team.conf'),
        'Host team\n  HostName team.example.com\n'
      ]
    ])

    await mockOs('C:\\Users\\Test User', 'TestUser', -1, 'winbox.example.com')
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) => files.has(normalizeWin(filePath)),
        readFileSync: (filePath: string) => {
          const content = files.get(normalizeWin(filePath))
          if (content === undefined) {
            throw new Error(`ENOENT: ${filePath}`)
          }
          return content
        },
        realpathSync: Object.assign((filePath: string) => normalizeWin(filePath), {
          native: (filePath: string) => normalizeWin(filePath)
        }),
        statSync: (filePath: string) => {
          const content = files.get(normalizeWin(filePath))
          if (content === undefined) {
            throw new Error(`ENOENT: ${filePath}`)
          }
          return { isFile: () => true, size: content.length }
        }
      }
    })

    expect(await loadUserSshConfig()).toEqual([{ host: 'team', hostname: 'team.example.com' }])
  })

  it('skips non-regular include targets without reading them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const unsafePath = platformSshPath(home, '.ssh/unsafe.conf')
    const safePath = platformSshPath(home, '.ssh/safe.conf')
    const unsafeReadSpy = vi.fn()

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || filePath === unsafePath || filePath === safePath,
        readFileSync: (filePath: string) => {
          if (filePath === unsafePath) {
            unsafeReadSpy()
            throw new Error(`unexpected read: ${filePath}`)
          }
          if (filePath === configPath) {
            return 'Include unsafe.conf safe.conf\n'
          }
          if (filePath === safePath) {
            return 'Host safe\n  HostName safe.example.com\n'
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({ isFile: () => filePath !== unsafePath, size: 64 })
      }
    })

    expect(await loadUserSshConfig()).toEqual([{ host: 'safe', hostname: 'safe.example.com' }])
    expect(unsafeReadSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping SSH config include'))
  })

  it('caps overly broad include globs and skips the remainder', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const includePaths = Array.from({ length: 2000 }, (_, index) => {
      return platformSshPath(home, `.ssh/conf.d/${String(index).padStart(4, '0')}.conf`)
    })
    const readPaths = new Set<string>()

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || includePaths.includes(filePath),
        globSync: () => [...includePaths].toReversed(),
        readFileSync: (filePath: string) => {
          if (filePath === configPath) {
            return 'Include conf.d/*.conf\n'
          }
          if (includePaths.includes(filePath)) {
            readPaths.add(filePath)
            const alias = filePath.match(/(\d+)\.conf$/)?.[1] ?? 'unknown'
            return `Host host-${alias}\n  HostName ${alias}.example.com\n`
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({
          isFile: () => filePath === configPath || includePaths.includes(filePath),
          size: 64
        })
      }
    })

    const hosts = await loadUserSshConfig()
    expect(hosts.length).toBeGreaterThan(0)
    expect(hosts.length).toBeLessThan(includePaths.length)
    expect(readPaths.has(includePaths.at(-1)!)).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matched'))
  })

  it('skips oversized include files without reading them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const oversizedPath = platformSshPath(home, '.ssh/oversized.conf')
    const safePath = platformSshPath(home, '.ssh/safe.conf')
    const oversizedReadSpy = vi.fn()

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || filePath === oversizedPath || filePath === safePath,
        readFileSync: (filePath: string) => {
          if (filePath === oversizedPath) {
            oversizedReadSpy()
            throw new Error(`unexpected read: ${filePath}`)
          }
          if (filePath === configPath) {
            return 'Include oversized.conf safe.conf\n'
          }
          if (filePath === safePath) {
            return 'Host safe\n  HostName safe.example.com\n'
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({
          isFile: () => true,
          size: filePath === oversizedPath ? 2 * 1024 * 1024 : 64
        })
      }
    })

    expect(await loadUserSshConfig()).toEqual([{ host: 'safe', hostname: 'safe.example.com' }])
    expect(oversizedReadSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds'))
  })

  it('expands recursive include globs across nested directories', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = mkdtempSync(join(tmpdir(), 'orca-ssh-include-glob-'))
    try {
      const confDir = join(home, '.ssh', 'conf.d')
      mkdirSync(join(confDir, 'nested'), { recursive: true })
      writeFileSync(join(home, '.ssh', 'config'), 'Include ~/.ssh/conf.d/**/*.conf\n')
      writeFileSync(join(confDir, 'alpha.conf'), 'Host alpha\n  HostName alpha.example.com\n')
      writeFileSync(
        join(confDir, 'nested', 'gamma.conf'),
        'Host gamma\n  HostName gamma.example.com\n'
      )

      await mockOs(home)

      expect(await loadUserSshConfig()).toEqual([
        { host: 'alpha', hostname: 'alpha.example.com' },
        { host: 'gamma', hostname: 'gamma.example.com' }
      ])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('bounds discovery of recursive include globs on large trees', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const treeRoot = platformSshPath(home, '.ssh/tree')
    const treeSeparator = treeRoot.includes('\\') ? '\\' : '/'
    const joinTree = (parent: string, name: string) => `${parent}${treeSeparator}${name}`

    const dirNames = Array.from(
      { length: 80 },
      (_, index) => `level-${String(index).padStart(2, '0')}`
    )
    const fillersPerDir = 300
    const dirEntries = new Map<string, { dirs: string[]; confs: string[]; fillerCount: number }>()
    dirEntries.set(treeRoot, { dirs: dirNames, confs: [], fillerCount: 0 })
    const allConfPaths: string[] = []
    for (const dirName of dirNames) {
      const dir = joinTree(treeRoot, dirName)
      const confName = `a-${dirName}.conf`
      dirEntries.set(dir, { dirs: [], confs: [confName], fillerCount: fillersPerDir })
      allConfPaths.push(joinTree(dir, confName))
    }
    const totalTreeEntries = dirNames.length * (fillersPerDir + 1) + dirNames.length
    let listed = 0

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || allConfPaths.includes(filePath),
        globSync: (pattern: string) => {
          const separatorIndex = Math.max(pattern.lastIndexOf('\\'), pattern.lastIndexOf('/'))
          const dir = pattern.slice(0, separatorIndex)
          const segment = pattern.slice(separatorIndex + 1)
          const info = dirEntries.get(dir)
          if (!info) {
            // Simulates the unbounded enumeration of a single broad glob call.
            listed += totalTreeEntries
            return [...allConfPaths].toReversed()
          }
          const names = [...info.dirs, ...info.confs]
          listed += names.length + info.fillerCount
          if (segment === '*.conf') {
            return names.filter((name) => name.endsWith('.conf')).map((name) => joinTree(dir, name))
          }
          return []
        },
        readdirSync: (dir: string) => {
          const info = dirEntries.get(dir)
          if (!info) {
            throw new Error(`ENOENT: ${dir}`)
          }
          const fillerNames = Array.from(
            { length: info.fillerCount },
            (_, index) => `filler-${String(index).padStart(3, '0')}.txt`
          )
          const entries = [
            ...info.dirs.map((name) => ({
              name,
              isDirectory: () => true,
              isFile: () => false,
              parentPath: dir
            })),
            ...info.confs.map((name) => ({
              name,
              isDirectory: () => false,
              isFile: () => true,
              parentPath: dir
            })),
            ...fillerNames.map((name) => ({
              name,
              isDirectory: () => false,
              isFile: () => true,
              parentPath: dir
            }))
          ]
          listed += entries.length
          return entries
        },
        readFileSync: (filePath: string) => {
          if (filePath === configPath) {
            return 'Include ~/.ssh/tree/**/*.conf\n'
          }
          if (allConfPaths.includes(filePath)) {
            const confName = filePath.slice(filePath.lastIndexOf(treeSeparator) + 1)
            return `Host ${confName.replace(/\.conf$/, '')}\n  HostName ${confName}.example.com\n`
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({
          isFile: () => filePath === configPath || allConfPaths.includes(filePath),
          size: 64
        })
      }
    })

    const hosts = await loadUserSshConfig()
    expect(hosts.length).toBeGreaterThan(0)
    expect(hosts.length).toBeLessThan(dirNames.length)
    expect(listed).toBeLessThan(totalTreeEntries)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stopped after'))
  })
})

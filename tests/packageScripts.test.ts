import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package scripts', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }

  it('switches better-sqlite3 ABI for Electron dev and Node tests', () => {
    expect(pkg.scripts['rebuild:electron']).toContain('electron-rebuild -f -w better-sqlite3')
    expect(pkg.scripts.dev).toMatch(/npm run rebuild:electron.*electron \./)
    expect(pkg.scripts['rebuild:node']).toContain('npm rebuild better-sqlite3')
    expect(pkg.scripts.test).toMatch(/npm run rebuild:node.*vitest run/)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package scripts', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    build?: {
      nsis?: Record<string, unknown>
    }
  }

  it('switches better-sqlite3 ABI for Electron dev and Node tests', () => {
    expect(pkg.scripts['rebuild:electron']).toContain('electron-rebuild -f -w better-sqlite3')
    expect(pkg.scripts.dev).toMatch(/npm run rebuild:electron.*electron \./)
    expect(pkg.scripts['rebuild:node']).toContain('npm rebuild better-sqlite3')
    expect(pkg.scripts.test).toMatch(/npm run rebuild:node.*vitest run/)
    expect(pkg.scripts.pack).toMatch(/npm run rebuild:electron.*electron-builder --dir/)
    expect(pkg.scripts.dist).toMatch(/npm run rebuild:electron.*electron-builder/)
  })

  it('builds an assisted NSIS installer with optional AppData cleanup on uninstall', () => {
    expect(pkg.build?.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Easy Music',
      artifactName: 'Easy-Music-Setup-${version}.${ext}',
      include: 'build/installer.nsh',
    })
    expect(pkg.build?.nsis).not.toHaveProperty('deleteAppDataOnUninstall')

    const installerInclude = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    expect(installerInclude).toContain('!macro customUnInstall')
    expect(installerInclude).toContain('MessageBox MB_YESNO')
    expect(installerInclude).toContain('SetShellVarContext current')
    expect(installerInclude).toContain('RMDir /r "$APPDATA\\easy-music"')
    expect(installerInclude).toContain('SetShellVarContext all')
  })
})

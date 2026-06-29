import { describe, expect, it, vi } from 'vitest'
import { closeExplorerWindowsForPaths } from '../src/main/core/windowsExplorer'

describe('windows explorer window closing', () => {
  it('skips non-Windows platforms', () => {
    const runPowerShell = vi.fn()

    const result = closeExplorerWindowsForPaths(['C:\\Music\\Artist'], {
      platform: 'linux',
      runPowerShell,
    })

    expect(result).toEqual({ closedPaths: [], errors: [] })
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('passes target folders to PowerShell and returns closed Explorer paths', () => {
    const runPowerShell = vi.fn().mockReturnValue('["C:\\\\Music\\\\Artist","C:\\\\Music\\\\Artist\\\\Album"]')

    const result = closeExplorerWindowsForPaths(['C:\\Music\\Artist', 'C:\\Music\\Artist'], {
      platform: 'win32',
      runPowerShell,
    })

    expect(result.closedPaths).toEqual(['C:\\Music\\Artist', 'C:\\Music\\Artist\\Album'])
    expect(result.errors).toEqual([])
    expect(runPowerShell).toHaveBeenCalledTimes(1)
    expect(runPowerShell.mock.calls[0][0]).toContain('"C:\\\\Music\\\\Artist"')
  })

  it('can close parent Explorer windows by exact path without matching sibling folders', () => {
    const runPowerShell = vi.fn().mockReturnValue('["C:\\\\Music"]')

    closeExplorerWindowsForPaths(['C:\\Music\\Artist'], {
      platform: 'win32',
      exactPaths: ['C:\\Music'],
      runPowerShell,
    })

    const script = runPowerShell.mock.calls[0][0]
    expect(script).toContain('"treeTargets":["C:\\\\Music\\\\Artist"]')
    expect(script).toContain('"exactTargets":["C:\\\\Music"]')
    expect(script).toContain('$normalizedExactTargets')
  })

  it('returns close errors instead of blocking folder normalization', () => {
    const runPowerShell = vi.fn(() => {
      throw new Error('PowerShell blocked')
    })

    const result = closeExplorerWindowsForPaths(['C:\\Music\\Artist'], {
      platform: 'win32',
      runPowerShell,
    })

    expect(result.closedPaths).toEqual([])
    expect(result.errors.join('\n')).toContain('PowerShell blocked')
  })
})

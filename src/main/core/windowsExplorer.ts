import { execFileSync } from 'node:child_process'

export interface CloseExplorerWindowsResult {
  closedPaths: string[]
  errors: string[]
}

export interface CloseExplorerWindowsOptions {
  platform?: NodeJS.Platform
  exactPaths?: string[]
  runPowerShell?: (script: string) => string
}

export function closeExplorerWindowsForPaths(paths: string[], options: CloseExplorerWindowsOptions = {}): CloseExplorerWindowsResult {
  const platform = options.platform || process.platform
  const treeTargets = Array.from(new Set(paths.map((item) => item.trim()).filter(Boolean)))
  const exactTargets = Array.from(new Set((options.exactPaths || []).map((item) => item.trim()).filter(Boolean)))
  if (platform !== 'win32' || (!treeTargets.length && !exactTargets.length)) return { closedPaths: [], errors: [] }

  try {
    const output = (options.runPowerShell || runPowerShell)(buildCloseExplorerScript(treeTargets, exactTargets))
    return { closedPaths: parseClosedExplorerPaths(output), errors: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { closedPaths: [], errors: [message] }
  }
}

function runPowerShell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
}

function buildCloseExplorerScript(treeTargets: string[], exactTargets: string[]): string {
  const json = JSON.stringify({ treeTargets, exactTargets })
  return `
$ErrorActionPreference = 'Stop'
$payload = ConvertFrom-Json @'
${json}
'@
function Normalize-ExplorerPath([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  try {
    return ([System.IO.Path]::GetFullPath($value)).TrimEnd('\\\\').ToLowerInvariant()
  } catch {
    return ''
  }
}
$normalizedTreeTargets = @($payload.treeTargets | ForEach-Object { Normalize-ExplorerPath $_ } | Where-Object { $_ })
$normalizedExactTargets = @($payload.exactTargets | ForEach-Object { Normalize-ExplorerPath $_ } | Where-Object { $_ })
$shell = New-Object -ComObject Shell.Application
$closed = New-Object System.Collections.Generic.List[string]
foreach ($window in @($shell.Windows())) {
  try {
    $windowPath = ''
    if ($window.Document -and $window.Document.Folder -and $window.Document.Folder.Self) {
      $windowPath = [string]$window.Document.Folder.Self.Path
    }
    if (-not $windowPath -and $window.LocationURL) {
      $uri = [System.Uri]$window.LocationURL
      if ($uri.IsFile) { $windowPath = [System.Uri]::UnescapeDataString($uri.LocalPath) }
    }
    $normalizedWindowPath = Normalize-ExplorerPath $windowPath
    if (-not $normalizedWindowPath) { continue }
    $shouldClose = $false
    foreach ($target in $normalizedExactTargets) {
      if ($normalizedWindowPath -eq $target) {
        $shouldClose = $true
        break
      }
    }
    if (-not $shouldClose) {
      foreach ($target in $normalizedTreeTargets) {
        if ($normalizedWindowPath -eq $target -or $normalizedWindowPath.StartsWith($target + '\\\\')) {
          $shouldClose = $true
          break
        }
      }
    }
    if ($shouldClose) {
      [void]$closed.Add($windowPath)
      $window.Quit()
    }
  } catch {
  }
}
$closed | ConvertTo-Json -Compress
`.trim()
}

function parseClosedExplorerPaths(output: string): string[] {
  const text = output.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as string | string[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

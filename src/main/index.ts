import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, type OpenDialogOptions } from 'electron'
import path from 'node:path'
import { AppServices } from './appServices'

let mainWindow: BrowserWindow | null = null
let services: AppServices | null = null
let tray: Tray | null = null
let isQuitting = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Easy Music',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  return win
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Easy Music')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => mainWindow?.show() },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]))
  tray.on('double-click', () => mainWindow?.show())
}

function registerIpc(service: AppServices): void {
  ipcMain.handle('artist:fetchAlbums', async (_event, name: string) => {
    return service.fetchArtistAlbums(name, (progress) => {
      mainWindow?.webContents.send('artist:fetchProgress', progress)
    })
  })
  ipcMain.handle('playlist:list', () => service.listPlaylists())
  ipcMain.handle('playlist:songs', (_event, id: string) => service.listPlaylistSongs(id))
  ipcMain.handle('playlist:delete', (_event, id: string) => service.deletePlaylist(id))
  ipcMain.handle('artist:delete', (_event, artistName: string) => service.deleteArtist(artistName))
  ipcMain.handle('playlist:removeSongs', (_event, payload: { playlistId: string; songIds: string[] }) => service.removeSongsFromPlaylist(payload.playlistId, payload.songIds))

  ipcMain.handle('download:create', (_event, payload: { playlistId: string; songIds?: string[] }) => service.createDownloadTasks(payload.playlistId, payload.songIds || []))
  ipcMain.handle('download:start', (_event, ids?: string[]) => service.startDownloads(ids || []))
  ipcMain.handle('download:pause', () => service.pauseDownloads())
  ipcMain.handle('download:remove', (_event, ids: string[]) => service.removeDownloadTasks(ids || []))
  ipcMain.handle('download:removeAll', () => service.removeAllDownloadTasks())
  ipcMain.handle('download:list', () => service.listDownloadTasks())

  ipcMain.handle('convert:scan', (_event, payload: { sourceDir: string; outputDir: string }) => service.scanFlacConversions(payload.sourceDir, payload.outputDir))
  ipcMain.handle('convert:start', (_event, payload: { sourceDir: string; outputDir: string; bitrate: string; overwrite?: boolean }) => service.startFlacConversions(payload))
  ipcMain.handle('convert:cancel', () => service.cancelFlacConversions())
  ipcMain.handle('convert:list', () => service.listFlacConversions())

  ipcMain.handle('source:import', (_event, script: string) => service.importSource(script))
  ipcMain.handle('source:list', () => service.listSources())
  ipcMain.handle('source:enable', (_event, id: string) => service.enableSource(id))
  ipcMain.handle('source:test', (_event, id: string) => service.testSource(id))
  ipcMain.handle('source:delete', (_event, id: string) => service.deleteSource(id))

  ipcMain.handle('settings:get', (_event, key: string, fallback = '') => service.getSetting(key, fallback))
  ipcMain.handle('settings:set', (_event, key: string, value: string) => service.setSetting(key, value))
  ipcMain.handle('settings:chooseDownloadRoot', async () => {
    const options: OpenDialogOptions = {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return service.getSetting('downloadRoot')
    service.setSetting('downloadRoot', result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('settings:chooseDirectory', async (_event, title: string) => {
    const options: OpenDialogOptions = {
      title,
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return ''
    return result.filePaths[0]
  })
}

void app.whenReady().then(() => {
  services = new AppServices(app.getPath('userData'))
  registerIpc(services)
  mainWindow = createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    else mainWindow?.show()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep the tray process alive so downloads can continue after closing the window.
  }
})

app.on('quit', () => {
  services?.close()
  services = null
  tray = null
})

import { contextBridge, ipcRenderer } from 'electron'
import type { FetchProgress } from '../main/appServices'

const api = {
  fetchArtistAlbums: (name: string) => ipcRenderer.invoke('artist:fetchAlbums', name),
  onFetchProgress: (handler: (progress: FetchProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: FetchProgress) => handler(progress)
    ipcRenderer.on('artist:fetchProgress', listener)
    return () => ipcRenderer.removeListener('artist:fetchProgress', listener)
  },

  listPlaylists: () => ipcRenderer.invoke('playlist:list'),
  listPlaylistSongs: (id: string) => ipcRenderer.invoke('playlist:songs', id),
  deletePlaylist: (id: string) => ipcRenderer.invoke('playlist:delete', id),
  deleteArtist: (artistName: string) => ipcRenderer.invoke('artist:delete', artistName),
  removeSongsFromPlaylist: (playlistId: string, songIds: string[]) => ipcRenderer.invoke('playlist:removeSongs', { playlistId, songIds }),

  createDownloadTasks: (playlistId: string, songIds: string[] = []) => ipcRenderer.invoke('download:create', { playlistId, songIds }),
  startDownloads: (ids: string[] = []) => ipcRenderer.invoke('download:start', ids),
  pauseDownloads: () => ipcRenderer.invoke('download:pause'),
  removeDownloadTasks: (ids: string[]) => ipcRenderer.invoke('download:remove', ids),
  removeAllDownloadTasks: () => ipcRenderer.invoke('download:removeAll'),
  listDownloadTasks: () => ipcRenderer.invoke('download:list'),

  scanArtistFolders: (root: string) => ipcRenderer.invoke('folder:scan', root),
  normalizeArtistFolders: (root: string, folderNames: string[]) => ipcRenderer.invoke('folder:normalize', { root, folderNames }),
  openFolderPath: (targetPath: string) => ipcRenderer.invoke('folder:open', targetPath),

  scanFlacConversions: (sourceDir: string) => ipcRenderer.invoke('convert:scan', { sourceDir }),
  startFlacConversions: (payload: { sourceDir: string; bitrate: string; overwrite?: boolean }) => ipcRenderer.invoke('convert:start', payload),
  cancelFlacConversions: () => ipcRenderer.invoke('convert:cancel'),
  listFlacConversions: () => ipcRenderer.invoke('convert:list'),
  getFlacConversionResult: () => ipcRenderer.invoke('convert:result'),

  importSource: (script: string) => ipcRenderer.invoke('source:import', script),
  listSources: () => ipcRenderer.invoke('source:list'),
  enableSource: (id: string) => ipcRenderer.invoke('source:enable', id),
  testSource: (id: string) => ipcRenderer.invoke('source:test', id),
  deleteSource: (id: string) => ipcRenderer.invoke('source:delete', id),

  getSetting: (key: string, fallback = '') => ipcRenderer.invoke('settings:get', key, fallback),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  chooseDownloadRoot: () => ipcRenderer.invoke('settings:chooseDownloadRoot'),
  chooseDirectory: (title: string) => ipcRenderer.invoke('settings:chooseDirectory', title),
}

contextBridge.exposeInMainWorld('easyMusic', api)

export type EasyMusicApi = typeof api

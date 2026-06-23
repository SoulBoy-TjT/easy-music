export type Platform = 'kw' | 'kg' | 'tx' | 'wy' | string
export type Quality = 'flac24bit' | 'flac' | '320k' | '128k' | string
export type DownloadStatus = 'waiting' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

export interface Song {
  id: string
  platform: Platform
  platformSongId: string
  title: string
  artist: string
  albumId: string
  albumName: string
  duration: number
  trackNo: number
  coverUrl?: string
  qualitys: Quality[]
  raw: Record<string, unknown>
}

export interface Album {
  id: string
  platform: Platform
  platformAlbumId: string
  artistName: string
  name: string
  publishDate: string
  songCount: number
  coverUrl?: string
  songs: Song[]
  raw: Record<string, unknown>
}

export interface Playlist {
  id: string
  name: string
  kind: 'total' | 'platform'
  artistName: string
  platform?: Platform | null
  createdAt: number
  updatedAt: number
}

export interface CandidateSource {
  platform: Platform
  songId: string
  qualitys: Quality[]
  song: Song
}

export interface PlaylistSongRow {
  id: string
  position: number
  song: Song
  candidateSources: CandidateSource[]
}

export interface MergedAlbumInfo {
  title: string
  albumName: string
  publishDate: string
  platform: Platform
  songCount: number
  reason: string
  songs: string[]
}

export interface AlbumSongNode {
  id: string
  title: string
  albumName: string
  publishDate: string
  platform: Platform
  deleteSongIds: string[]
  mergedAlbums: MergedAlbumInfo[]
  children: Array<{
    id: string
    songId: string
    title: string
    song: Song
  }>
}

export interface DownloadRequest {
  url: string
  method?: string
  headers?: Record<string, string>
}

export interface DownloadTask {
  id: string
  playlistId: string
  playlistArtistName: string
  song: Song
  quality: Quality
  status: DownloadStatus
  statusText: string
  speed: string
  downloaded: number
  total: number
  filePath: string
  error: string
  createdAt: number
  updatedAt: number
}

export interface DownloadStore {
  listDownloadTasks(statuses?: DownloadStatus[]): DownloadTask[]
  createDownloadTask(playlistId: string, playlistArtistName: string, song: Song, quality: Quality): string
  updateDownloadTask(id: string, updates: Partial<DownloadTask>): void
}

export interface UrlResolver {
  requestMusicUrl(platform: Platform, musicInfo: Record<string, unknown>, quality: Quality, refresh?: boolean): Promise<DownloadRequest | string>
  requestLyric(platform: Platform, musicInfo: Record<string, unknown>): Promise<Lyrics | null>
  requestPic(platform: Platform, musicInfo: Record<string, unknown>): Promise<string | null>
  searchSongs?(query: string, platforms: Platform[], limit: number): Promise<Song[]>
}

export interface Lyrics {
  lyric?: string
  tlyric?: string
  translated?: string
  rlyric?: string
  romanized?: string
  lxlyric?: string
}

export const PLATFORM_LABELS: Record<string, string> = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
}

export const PLATFORM_PRIORITY: Record<string, number> = {
  kg: 0,
  tx: 1,
  wy: 2,
  kw: 3,
}

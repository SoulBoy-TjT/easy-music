import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isReusableDownloadedAudioFile } from './audioValidation'
import { extForQuality } from './naming'
import type { DownloadStatus, DownloadStore, DownloadTask, Quality, Song } from './types'

interface State {
  downloadTasks: DownloadTask[]
}

export class JsonStore implements DownloadStore {
  private state: State

  constructor(private readonly filePath: string) {
    this.state = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8')) as State
      : { downloadTasks: [] }
  }

  createDownloadTask(playlistId: string, playlistArtistName: string, song: Song, quality: Quality): string {
    const id = `download:${playlistId}:${song.id}:${song.platform}:${quality}`
    const now = Date.now()
    const existing = this.state.downloadTasks.find((task) => task.id === id)
    if (existing?.status === 'success') {
      if (isReusableDownloadedAudioFile(existing.filePath, extForQuality(quality))) {
        existing.playlistArtistName = playlistArtistName
        existing.song = song
        existing.quality = quality
        existing.updatedAt = now
        this.persist()
        return id
      }
      if (existing.filePath) rmSync(existing.filePath, { force: true })
    }
    const task: DownloadTask = {
      id,
      playlistId,
      playlistArtistName,
      song,
      quality,
      status: 'waiting',
      statusText: '等待下载',
      speed: '',
      downloaded: 0,
      total: 0,
      filePath: '',
      error: '',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    if (existing) Object.assign(existing, task)
    else this.state.downloadTasks.push(task)
    this.persist()
    return id
  }

  listDownloadTasks(statuses?: DownloadStatus[]): DownloadTask[] {
    const tasks = statuses?.length
      ? this.state.downloadTasks.filter((task) => statuses.includes(task.status))
      : this.state.downloadTasks
    return tasks.map((task) => structuredClone(task))
  }

  updateDownloadTask(id: string, updates: Partial<DownloadTask>): void {
    const task = this.state.downloadTasks.find((item) => item.id === id)
    if (!task) return
    Object.assign(task, updates, { updatedAt: Date.now() })
    this.persist()
  }

  pauseActiveDownloadTasks(): void {
    for (const task of this.state.downloadTasks) {
      if (task.status === 'waiting' || task.status === 'running') {
        Object.assign(task, { status: 'cancelled', statusText: '已暂停', speed: '', updatedAt: Date.now() })
      }
    }
    this.persist()
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
  }
}

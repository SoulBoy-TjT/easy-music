<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface PlaylistSummary {
  id: string
  name: string
  kind: 'total' | 'platform'
  artistName: string
  platform?: string | null
  songCount: number
  albumCount: number
}

interface SongRow {
  id: string
  position: number
  candidateSources: CandidateSource[]
  song: {
    id: string
    title: string
    artist: string
    albumName: string
    platform: string
    duration: number
    trackNo: number
  }
}

interface CandidateSource {
  platform: string
  songId: string
  qualitys: string[]
  song: SongRow['song']
}

interface MergedAlbumInfo {
  title: string
  albumName: string
  publishDate: string
  platform: string
  songCount: number
  reason: string
  songs: string[]
}

interface AlbumNode {
  id: string
  title: string
  albumName: string
  publishDate: string
  platform: string
  deleteSongIds: string[]
  mergedAlbums: MergedAlbumInfo[]
  children: Array<{ id: string; songId: string; title: string; song: SongRow['song'] }>
}

interface DownloadTask {
  id: string
  song: SongRow['song']
  status: string
  statusText: string
  speed: string
  downloaded: number
  total: number
  error: string
}

interface SourceInfo {
  id: string
  name: string
  enabled: boolean
  sources: Record<string, unknown>
}

interface ConvertTask {
  id: string
  sourcePath: string
  outputPath: string
  status: string
  statusText: string
  progress: number
  error: string
}

interface MenuItem {
  label: string
  action: () => void | Promise<void>
  danger?: boolean
}

type PageKey = 'albums' | 'downloads' | 'sources' | 'converter'

const artistName = ref('')
const playlists = ref<PlaylistSummary[]>([])
const rows = ref<SongRow[]>([])
const albums = ref<AlbumNode[]>([])
const tasks = ref<DownloadTask[]>([])
const sources = ref<SourceInfo[]>([])
const convertTasks = ref<ConvertTask[]>([])
const selectedPlaylistId = ref('')
const selectedPlaylist = computed(() => playlists.value.find((item) => item.id === selectedPlaylistId.value) || null)
const expandedArtists = ref(new Set<string>())
const songViewMode = ref<'flat' | 'album'>('flat')
const downloadRoot = ref('')
const quality = ref('flac')
const maxConcurrent = ref('3')
const showFailedOnly = ref(false)
const activePage = ref<PageKey>('albums')
const convertSourceDir = ref('')
const convertOutputDir = ref('')
const convertBitrate = ref('320k')
const convertOverwrite = ref(false)
const progressText = ref('等待抓取')
const progressValue = ref(0)
const fetching = ref(false)
const contextMenu = ref<{ visible: boolean; x: number; y: number; items: MenuItem[] }>({ visible: false, x: 0, y: 0, items: [] })
const mergedAlbumAudit = ref<AlbumNode | null>(null)
let taskTimer: number | undefined
let unsubscribeProgress: (() => void) | undefined

const playlistGroups = computed(() => {
  const map = new Map<string, PlaylistSummary[]>()
  for (const playlist of playlists.value) {
    const list = map.get(playlist.artistName) || []
    list.push(playlist)
    map.set(playlist.artistName, list)
  }
  return Array.from(map.entries()).map(([artist, list]) => ({
    artist,
    list: list.sort((left, right) => playlistOrder(left) - playlistOrder(right)),
  }))
})

const visibleTasks = computed(() => showFailedOnly.value ? tasks.value.filter((task) => task.status === 'failed') : tasks.value)

onMounted(async () => {
  unsubscribeProgress = window.easyMusic.onFetchProgress((progress) => {
    progressText.value = progress.error ? `${progress.message}：${progress.error}` : progress.message
    if (progress.total && progress.current != null) progressValue.value = Math.round((progress.current / progress.total) * 100)
  })
  document.addEventListener('click', hideMenu)
  await loadSettings()
  await refreshAll()
  taskTimer = window.setInterval(refreshLiveData, 1500)
})

onBeforeUnmount(() => {
  unsubscribeProgress?.()
  document.removeEventListener('click', hideMenu)
  if (taskTimer) window.clearInterval(taskTimer)
})

async function loadSettings() {
  downloadRoot.value = await window.easyMusic.getSetting('downloadRoot', '')
  quality.value = await window.easyMusic.getSetting('quality', 'flac')
  maxConcurrent.value = await window.easyMusic.getSetting('maxConcurrent', '3')
  songViewMode.value = await window.easyMusic.getSetting('songViewMode', 'flat') as 'flat' | 'album'
  activePage.value = await window.easyMusic.getSetting('activePage', 'albums') as PageKey
  convertSourceDir.value = await window.easyMusic.getSetting('convertSourceDir', '')
  convertOutputDir.value = await window.easyMusic.getSetting('convertOutputDir', '')
  convertBitrate.value = await window.easyMusic.getSetting('convertBitrate', '320k')
  convertOverwrite.value = await window.easyMusic.getSetting('convertOverwrite', 'false') === 'true'
}

async function refreshAll() {
  playlists.value = await window.easyMusic.listPlaylists()
  tasks.value = await window.easyMusic.listDownloadTasks()
  sources.value = await window.easyMusic.listSources()
  convertTasks.value = await window.easyMusic.listFlacConversions()
  if (selectedPlaylistId.value) await selectPlaylist(selectedPlaylistId.value)
}

async function refreshLiveData() {
  tasks.value = await window.easyMusic.listDownloadTasks()
  if (activePage.value === 'converter') convertTasks.value = await window.easyMusic.listFlacConversions()
}

async function switchPage(page: PageKey) {
  activePage.value = page
  await saveSetting('activePage', page)
  if (page === 'downloads') tasks.value = await window.easyMusic.listDownloadTasks()
  if (page === 'sources') sources.value = await window.easyMusic.listSources()
  if (page === 'converter') convertTasks.value = await window.easyMusic.listFlacConversions()
}

async function fetchAlbums() {
  if (!artistName.value.trim()) return
  fetching.value = true
  progressText.value = '开始抓取'
  progressValue.value = 0
  try {
    const result = await window.easyMusic.fetchArtistAlbums(artistName.value.trim())
    playlists.value = result.playlists
    progressText.value = '抓取完成'
    progressValue.value = 100
  } catch (error) {
    progressText.value = error instanceof Error ? error.message : String(error)
  } finally {
    fetching.value = false
  }
}

async function selectPlaylist(id: string) {
  selectedPlaylistId.value = id
  const result = await window.easyMusic.listPlaylistSongs(id)
  rows.value = result.rows
  albums.value = result.albums
}

function toggleArtist(artist: string) {
  const next = new Set(expandedArtists.value)
  if (next.has(artist)) next.delete(artist)
  else next.add(artist)
  expandedArtists.value = next
}

async function deletePlaylist(playlist: PlaylistSummary) {
  if (!confirm(`删除歌单“${playlistLabel(playlist)}”？只删除本地记录，不删除已下载文件。`)) return
  playlists.value = await window.easyMusic.deletePlaylist(playlist.id)
  if (selectedPlaylistId.value === playlist.id) {
    selectedPlaylistId.value = ''
    rows.value = []
    albums.value = []
  }
}

async function deleteArtist(artist: string) {
  if (!confirm(`删除歌手“${artist}”下的全部歌单？只删除本地记录，不删除已下载文件。`)) return
  const shouldClearSelection = selectedPlaylist.value?.artistName === artist
  playlists.value = await window.easyMusic.deleteArtist(artist)
  const nextExpanded = new Set(expandedArtists.value)
  nextExpanded.delete(artist)
  expandedArtists.value = nextExpanded
  if (shouldClearSelection) {
    selectedPlaylistId.value = ''
    rows.value = []
    albums.value = []
  }
}

async function queueSongs(songIds: string[]) {
  if (!selectedPlaylistId.value) return
  const taskIds = await window.easyMusic.createDownloadTasks(selectedPlaylistId.value, songIds)
  if (taskIds.length) await window.easyMusic.startDownloads(taskIds)
  tasks.value = await window.easyMusic.listDownloadTasks()
}

async function queuePlaylist() {
  if (!selectedPlaylistId.value) return
  const taskIds = await window.easyMusic.createDownloadTasks(selectedPlaylistId.value, [])
  if (taskIds.length) await window.easyMusic.startDownloads(taskIds)
  tasks.value = await window.easyMusic.listDownloadTasks()
}

async function startDownloads(ids: string[] = []) {
  await window.easyMusic.startDownloads(ids)
  tasks.value = await window.easyMusic.listDownloadTasks()
}

async function startVisibleDownloads() {
  if (showFailedOnly.value) {
    const failedIds = visibleTasks.value.filter((task) => task.status === 'failed').map((task) => task.id)
    if (failedIds.length) await startDownloads(failedIds)
    return
  }
  await startDownloads()
}

async function pauseDownloads() {
  tasks.value = await window.easyMusic.pauseDownloads()
}

async function deleteSong(songIds: string[]) {
  if (!selectedPlaylistId.value) return
  if (!confirm('从当前歌单移除选中的歌曲？不会删除本地文件。')) return
  const result = await window.easyMusic.removeSongsFromPlaylist(selectedPlaylistId.value, songIds)
  rows.value = result.rows
  albums.value = result.albums
  playlists.value = await window.easyMusic.listPlaylists()
}

async function removeTask(id: string) {
  if (!confirm('删除该下载任务？只删除下载记录，不删除本地文件。')) return
  tasks.value = await window.easyMusic.removeDownloadTasks([id])
}

async function removeAllTasks() {
  if (!confirm('删除全部下载任务？只删除下载记录，不删除本地文件。')) return
  tasks.value = await window.easyMusic.removeAllDownloadTasks()
}

async function chooseRoot() {
  downloadRoot.value = await window.easyMusic.chooseDownloadRoot()
}

async function saveSetting(key: string, value: string) {
  await window.easyMusic.setSetting(key, value)
}

async function chooseConvertSourceDir() {
  const selected = await window.easyMusic.chooseDirectory('选择 FLAC 来源目录')
  if (!selected) return
  convertSourceDir.value = selected
  await saveSetting('convertSourceDir', selected)
}

async function chooseConvertOutputDir() {
  const selected = await window.easyMusic.chooseDirectory('选择 MP3 输出目录')
  if (!selected) return
  convertOutputDir.value = selected
  await saveSetting('convertOutputDir', selected)
}

async function startFlacConversions() {
  if (!convertSourceDir.value || !convertOutputDir.value) return
  await saveSetting('convertBitrate', convertBitrate.value)
  await saveSetting('convertOverwrite', String(convertOverwrite.value))
  const result = await window.easyMusic.startFlacConversions({
    sourceDir: convertSourceDir.value,
    outputDir: convertOutputDir.value,
    bitrate: convertBitrate.value,
    overwrite: convertOverwrite.value,
  })
  convertTasks.value = result.tasks
}

async function cancelFlacConversions() {
  convertTasks.value = await window.easyMusic.cancelFlacConversions()
}

async function importSource(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    await window.easyMusic.importSource(await file.text())
    sources.value = await window.easyMusic.listSources()
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error))
  } finally {
    input.value = ''
  }
}

async function testSource(source: SourceInfo) {
  const result = await window.easyMusic.testSource(source.id)
  alert(result.message)
}

async function enableSource(source: SourceInfo) {
  sources.value = await window.easyMusic.enableSource(source.id)
}

async function deleteSource(source: SourceInfo) {
  if (!confirm(`删除音乐源“${source.name}”？`)) return
  sources.value = await window.easyMusic.deleteSource(source.id)
}

function showPlaylistMenu(event: MouseEvent, playlist: PlaylistSummary) {
  event.preventDefault()
  selectedPlaylistId.value = playlist.id
  showMenu(event, [
    { label: '下载全部', action: queuePlaylist },
    { label: '删除歌单', action: () => deletePlaylist(playlist), danger: true },
  ])
}

function showArtistMenu(event: MouseEvent, artist: string) {
  event.preventDefault()
  showMenu(event, [
    { label: '删除歌手', action: () => deleteArtist(artist), danger: true },
  ])
}

function showSongMenu(event: MouseEvent, songId: string) {
  event.preventDefault()
  showMenu(event, [
    { label: '下载', action: () => queueSongs([songId]) },
    { label: '从歌单删除', action: () => deleteSong([songId]), danger: true },
  ])
}

function showAlbumMenu(event: MouseEvent, album: AlbumNode) {
  event.preventDefault()
  showMenu(event, [
    { label: '下载专辑', action: () => queueSongs(album.children.map((child) => child.songId)) },
    { label: '删除专辑', action: () => deleteSong(album.deleteSongIds), danger: true },
  ])
}

function showTaskMenu(event: MouseEvent, task: DownloadTask) {
  event.preventDefault()
  showMenu(event, [
    { label: '开始下载', action: () => startDownloads([task.id]) },
    { label: '删除任务', action: () => removeTask(task.id), danger: true },
  ])
}

function showTaskError(error: string) {
  if (error) alert(`完整错误详情：\n\n${error}`)
}

function showMergedAlbumAudit(album: AlbumNode) {
  mergedAlbumAudit.value = album
}

function closeMergedAlbumAudit() {
  mergedAlbumAudit.value = null
}

function showMenu(event: MouseEvent, items: MenuItem[]) {
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, items }
}

function hideMenu() {
  contextMenu.value.visible = false
}

function playlistLabel(playlist: PlaylistSummary): string {
  const prefix = `${playlist.artistName} - `
  const name = playlist.name.startsWith(prefix) ? playlist.name.slice(prefix.length) : playlist.name
  return `${name} (${playlist.songCount}首 / ${playlist.albumCount}专辑)`
}

function playlistOrder(playlist: PlaylistSummary): number {
  if (playlist.kind === 'total') return 0
  const order: Record<string, number> = { kw: 1, kg: 2, tx: 3, wy: 4 }
  return order[playlist.platform || ''] || 99
}

function platformLabel(platform: string): string {
  return {
    kw: '酷我音乐',
    kg: '酷狗音乐',
    tx: 'QQ音乐',
    wy: '网易云音乐',
  }[platform] || platform
}

function albumMetaLabel(album: AlbumNode | MergedAlbumInfo): string {
  const date = album.publishDate || '未知日期'
  const songCount = 'songCount' in album ? album.songCount : album.children.length
  return `${platformLabel(album.platform)} / ${date} / ${album.albumName} / ${songCount}首`
}

function formatDuration(seconds: number): string {
  const value = Number(seconds || 0)
  if (!value) return ''
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`
}

function formatBytes(value: number): string {
  if (!value) return '0 B'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
</script>

<template>
  <main class="app-shell">
    <nav class="page-nav">
      <button :class="{ active: activePage === 'albums' }" @click="switchPage('albums')">专辑下载</button>
      <button :class="{ active: activePage === 'downloads' }" @click="switchPage('downloads')">下载任务</button>
      <button :class="{ active: activePage === 'sources' }" @click="switchPage('sources')">音乐源管理</button>
      <button :class="{ active: activePage === 'converter' }" @click="switchPage('converter')">FLAC 转 MP3</button>
    </nav>

    <header v-if="activePage === 'albums'" class="topbar">
      <div class="artist-search">
        <input v-model="artistName" class="text-input artist-input" placeholder="输入歌手名" @keyup.enter="fetchAlbums" />
        <button class="primary-button" :disabled="fetching" @click="fetchAlbums">{{ fetching ? '抓取中' : '抓取专辑' }}</button>
      </div>
      <div class="settings-line">
        <input v-model="downloadRoot" class="text-input path-input" readonly />
        <button @click="chooseRoot">选择目录</button>
        <select v-model="quality" @change="saveSetting('quality', quality)">
          <option value="flac24bit">flac24bit</option>
          <option value="flac">flac</option>
          <option value="320k">320k</option>
          <option value="128k">128k</option>
        </select>
        <label class="compact-label">并发</label>
        <input v-model="maxConcurrent" class="number-input" type="number" min="1" max="10" @change="saveSetting('maxConcurrent', maxConcurrent)" />
      </div>
    </header>

    <div v-if="activePage === 'albums'" class="progress-line">
      <progress :value="progressValue" max="100"></progress>
      <span>{{ progressText }}</span>
    </div>

    <section v-if="activePage === 'albums'" class="workspace">
      <aside class="playlist-pane">
        <div class="pane-title">歌单</div>
        <div class="playlist-tree">
          <div v-for="group in playlistGroups" :key="group.artist" class="artist-group">
            <button class="artist-node" @click="toggleArtist(group.artist)" @contextmenu="showArtistMenu($event, group.artist)">
              <span>{{ expandedArtists.has(group.artist) ? '▾' : '▸' }}</span>
              <span>{{ group.artist }}</span>
            </button>
            <div v-if="expandedArtists.has(group.artist)" class="playlist-children">
              <button
                v-for="playlist in group.list"
                :key="playlist.id"
                class="playlist-node"
                :class="{ active: selectedPlaylistId === playlist.id }"
                @click="selectPlaylist(playlist.id)"
                @contextmenu="showPlaylistMenu($event, playlist)"
              >
                {{ playlistLabel(playlist) }}
              </button>
            </div>
          </div>
        </div>
      </aside>

      <section class="song-pane">
        <div class="song-toolbar">
          <div class="segmented">
            <button :class="{ active: songViewMode === 'flat' }" @click="songViewMode = 'flat'; saveSetting('songViewMode', songViewMode)">歌曲列表</button>
            <button :class="{ active: songViewMode === 'album' }" @click="songViewMode = 'album'; saveSetting('songViewMode', songViewMode)">按专辑</button>
          </div>
          <div class="toolbar-actions">
            <span class="selected-title">{{ selectedPlaylist ? playlistLabel(selectedPlaylist) : '请选择歌单' }}</span>
            <button :disabled="!selectedPlaylist" @click="queuePlaylist">下载全部</button>
          </div>
        </div>

        <div v-if="songViewMode === 'flat'" class="table-wrap">
          <table class="data-table song-table">
            <thead>
              <tr>
                <th>歌曲</th>
                <th>歌手</th>
                <th>专辑</th>
                <th>平台</th>
                <th>时长</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.id" @contextmenu="showSongMenu($event, row.id)">
                <td>{{ row.song.title }}</td>
                <td>{{ row.song.artist }}</td>
                <td>{{ row.song.albumName }}</td>
                <td>{{ platformLabel(row.song.platform) }}</td>
                <td>{{ formatDuration(row.song.duration) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="album-tree">
          <details v-for="album in albums" :key="album.id" class="album-node" @contextmenu.prevent="showAlbumMenu($event, album)">
            <summary class="album-summary">
              <span>{{ album.title }}</span>
              <button
                v-if="album.mergedAlbums.length"
                type="button"
                class="merge-audit-button"
                @click.stop.prevent="showMergedAlbumAudit(album)"
              >
                已合并 {{ album.mergedAlbums.length }} 项
              </button>
            </summary>
            <button
              v-for="child in album.children"
              :key="child.id"
              class="album-song-node"
              @contextmenu.stop="showSongMenu($event, child.songId)"
            >
              {{ child.title }}
            </button>
          </details>
        </div>
      </section>
    </section>

    <section v-else-if="activePage === 'downloads'" class="page-pane">
      <div class="download-pane page-card">
        <div class="pane-header">
          <span>下载任务</span>
          <div class="pane-actions">
            <label class="compact-label">
              <input v-model="showFailedOnly" type="checkbox" />
              只看失败
            </label>
            <button @click="startVisibleDownloads">{{ showFailedOnly ? '下载失败任务' : '全部下载' }}</button>
            <button @click="pauseDownloads">全部暂停</button>
            <button class="danger" @click="removeAllTasks">全部删除</button>
          </div>
        </div>
        <div class="table-wrap task-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>下载任务</th>
                <th>状态</th>
                <th>速度</th>
                <th>已下载</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in visibleTasks" :key="task.id" @contextmenu="showTaskMenu($event, task)">
                <td>{{ task.song.title }} <span class="platform-tag">{{ platformLabel(task.song.platform) }}</span></td>
                <td>{{ task.statusText }}</td>
                <td>{{ task.speed }}</td>
                <td>{{ formatBytes(task.downloaded) }} / {{ formatBytes(task.total) }}</td>
                <td class="task-error-cell" :title="task.error" @click.stop="showTaskError(task.error)">{{ task.error }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section v-else-if="activePage === 'sources'" class="page-pane">
      <div class="source-pane page-card">
        <div class="pane-header">
          <span>音乐源管理</span>
          <label class="file-button">
            导入源
            <input type="file" accept=".js,.txt" @change="importSource" />
          </label>
        </div>
        <div class="source-list">
          <div v-for="source in sources" :key="source.id" class="source-row">
            <div>
              <strong>{{ source.name }}</strong>
              <span v-if="source.enabled" class="enabled-tag">已启用</span>
            </div>
            <div class="source-actions">
              <button @click="testSource(source)">测试</button>
              <button :disabled="source.enabled" @click="enableSource(source)">启用</button>
              <button class="danger" @click="deleteSource(source)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-else class="page-pane">
      <div class="converter-pane page-card">
        <div class="pane-header">
          <span>FLAC 转 MP3</span>
          <div class="converter-actions">
            <button class="primary-button" @click="startFlacConversions">开始转换</button>
            <button @click="cancelFlacConversions">取消</button>
          </div>
        </div>
        <div class="converter-form">
          <label>
            <span>FLAC 来源目录</span>
            <input v-model="convertSourceDir" class="text-input path-input" readonly />
            <button @click="chooseConvertSourceDir">选择</button>
          </label>
          <label>
            <span>MP3 输出目录</span>
            <input v-model="convertOutputDir" class="text-input path-input" readonly />
            <button @click="chooseConvertOutputDir">选择</button>
          </label>
          <label>
            <span>码率</span>
            <select v-model="convertBitrate" @change="saveSetting('convertBitrate', convertBitrate)">
              <option value="320k">320k</option>
              <option value="256k">256k</option>
              <option value="192k">192k</option>
              <option value="128k">128k</option>
            </select>
          </label>
          <label class="compact-label">
            <input v-model="convertOverwrite" type="checkbox" @change="saveSetting('convertOverwrite', String(convertOverwrite))" />
            覆盖已存在 MP3
          </label>
        </div>
        <div class="table-wrap converter-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>FLAC 文件</th>
                <th>MP3 输出</th>
                <th>状态</th>
                <th>进度</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in convertTasks" :key="task.id">
                <td :title="task.sourcePath">{{ task.sourcePath }}</td>
                <td :title="task.outputPath">{{ task.outputPath }}</td>
                <td>{{ task.statusText }}</td>
                <td>{{ task.progress }}%</td>
                <td class="task-error-cell" :title="task.error">{{ task.error }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <div v-if="contextMenu.visible" class="context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
      <button
        v-for="item in contextMenu.items"
        :key="item.label"
        :class="{ danger: item.danger }"
        @click="item.action(); hideMenu()"
      >
        {{ item.label }}
      </button>
    </div>

    <div v-if="mergedAlbumAudit" class="modal-backdrop" @click.self="closeMergedAlbumAudit">
      <section class="merge-audit-dialog" role="dialog" aria-modal="true" aria-label="合并专辑审核">
        <header class="dialog-header">
          <div>
            <h2>合并专辑审核</h2>
            <p>这些被合并专辑已包含在当前专辑的删除范围内。</p>
          </div>
          <button type="button" class="icon-button" aria-label="关闭" @click="closeMergedAlbumAudit">×</button>
        </header>

        <div class="audit-section">
          <h3>当前保留专辑</h3>
          <div class="audit-album-line">{{ albumMetaLabel(mergedAlbumAudit) }}</div>
          <details>
            <summary>歌曲列表（{{ mergedAlbumAudit.children.length }}首）</summary>
            <ol class="audit-song-list">
              <li v-for="child in mergedAlbumAudit.children" :key="child.id">{{ child.title }}</li>
            </ol>
          </details>
        </div>

        <div class="audit-section">
          <h3>被合并专辑</h3>
          <article v-for="album in mergedAlbumAudit.mergedAlbums" :key="`${album.platform}:${album.publishDate}:${album.albumName}`" class="merged-album-item">
            <div class="audit-album-line">{{ albumMetaLabel(album) }}</div>
            <div class="merge-reason">原因：{{ album.reason }}</div>
            <details>
              <summary>歌曲列表（{{ album.songs.length }}首）</summary>
              <ol class="audit-song-list">
                <li v-for="song in album.songs" :key="song">{{ song }}</li>
              </ol>
            </details>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>

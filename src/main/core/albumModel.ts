import { buildAlbumFolderName, normalizeCompareText, readPublishDate } from './naming'
import { PLATFORM_LABELS, PLATFORM_PRIORITY, type AlbumSongNode, type MergedAlbumInfo, type PlaylistSongRow, type Song } from './types'
import { BALANCED_ALBUM_MERGE_REASON, shouldMergeBalancedAlbums, type AlbumMergeCandidate } from './albumMergeScorer'

interface InternalAlbumNode {
  key: string
  albumName: string
  publishDate: string
  platform: string
  firstPosition: number
  children: Array<{ songId: string; song: Song; position: number }>
  deleteSongIds: Set<string>
  mergedAlbums: MergedAlbumInfo[]
}

const SAME_DATE_SIMILAR_TRACK_REASON = '同发行日、曲目数相同且歌曲名规范化后相似，合并为同一专辑'
const SONG_TITLE_VARIANT_SEGMENT_RE = /[\s._-]*[\[(（【][^\])）】]*(?:explicit|clean|live|remaster(?:ed)?|version|feat\.?|featuring|ft\.?|with|现场|版本|版)[^\])）】]*[\])）】]/gi
const SONG_TITLE_TRAILING_VERSION_RE = /(?:[\s._-]+|\s*[\[(（【]\s*)(?:explicit|clean|live|remaster(?:ed)?|version)(?:[\s._-]+(?:version|remaster(?:ed)?))?\s*[\])）】]?$/i

export function buildAlbumSongTreeModel(
  rows: PlaylistSongRow[],
  options: { totalPlaylist?: boolean } = {},
): AlbumSongNode[] {
  const grouped = new Map<string, InternalAlbumNode>()
  for (const row of rows) {
    const publishDate = readPublishDate(row.song.raw)
    const albumIdentity = row.song.albumId || normalizeCompareText(row.song.albumName)
    const key = `${row.song.platform}:${publishDate}:${albumIdentity}:${normalizeCompareText(row.song.albumName)}`
    let node = grouped.get(key)
    if (!node) {
      node = {
        key,
        albumName: row.song.albumName || '未知专辑',
        publishDate,
        platform: row.song.platform,
        firstPosition: row.position,
        children: [],
        deleteSongIds: new Set(),
        mergedAlbums: [],
      }
      grouped.set(key, node)
    }
    node.children.push({ songId: row.id, song: row.song, position: row.position })
    node.deleteSongIds.add(row.id)
  }

  let nodes = Array.from(grouped.values()).map(sortChildren)
  if (options.totalPlaylist) nodes = dedupeTotalAlbums(nodes)

  return nodes.sort(albumSort).map((node, albumIndex) => ({
    id: `album:${albumIndex}:${node.key}`,
    title: albumTitle(node),
    albumName: node.albumName,
    publishDate: node.publishDate,
    platform: node.platform,
    deleteSongIds: Array.from(node.deleteSongIds),
    mergedAlbums: node.mergedAlbums,
    children: node.children.map(({ songId, song }) => ({
      id: `song:${songId}`,
      songId,
      title: songTitle(song),
      song,
    })),
  }))
}

function sortChildren(node: InternalAlbumNode): InternalAlbumNode {
  node.children.sort((left, right) => {
    const track = (left.song.trackNo || 9999) - (right.song.trackNo || 9999)
    if (track) return track
    return left.position - right.position || left.song.title.localeCompare(right.song.title, 'zh-Hans-CN')
  })
  return node
}

function dedupeTotalAlbums(nodes: InternalAlbumNode[]): InternalAlbumNode[] {
  const byName = new Map<string, InternalAlbumNode[]>()
  for (const node of nodes) {
    const key = normalizeCompareText(node.albumName)
    byName.set(key, [...(byName.get(key) || []), node])
  }

  const kept: InternalAlbumNode[] = []
  for (const group of byName.values()) {
    const bySongSignature = new Map<string, InternalAlbumNode[]>()
    for (const node of group) {
      const signature = songSignature(node)
      bySongSignature.set(signature, [...(bySongSignature.get(signature) || []), node])
    }

    const exactSongSetWinners: InternalAlbumNode[] = []
    for (const sameSongs of bySongSignature.values()) {
      const best = selectBestAlbum(sameSongs)
      for (const node of sameSongs) {
        if (node !== best) absorbAlbum(best, node, '专辑名规范化一致，歌曲集合一致')
      }
      exactSongSetWinners.push(best)
    }

    const equivalentSongSetWinners = dedupeEquivalentAlbums(
      exactSongSetWinners,
      '同名专辑曲目等价，保留最佳平台版本',
    )
    const sameDaySameNameWinners = mergeSameDaySameNameAlbums(
      equivalentSongSetWinners,
      '同发行日且专辑名规范化一致，合并为同一专辑',
    )

    kept.push(...dedupeContainedAlbums(sameDaySameNameWinners, {
      titleReason: '同名专辑歌曲集合子集，保留歌曲数更多的专辑',
      equivalentReason: '同名专辑曲目等价子集，保留歌曲数更多的专辑',
      allowTrackEquivalence: true,
    }))
  }

  const byDate = new Map<string, InternalAlbumNode[]>()
  for (const node of kept) byDate.set(node.publishDate, [...(byDate.get(node.publishDate) || []), node])
  const dateWinners = Array.from(byDate.values())
    .flatMap((sameDate) => {
      const similarTrackWinners = mergeSameDateSimilarTrackAlbums(sameDate, SAME_DATE_SIMILAR_TRACK_REASON)
      return dedupeContainedAlbums(similarTrackWinners, {
        titleReason: '同日歌曲集合子集，保留歌曲数更多的专辑',
      })
    })
  return mergeBalancedAlbumNodes(dateWinners).sort(albumSort)
}

function selectBestAlbum(nodes: InternalAlbumNode[]): InternalAlbumNode {
  return [...nodes].sort(bestSort)[0]
}

function bestSort(left: InternalAlbumNode, right: InternalAlbumNode): number {
  return (
    right.children.length - left.children.length ||
    (PLATFORM_PRIORITY[left.platform] ?? 99) - (PLATFORM_PRIORITY[right.platform] ?? 99) ||
    left.publishDate.localeCompare(right.publishDate) ||
    left.firstPosition - right.firstPosition ||
    left.albumName.localeCompare(right.albumName, 'zh-Hans-CN')
  )
}

function albumSort(left: InternalAlbumNode, right: InternalAlbumNode): number {
  return left.publishDate.localeCompare(right.publishDate) || left.albumName.localeCompare(right.albumName, 'zh-Hans-CN') || left.firstPosition - right.firstPosition
}

function dedupeEquivalentAlbums(nodes: InternalAlbumNode[], reason: string): InternalAlbumNode[] {
  const hidden = new Set<InternalAlbumNode>()
  const ordered = [...nodes].sort(bestSort)
  for (const target of ordered) {
    if (hidden.has(target)) continue
    for (const candidate of ordered) {
      if (candidate === target || hidden.has(candidate) || candidate.children.length !== target.children.length) continue
      if (!equivalentSameSizeAlbum(candidate, target)) continue
      hidden.add(candidate)
      absorbAlbum(target, candidate, reason)
    }
  }
  return nodes.filter((node) => !hidden.has(node))
}

function mergeSameDaySameNameAlbums(nodes: InternalAlbumNode[], reason: string): InternalAlbumNode[] {
  const grouped = new Map<string, InternalAlbumNode[]>()
  for (const node of nodes) {
    const key = `${node.publishDate}\x1f${normalizeCompareText(node.albumName)}`
    grouped.set(key, [...(grouped.get(key) || []), node])
  }

  const result: InternalAlbumNode[] = []
  for (const group of grouped.values()) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }

    const target = selectBestAlbum(group)
    for (const node of group) {
      if (node === target) continue
      absorbAlbum(target, node, reason)
    }
    result.push(sortChildren(target))
  }
  return result
}

function mergeSameDateSimilarTrackAlbums(nodes: InternalAlbumNode[], reason: string): InternalAlbumNode[] {
  const hidden = new Set<InternalAlbumNode>()
  const ordered = [...nodes].sort(bestSort)

  for (const target of ordered) {
    if (hidden.has(target)) continue
    for (const candidate of ordered) {
      if (candidate === target || hidden.has(candidate)) continue
      if (!sameDateSimilarTrackAlbum(candidate, target)) continue
      hidden.add(candidate)
      absorbAlbum(target, candidate, reason)
    }
    sortChildren(target)
  }

  return nodes.filter((node) => !hidden.has(node))
}

function mergeBalancedAlbumNodes(nodes: InternalAlbumNode[]): InternalAlbumNode[] {
  const groups = groupBalancedAlbumNodes(nodes)
  const result: InternalAlbumNode[] = []
  for (const group of groups) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }

    const target = selectBestAlbum(group)
    for (const node of group) {
      if (node === target) continue
      absorbAlbum(target, node, BALANCED_ALBUM_MERGE_REASON)
    }
    result.push(sortChildren(target))
  }
  return result
}

function groupBalancedAlbumNodes(nodes: InternalAlbumNode[]): InternalAlbumNode[][] {
  const parent = nodes.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (shouldMergeBalancedAlbums(toAlbumMergeCandidate(nodes[left]), toAlbumMergeCandidate(nodes[right]))) union(left, right)
    }
  }

  const groups = new Map<number, InternalAlbumNode[]>()
  nodes.forEach((node, index) => {
    const root = find(index)
    groups.set(root, [...(groups.get(root) || []), node])
  })
  return Array.from(groups.values())
}

function toAlbumMergeCandidate(node: InternalAlbumNode): AlbumMergeCandidate {
  return {
    platform: node.platform,
    albumName: node.albumName,
    publishDate: node.publishDate,
    songCount: node.children.length,
    songs: node.children.map((child) => child.song),
  }
}

function dedupeContainedAlbums(nodes: InternalAlbumNode[], options: {
  titleReason: string
  equivalentReason?: string
  allowTrackEquivalence?: boolean
}): InternalAlbumNode[] {
  const hidden = new Set<InternalAlbumNode>()
  const ordered = [...nodes].sort(bestSort)
  for (const smaller of ordered.slice().reverse()) {
    if (hidden.has(smaller)) continue
    for (const larger of ordered) {
      if (smaller === larger || hidden.has(larger) || larger.children.length <= smaller.children.length) continue
      const containment = albumContainment(smaller, larger, Boolean(options.allowTrackEquivalence))
      if (containment) {
        hidden.add(smaller)
        absorbAlbum(
          larger,
          smaller,
          containment === 'title' ? options.titleReason : (options.equivalentReason || options.titleReason),
        )
        break
      }
    }
  }
  return nodes.filter((node) => !hidden.has(node))
}

function albumContainment(
  smaller: InternalAlbumNode,
  larger: InternalAlbumNode,
  allowTrackEquivalence: boolean,
): 'title' | 'equivalent' | null {
  const smallerNames = songNameSet(smaller)
  const largerNames = songNameSet(larger)
  if ([...smallerNames].every((name) => largerNames.has(name))) return 'title'
  if (!allowTrackEquivalence) return null
  return isEquivalentSongSubset(smaller, larger) ? 'equivalent' : null
}

function isEquivalentSongSubset(smaller: InternalAlbumNode, larger: InternalAlbumNode): boolean {
  const used = new Set<number>()
  return smaller.children.every((smallChild) => {
    const index = larger.children.findIndex((largeChild, candidateIndex) => {
      return !used.has(candidateIndex) && equivalentSong(smallChild.song, largeChild.song)
    })
    if (index < 0) return false
    used.add(index)
    return true
  })
}

function equivalentSameSizeAlbum(left: InternalAlbumNode, right: InternalAlbumNode): boolean {
  const used = new Set<number>()
  return left.children.every((leftChild) => {
    const index = right.children.findIndex((rightChild, candidateIndex) => {
      return !used.has(candidateIndex) && equivalentSongForSameSizeAlbum(leftChild.song, rightChild.song)
    })
    if (index < 0) return false
    used.add(index)
    return true
  })
}

function sameDateSimilarTrackAlbum(left: InternalAlbumNode, right: InternalAlbumNode): boolean {
  if (left.publishDate !== right.publishDate || left.children.length !== right.children.length) return false
  if (left.children.length === 0) return false

  return left.children.every((leftChild, index) => {
    const rightChild = right.children[index]
    if (!rightChild || !sameTrackPosition(leftChild.song, rightChild.song)) return false
    return similarNormalizedSongTitle(leftChild.song.title, rightChild.song.title)
  })
}

function equivalentSong(left: Song, right: Song): boolean {
  if (normalizeSongTitle(left.title) === normalizeSongTitle(right.title)) return true
  return sameTrackNo(left, right) && closeDuration(left.duration, right.duration)
}

function equivalentSongForSameSizeAlbum(left: Song, right: Song): boolean {
  const leftTitle = normalizeSongTitle(left.title)
  const rightTitle = normalizeSongTitle(right.title)
  if (leftTitle === rightTitle) return true
  if (normalizeDisplaySongTitle(left.title) === normalizeDisplaySongTitle(right.title)) return true
  return sameTrackNo(left, right) && closeDuration(left.duration, right.duration) && relatedSongTitle(leftTitle, rightTitle)
}

function relatedSongTitle(left: string, right: string): boolean {
  const minLength = Math.min(left.length, right.length)
  return minLength >= 2 && (left.includes(right) || right.includes(left))
}

function sameTrackNo(left: Song, right: Song): boolean {
  return Number(left.trackNo || 0) > 0 && left.trackNo === right.trackNo
}

function sameTrackPosition(left: Song, right: Song): boolean {
  const leftTrack = Number(left.trackNo || 0)
  const rightTrack = Number(right.trackNo || 0)
  return leftTrack <= 0 || rightTrack <= 0 || leftTrack === rightTrack
}

function closeDuration(left: number, right: number): boolean {
  const leftSeconds = Number(left || 0)
  const rightSeconds = Number(right || 0)
  return leftSeconds > 0 && rightSeconds > 0 && Math.abs(leftSeconds - rightSeconds) <= 8
}

function absorbAlbum(target: InternalAlbumNode, hidden: InternalAlbumNode, reason: string): void {
  target.mergedAlbums.push(toMergedAlbumInfo(hidden, reason), ...hidden.mergedAlbums)
  target.mergedAlbums.sort((left, right) => {
    return (
      left.publishDate.localeCompare(right.publishDate) ||
      String(left.platform).localeCompare(String(right.platform)) ||
      left.albumName.localeCompare(right.albumName, 'zh-Hans-CN')
    )
  })
  for (const songId of hidden.deleteSongIds) target.deleteSongIds.add(songId)
}

function toMergedAlbumInfo(node: InternalAlbumNode, reason: string): MergedAlbumInfo {
  return {
    title: albumTitle(node),
    albumName: node.albumName,
    publishDate: node.publishDate,
    platform: node.platform,
    songCount: node.children.length,
    reason,
    songs: node.children.map(({ song }) => songTitle(song)),
  }
}

function albumTitle(node: InternalAlbumNode): string {
  return `${buildAlbumFolderName(node.albumName, node.publishDate, node.children.length)} [${PLATFORM_LABELS[node.platform] || node.platform}]`
}

function songTitle(song: Song): string {
  return song.trackNo > 0 ? `${String(song.trackNo).padStart(2, '0')}. ${song.title}` : song.title
}

function songNameSet(node: InternalAlbumNode): Set<string> {
  return new Set(node.children.map((child) => normalizeSongTitle(child.song.title)))
}

function songSignature(node: InternalAlbumNode): string {
  return `${node.children.length}:${[...songNameSet(node)].sort().join('\u0001')}`
}

function normalizeSongTitle(title: string): string {
  return normalizeCompareText(title).replace(/第([零〇一二两三四五六七八九十]{1,3})/g, (_, value: string) => {
    const number = parseChineseInteger(value)
    return number > 0 ? `第${number}` : `第${value}`
  })
}

function normalizeDisplaySongTitle(title: string): string {
  return normalizeSongTitle(title).replace(/(live|现场版|心动版)$/g, '')
}

function similarNormalizedSongTitle(left: string, right: string): boolean {
  const leftTitle = normalizeSimilarSongTitle(left)
  const rightTitle = normalizeSimilarSongTitle(right)
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle)
}

function normalizeSimilarSongTitle(title: string): string {
  let normalized = String(title || '').replace(SONG_TITLE_VARIANT_SEGMENT_RE, ' ')
  let previous = ''
  while (previous !== normalized) {
    previous = normalized
    normalized = normalized.replace(SONG_TITLE_TRAILING_VERSION_RE, '')
  }
  return normalizeSongTitle(normalized)
}

function parseChineseInteger(value: string): number {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (value === '十') return 10
  if (!value.includes('十')) return digits[value] ?? 0
  const [left, right] = value.split('十')
  const tens = left ? digits[left] : 1
  const ones = right ? digits[right] : 0
  if (tens == null || ones == null) return 0
  return tens * 10 + ones
}

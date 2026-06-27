import { normalizeCompareText } from './naming'
import type { Song } from './types'

export const BALANCED_ALBUM_MERGE_THRESHOLD = 0.78
export const BALANCED_ALBUM_MERGE_REASON = 'balanced album merge score reached threshold'

const CROSS_DATE_BALANCED_ALBUM_MERGE_THRESHOLD = 0.74
const CROSS_DATE_MIN_RELEASE_DATE_SCORE = 0.35
const CROSS_DATE_MIN_ALBUM_NAME_CONTAINMENT_SCORE = 0.9
const CROSS_DATE_MIN_SONG_COVERAGE_RATE = 0.8

const BALANCED_ALBUM_MERGE_WEIGHTS = {
  trackNoMatchRate: 1,
  titleExactRate: 1,
  titleSimilarRate: 1.2,
  durationCloseRate: 0.85,
  releaseDateScore: 1,
  albumNameContainmentScore: 1.15,
  songCountScore: 0.8,
  songCoverageRate: 1.35,
}

export interface AlbumMergeCandidate {
  platform: string
  albumName: string
  publishDate: string
  songCount: number
  songs: Song[]
}

interface AlbumMergeFeatures {
  trackNoMatchRate: number
  titleExactRate: number
  titleSimilarRate: number
  durationCloseRate: number
  releaseDateScore: number
  albumNameContainmentScore: number
  songCountScore: number
  songCoverageRate: number
}

export function shouldMergeBalancedAlbums(left: AlbumMergeCandidate, right: AlbumMergeCandidate): boolean {
  const features = extractAlbumMergeFeatures(left, right)
  const score = scoreAlbumMergeFeatures(features)
  if (hasDifferentPublishDates(left, right)) {
    return score >= CROSS_DATE_BALANCED_ALBUM_MERGE_THRESHOLD &&
      features.releaseDateScore >= CROSS_DATE_MIN_RELEASE_DATE_SCORE &&
      features.albumNameContainmentScore >= CROSS_DATE_MIN_ALBUM_NAME_CONTAINMENT_SCORE &&
      features.songCoverageRate >= CROSS_DATE_MIN_SONG_COVERAGE_RATE
  }
  return score >= BALANCED_ALBUM_MERGE_THRESHOLD
}

export function scoreBalancedAlbumMerge(left: AlbumMergeCandidate, right: AlbumMergeCandidate): number {
  return scoreAlbumMergeFeatures(extractAlbumMergeFeatures(left, right))
}

function scoreAlbumMergeFeatures(features: AlbumMergeFeatures): number {
  let weightedScore = 0
  let totalWeight = 0
  for (const [key, weight] of Object.entries(BALANCED_ALBUM_MERGE_WEIGHTS) as Array<[keyof AlbumMergeFeatures, number]>) {
    weightedScore += features[key] * weight
    totalWeight += weight
  }
  return totalWeight > 0 ? weightedScore / totalWeight : 0
}

function hasDifferentPublishDates(left: AlbumMergeCandidate, right: AlbumMergeCandidate): boolean {
  return Boolean(left.publishDate && right.publishDate && left.publishDate !== right.publishDate)
}

export function findBalancedSongMatch(song: Song, candidates: Song[]): Song | null {
  let bestSong: Song | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = songMatchScore(song, candidate)
    if (score > bestScore) {
      bestScore = score
      bestSong = candidate
    }
  }
  return bestScore >= 0.7 ? bestSong : null
}

function extractAlbumMergeFeatures(left: AlbumMergeCandidate, right: AlbumMergeCandidate): AlbumMergeFeatures {
  const matches = matchAlbumSongs(left.songs, right.songs)
  const smallerSongCount = Math.max(1, Math.min(left.songs.length, right.songs.length))
  const largerSongCount = Math.max(1, Math.max(left.songs.length, right.songs.length))
  const leftSongCount = Math.max(left.songCount || 0, left.songs.length)
  const rightSongCount = Math.max(right.songCount || 0, right.songs.length)
  const largerDeclaredSongCount = Math.max(1, Math.max(leftSongCount, rightSongCount))

  return {
    trackNoMatchRate: matches.filter(({ leftSong, rightSong }) => sameTrackNo(leftSong, rightSong)).length / smallerSongCount,
    titleExactRate: matches.filter(({ leftSong, rightSong }) => normalizeSongTitle(leftSong.title) === normalizeSongTitle(rightSong.title)).length / smallerSongCount,
    titleSimilarRate: matches.filter(({ leftSong, rightSong }) => titleSimilarity(leftSong.title, rightSong.title) >= 0.78).length / smallerSongCount,
    durationCloseRate: matches.filter(({ leftSong, rightSong }) => durationCloseScore(leftSong, rightSong) >= 0.8).length / smallerSongCount,
    releaseDateScore: releaseDateScore(left.publishDate, right.publishDate),
    albumNameContainmentScore: albumNameContainmentScore(normalizeCompareText(left.albumName), normalizeCompareText(right.albumName)),
    songCountScore: Math.min(leftSongCount, rightSongCount) / largerDeclaredSongCount,
    songCoverageRate: matches.length / smallerSongCount,
  }
}

function matchAlbumSongs(leftSongs: Song[], rightSongs: Song[]): Array<{ leftSong: Song; rightSong: Song }> {
  const sourceIsLeft = leftSongs.length <= rightSongs.length
  const sourceSongs = sourceIsLeft ? leftSongs : rightSongs
  const targetSongs = sourceIsLeft ? rightSongs : leftSongs
  const usedTargetIndexes = new Set<number>()
  const matches: Array<{ leftSong: Song; rightSong: Song }> = []

  for (const sourceSong of sourceSongs) {
    let bestIndex = -1
    let bestScore = 0
    targetSongs.forEach((targetSong, index) => {
      if (usedTargetIndexes.has(index)) return
      const score = songMatchScore(sourceSong, targetSong)
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    })
    if (bestIndex < 0 || bestScore < 0.7) continue
    usedTargetIndexes.add(bestIndex)
    matches.push(sourceIsLeft
      ? { leftSong: sourceSong, rightSong: targetSongs[bestIndex] }
      : { leftSong: targetSongs[bestIndex], rightSong: sourceSong })
  }

  return matches
}

function songMatchScore(left: Song, right: Song): number {
  if (!compatibleArtists(left.artist, right.artist)) return 0

  const titleScore = titleSimilarity(left.title, right.title)
  const exactTitleScore = normalizeSongTitle(left.title) === normalizeSongTitle(right.title) ? 1 : 0
  const trackScore = sameTrackNo(left, right) ? 1 : 0
  const durationScore = durationCloseScore(left, right)

  if (exactTitleScore) return 0.72 + (durationScore * 0.18) + (trackScore * 0.1)
  if (titleScore >= 0.82) return (titleScore * 0.74) + (durationScore * 0.16) + (trackScore * 0.1)
  if (trackScore && durationScore >= 0.8 && titleScore >= 0.5) return (titleScore * 0.65) + (durationScore * 0.2) + 0.15
  return 0
}

function compatibleArtists(left: string, right: string): boolean {
  const normalizedLeft = normalizeCompareText(left)
  const normalizedRight = normalizeCompareText(right)
  if (!normalizedLeft || !normalizedRight) return true
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
}

function sameTrackNo(left: Song, right: Song): boolean {
  return Number(left.trackNo || 0) > 0 && left.trackNo === right.trackNo
}

function durationCloseScore(left: Song, right: Song): number {
  if (!left.duration || !right.duration) return 1
  const diff = Math.abs(left.duration - right.duration)
  if (diff <= 5) return 1
  if (diff <= 10) return 0.8
  if (diff <= 20) return 0.45
  return 0
}

function releaseDateScore(left: string, right: string): number {
  if (!left && !right) return 0.5
  if (!left || !right) return 0.35
  if (left === right) return 1

  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0

  const diffDays = Math.abs(leftTime - rightTime) / 86_400_000
  if (diffDays <= 1) return 1
  if (diffDays <= 7) return 0.85
  if (diffDays <= 31) return 0.65
  if (diffDays <= 365) return 0.35
  return 0
}

function albumNameContainmentScore(left: string, right: string): number {
  if (!left && !right) return 0.5
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return 0.9
  const similarity = normalizedTextSimilarity(left, right)
  if (similarity >= 0.85) return 0.75
  if (similarity >= 0.7) return 0.55
  return 0
}

function titleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeSongTitle(left)
  const normalizedRight = normalizeSongTitle(right)
  if (!normalizedLeft && !normalizedRight) return 1
  if (!normalizedLeft || !normalizedRight) return 0
  if (normalizedLeft === normalizedRight) return 1
  return normalizedTextSimilarity(normalizedLeft, normalizedRight)
}

function normalizedTextSimilarity(left: string, right: string): number {
  if (left === right) return 1
  const leftChars = Array.from(left)
  const rightChars = Array.from(right)
  if (!leftChars.length || !rightChars.length) return 0
  const previous = new Array(rightChars.length + 1).fill(0)
  const current = new Array(rightChars.length + 1).fill(0)

  for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
      current[rightIndex] = leftChars[leftIndex - 1] === rightChars[rightIndex - 1]
        ? previous[rightIndex - 1] + 1
        : Math.max(previous[rightIndex], current[rightIndex - 1])
    }
    for (let index = 0; index < current.length; index += 1) {
      previous[index] = current[index]
      current[index] = 0
    }
  }

  return previous[rightChars.length] / Math.max(leftChars.length, rightChars.length)
}

function normalizeSongTitle(value: string): string {
  return normalizeCompareText(value)
    .replace(/(?:explicit|clean|live|remaster(?:ed)?|version)$/gi, '')
}

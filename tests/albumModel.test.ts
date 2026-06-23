import { describe, expect, it } from 'vitest'
import { buildAlbumSongTreeModel } from '../src/main/core/albumModel'
import type { PlaylistSongRow } from '../src/main/core/types'

describe('album song model', () => {
  it('dedupes total playlist albums by normalized album name and keeps larger actual song set', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kw', '2024-01-01', 'Album A', 1, 'A'),
      row('2', 'kw', '2024-01-01', 'Album A', 2, 'B'),
      row('3', 'kg', '2024-01-01', 'Album-A', 1, 'A'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kw')
    expect(tree[0].title).toBe('2024-01-01 Album A (2首) [酷我音乐]')
    expect(tree[0].children.map((child) => child.title)).toEqual(['01. A', '02. B'])
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3'])
  })

  it('returns hidden album details when total playlist albums are merged by normalized name', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2008-06-03', '我到底是谁？', 1, 'A'),
      row('2', 'kg', '2008-06-03', '我到底是谁？', 2, 'B'),
      row('3', 'wy', '2008-06-02', '我到底是谁_', 1, 'A'),
      row('4', 'wy', '2008-06-02', '我到底是谁_', 2, 'B'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].mergedAlbums).toEqual([
      {
        title: '2008-06-02 我到底是谁_ (2首) [网易云音乐]',
        albumName: '我到底是谁_',
        publishDate: '2008-06-02',
        platform: 'wy',
        songCount: 2,
        reason: '专辑名规范化一致，歌曲集合一致',
        songs: ['01. A', '02. B'],
      },
    ])
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3', '4'])
  })

  it('does not return merge details for platform playlists', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2019-03-14', '你要的爱 (心动版)', 1, '你要的爱'),
      row('2', 'tx', '2019-03-14', '你要的爱（心动版）', 1, '你要的爱'),
    ]

    const tree = buildAlbumSongTreeModel(rows)

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
  })

  it('keeps total playlist albums with the same normalized name when song sets differ', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2024-06-02', 'Live Album', 1, 'A remix'),
      row('2', 'kg', '2024-06-02', 'Live Album', 2, 'B remix'),
      row('3', 'tx', '2024-07-10', 'Live-Album', 1, 'A'),
      row('4', 'tx', '2024-07-10', 'Live-Album', 2, 'B'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
  })

  it('dedupes same-name albums across different dates when the smaller song set is contained by the larger album', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2000-02-24', 'Penny', 1, 'A'),
      row('2', 'wy', '2000-02-24', 'Penny', 2, 'B'),
      row('3', 'kg', '2000-02-25', 'Penny', 1, 'A'),
      row('4', 'kg', '2000-02-25', 'Penny', 2, 'B'),
      row('5', 'kg', '2000-02-25', 'Penny', 3, 'C'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].children.map((child) => child.title)).toEqual(['01. A', '02. B', '03. C'])
    expect(tree[0].mergedAlbums).toEqual([
      {
        title: '2000-02-24 Penny (2首) [网易云音乐]',
        albumName: 'Penny',
        publishDate: '2000-02-24',
        platform: 'wy',
        songCount: 2,
        reason: '同名专辑歌曲集合子集，保留歌曲数更多的专辑',
        songs: ['01. A', '02. B'],
      },
    ])
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3', '4', '5'])
  })

  it('dedupes same-name albums when smaller album tracks use title variants but match track number and duration', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2000-02-24', 'Penny', 1, '第十五个耳洞', 205),
      row('2', 'wy', '2000-02-24', 'Penny', 2, 'Penny In Studio', 190),
      row('3', 'kg', '2000-02-25', 'Penny', 1, '第15个耳洞', 207),
      row('4', 'kg', '2000-02-25', 'Penny', 2, '佩妮在录音室', 188),
      row('5', 'kg', '2000-02-25', 'Penny', 3, '防空洞', 220),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].mergedAlbums).toEqual([
      {
        title: '2000-02-24 Penny (2首) [网易云音乐]',
        albumName: 'Penny',
        publishDate: '2000-02-24',
        platform: 'wy',
        songCount: 2,
        reason: '同名专辑曲目等价子集，保留歌曲数更多的专辑',
        songs: ['01. 第十五个耳洞', '02. Penny In Studio'],
      },
    ])
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3', '4', '5'])
  })

  it('dedupes equal-size same-name live albums when track titles only differ by live suffixes', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2010-09-16', '野蔷薇 (2009 Live Concert)', 1, '吹哔哔 (Live)', 175),
      row('2', 'kg', '2010-09-16', '野蔷薇 (2009 Live Concert)', 2, '看见听见 (Live)', 361),
      row('3', 'kg', '2010-09-16', '野蔷薇 (2009 Live Concert)', 3, '不想 (Live)', 228),
      row('4', 'tx', '2010-09-16', '野蔷薇 (2009 Live Concert)', 1, '吹哔哔', 175),
      row('5', 'tx', '2010-09-16', '野蔷薇 (2009 Live Concert)', 2, '看见听见', 361),
      row('6', 'tx', '2010-09-16', '野蔷薇 (2009 Live Concert)', 3, '不想', 228),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].mergedAlbums).toEqual([
      {
        title: '2010-09-16 野蔷薇 (2009 Live Concert) (3首) [QQ音乐]',
        albumName: '野蔷薇 (2009 Live Concert)',
        publishDate: '2010-09-16',
        platform: 'tx',
        songCount: 3,
        reason: '同名专辑曲目等价，保留最佳平台版本',
        songs: ['01. 吹哔哔', '02. 看见听见', '03. 不想'],
      },
    ])
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('dedupes equal-size single albums when song title omits the album version suffix', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2019-03-14', '你要的爱 (心动版)', 1, '你要的爱 (心动版)', 235),
      row('2', 'tx', '2019-03-14', '你要的爱（心动版）', 1, '你要的爱', 235),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].mergedAlbums[0]).toMatchObject({
      title: '2019-03-14 你要的爱（心动版） (1首) [QQ音乐]',
      reason: '同名专辑曲目等价，保留最佳平台版本',
      songs: ['01. 你要的爱'],
    })
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2'])
  })

  it('merges same-day same-name total albums by keeping the album with the most songs', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2020-04-08', 'New World', 1, 'A'),
      row('2', 'kg', '2020-04-08', 'New World', 2, 'B'),
      row('3', 'tx', '2020-04-08', 'New-World', 1, 'C'),
      row('4', 'tx', '2020-04-08', 'New-World', 3, 'D'),
      row('5', 'tx', '2020-04-08', 'New-World', 5, 'E'),
      row('6', 'tx', '2020-04-08', 'New-World', 6, 'F'),
      row('7', 'tx', '2020-04-08', 'New-World', 7, 'G'),
      row('8', 'tx', '2020-04-08', 'New-World', 8, 'H'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('tx')
    expect(tree[0].children.map((child) => child.title)).toEqual([
      '01. C',
      '03. D',
      '05. E',
      '06. F',
      '07. G',
      '08. H',
    ])
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('merges same-day same-name albums without blocking on duration differences', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'tx', '2024-05-11', 'Sunrise Live Version', 1, 'Sunrise', 930),
      row('2', 'wy', '2024-05-11', 'Sunrise-Live Version', 1, 'Sunrise Live Version', 948),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('tx')
    expect(tree[0].children.map((child) => child.title)).toEqual(['01. Sunrise'])
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2'])
  })

  it('keeps same-name albums separate when title variants have the same track number but different duration', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2000-02-24', 'Penny', 1, 'Penny In Studio', 190),
      row('2', 'kg', '2000-02-25', 'Penny', 1, '佩妮在录音室', 260),
      row('3', 'kg', '2000-02-25', 'Penny', 2, '防空洞', 220),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
  })

  it('keeps different-day equal-size same-name albums separate when one track cannot be matched', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2024-01-01', 'Same Album', 1, 'A (Live)', 200),
      row('2', 'kg', '2024-01-01', 'Same Album', 2, 'B (Live)', 210),
      row('3', 'tx', '2024-01-02', 'Same-Album', 1, 'A', 200),
      row('4', 'tx', '2024-01-02', 'Same-Album', 2, 'Different Song', 260),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
  })

  it('merges multiple smaller same-name albums into the largest contained album', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2001-01-17', '怎样', 1, 'A'),
      row('2', 'wy', '2001-01-17', '怎样', 2, 'B'),
      row('3', 'wy', '2001-01-17', '怎样', 3, 'C'),
      row('4', 'wy', '2001-01-17', '怎样', 4, 'D'),
      row('5', 'kg', '2001-01-18', '怎样', 1, 'A'),
      row('6', 'kg', '2001-01-18', '怎样', 2, 'B'),
      row('7', 'kg', '2001-01-18', '怎样', 3, 'C'),
      row('8', 'kg', '2001-01-18', '怎样', 4, 'D'),
      row('9', 'kg', '2001-01-18', '怎样', 5, 'E'),
      row('10', 'tx', '2001-01-18', '怎样', 1, 'A'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].mergedAlbums.map((album) => album.title)).toEqual([
      '2001-01-17 怎样 (4首) [网易云音乐]',
      '2001-01-18 怎样 (1首) [QQ音乐]',
    ])
    expect(tree[0].mergedAlbums.map((album) => album.reason)).toEqual([
      '同名专辑歌曲集合子集，保留歌曲数更多的专辑',
      '同发行日且专辑名规范化一致，合并为同一专辑',
    ])
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '10', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('dedupes same-day subset albums by keeping the larger set', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2024-06-02', 'Live Part', 1, 'A'),
      row('2', 'wy', '2024-06-02', 'Live Full', 1, 'A'),
      row('3', 'wy', '2024-06-02', 'Live Full', 2, 'B'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].albumName).toBe('Live Full')
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3'])
  })

  it('uses Kugou publishtime as album release date when normalized publishDate is missing', () => {
    const rows = [row('1', 'kg', '', 'Kugou Album', 1, 'Song')]
    rows[0].song.raw = { publishtime: '2026-04-22 00:00:00', albumSongCount: 1 }

    const tree = buildAlbumSongTreeModel(rows)

    expect(tree[0].publishDate).toBe('2026-04-22')
    expect(tree[0].title).toContain('2026-04-22 Kugou Album')
  })

  it('uses Kuwo detail publish date when normalized publishDate is missing', () => {
    const rows = [row('1', 'kw', '', 'Kuwo Album', 1, 'Song')]
    rows[0].song.raw = { detail_publish_date: '2013-07-07', albumSongCount: 1 }

    const tree = buildAlbumSongTreeModel(rows)

    expect(tree[0].publishDate).toBe('2013-07-07')
    expect(tree[0].title).toBe('2013-07-07 Kuwo Album (1首) [酷我音乐]')
  })

  it('uses Kuwo search item publish date fallback when song raw has no direct date', () => {
    const rows = [row('1', 'kw', '', 'Search Album', 1, 'Song')]
    rows[0].song.raw = {
      search_items: [{ RELEASEDATE: '2013-07-19 00:00:00' }],
      albumSongCount: 1,
    }

    const tree = buildAlbumSongTreeModel(rows)

    expect(tree[0].publishDate).toBe('2013-07-19')
    expect(tree[0].title).toBe('2013-07-19 Search Album (1首) [酷我音乐]')
  })
})

function row(
  id: string,
  platform: string,
  publishDate: string,
  albumName: string,
  trackNo: number,
  title: string,
  duration = 180,
): PlaylistSongRow {
  return {
    id,
    position: Number(id),
    candidateSources: [],
    song: {
      id: `${platform}:${id}`,
      platform,
      platformSongId: id,
      title,
      artist: 'Singer',
      albumId: `${platform}:${albumName}`,
      albumName,
      duration,
      trackNo,
      qualitys: ['flac'],
      raw: { publishDate, albumSongCount: 10 },
    },
  }
}

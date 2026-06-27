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

  it('shows balanced matched album variants as merged album audit details', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2024-07-10', 'World Tour Live EP', 1, 'Intro Live', 180),
      row('2', 'kg', '2024-07-10', 'World Tour Live EP', 2, 'Blue Live', 181),
      row('3', 'kg', '2024-07-10', 'World Tour Live EP', 3, 'Home Live', 182),
      row('4', 'tx', '2024-07-10', 'World Tour Live', 1, 'Intro', 180),
      row('5', 'tx', '2024-07-10', 'World Tour Live', 2, 'Blue', 181),
      row('6', 'tx', '2024-07-10', 'World Tour Live', 3, 'Home', 182),
      row('7', 'tx', '2024-07-10', 'World Tour Live', 4, 'Rain', 183),
      row('8', 'tx', '2024-07-10', 'World Tour Live', 5, 'Night', 184),
      row('9', 'tx', '2024-07-10', 'World Tour Live', 6, 'Fire', 185),
      row('10', 'tx', '2024-07-10', 'World Tour Live', 7, 'River', 186),
      row('11', 'tx', '2024-07-10', 'World Tour Live', 8, 'Encore', 187),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].albumName).toBe('World Tour Live')
    expect(tree[0].children.map((child) => child.title)).toEqual([
      '01. Intro',
      '02. Blue',
      '03. Home',
      '04. Rain',
      '05. Night',
      '06. Fire',
      '07. River',
      '08. Encore',
    ])
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].mergedAlbums[0]).toMatchObject({
      albumName: 'World Tour Live EP',
      platform: 'kg',
      songCount: 3,
      reason: 'balanced album merge score reached threshold',
      songs: ['01. Intro Live', '02. Blue Live', '03. Home Live'],
    })
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '10', '11', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('merges cross-date life tour variants when balanced song coverage is high', () => {
    const wyRows = [
      row('1001', 'wy', '2011-11-11', '生命之舞Live Tour', 1, '生命之舞 信念', 120),
      row('1002', 'wy', '2011-11-11', '生命之舞Live Tour', 2, 'Opening Show', 334),
      ...Array.from({ length: 46 }, (_, index) => {
        const track = index + 1
        const title = track <= 32 ? `巡演曲目${track}` : `巡演曲目${track}版`
        return row(String(1003 + index), 'wy', '2011-11-11', '生命之舞Live Tour', track + 2, title, 180 + index)
      }),
    ]
    const kgRows = Array.from({ length: 46 }, (_, index) => {
      const track = index + 1
      return row(String(1101 + index), 'kg', '2011-12-01', '生命之舞 Live Tour', track, `巡演曲目${track}`, 180 + index)
    })

    const tree = buildAlbumSongTreeModel([...wyRows, ...kgRows], { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('wy')
    expect(tree[0].albumName).toBe('生命之舞Live Tour')
    expect(tree[0].children).toHaveLength(48)
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].mergedAlbums[0]).toMatchObject({
      albumName: '生命之舞 Live Tour',
      publishDate: '2011-12-01',
      platform: 'kg',
      songCount: 46,
      reason: 'balanced album merge score reached threshold',
    })
  })

  it('merges cross-date encore album variants with the original album', () => {
    const titles = [
      '爱投罗网',
      '爱骗我',
      '未完的承诺',
      '惜命命',
      '狮子吼',
      '第61分钟',
      '爱我喊出来',
      '爱惨了',
      '想逃',
      '如果还有如果',
      '舞魂再现',
      '我的皇后',
      '占爱为王',
      '爱投罗网 Remix',
      '爱我喊出来 Remix',
      '第61分钟 Remix',
    ]
    const rows = [
      ...albumRows(1201, 'kg', '2013-10-16', '狮子吼', titles),
      ...albumRows(1301, 'tx', '2013-12-06', '狮子吼之舞魂再现 冠军ENCORE版', titles),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].albumName).toBe('狮子吼')
    expect(tree[0].children).toHaveLength(16)
    expect(tree[0].mergedAlbums[0]).toMatchObject({
      albumName: '狮子吼之舞魂再现 冠军ENCORE版',
      publishDate: '2013-12-06',
      platform: 'tx',
      songCount: 16,
      reason: 'balanced album merge score reached threshold',
    })
  })

  it('merges cross-date celebration album variants with the original album', () => {
    const titles = [
      '撑腰',
      '高调爱',
      '第二顺位',
      '搞笑',
      '潜意识失控',
      '个中强手',
      '幸福不灭',
      '潮男正传',
      '假如你还在这里',
      '拿手绝活',
      '为你写首歌',
    ]
    const rows = [
      ...albumRows(1401, 'wy', '2008-12-26', '潮男正传', titles),
      ...albumRows(1501, 'kg', '2009-01-23', '潮男正传 撑腰相挺庆功2CD版', titles),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].albumName).toBe('潮男正传 撑腰相挺庆功2CD版')
    expect(tree[0].children).toHaveLength(11)
    expect(tree[0].mergedAlbums[0]).toMatchObject({
      albumName: '潮男正传',
      publishDate: '2008-12-26',
      platform: 'wy',
      songCount: 11,
      reason: 'balanced album merge score reached threshold',
    })
  })

  it('keeps cross-date album variants separate when song coverage is low', () => {
    const rows = [
      ...albumRows(1601, 'kg', '2024-01-01', 'Cross Date Live', ['A', 'B', 'C', 'D', 'E']),
      ...albumRows(1701, 'tx', '2024-02-01', 'Cross Date Live Deluxe', ['A', 'B', 'Different C', 'Different D', 'Different E']),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
  })

  it('keeps same-platform album fragments separate so the real best album wins the merge group', () => {
    const firstFragment = albumRows(
      1801,
      'kg',
      '2007-11-02',
      'Best Show',
      ['呛司呛司', '幸福猎人', '黑眼圈', '狐狸精', '力量', '自我催眠', '淘汰郎', '小丑鱼', '好朋友', '爱转角', '猛男日记', 'Twinkle'],
      'kg:best-show:main',
    )
    const secondFragment = albumRows(
      1901,
      'kg',
      '2007-11-02',
      'Best Show',
      ['精舞门', '恋爱达人', '机器娃娃', 'Twinkle (Single Version)'],
      'kg:best-show:bonus',
    )
    const fullAlbum = albumRows(
      2001,
      'tx',
      '2007-11-06',
      'Best Show 劲舞天王版',
      [
        '精舞门',
        '呛司呛司',
        '幸福猎人',
        '黑眼圈',
        '恋爱达人',
        '狐狸精',
        '力量',
        '自我催眠',
        '机器娃娃',
        '淘汰郎',
        '小丑鱼',
        '好朋友',
        '爱转角',
        '猛男日记',
        'Twinkle',
        '劲舞SHOW',
      ],
      'tx:best-show-full',
    )

    const tree = buildAlbumSongTreeModel([...firstFragment, ...secondFragment, ...fullAlbum], { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('tx')
    expect(tree[0].albumName).toBe('Best Show 劲舞天王版')
    expect(tree[0].children.map((child) => child.title)).toEqual([
      '01. 精舞门',
      '02. 呛司呛司',
      '03. 幸福猎人',
      '04. 黑眼圈',
      '05. 恋爱达人',
      '06. 狐狸精',
      '07. 力量',
      '08. 自我催眠',
      '09. 机器娃娃',
      '10. 淘汰郎',
      '11. 小丑鱼',
      '12. 好朋友',
      '13. 爱转角',
      '14. 猛男日记',
      '15. Twinkle',
      '16. 劲舞SHOW',
    ])
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

  it('merges same-day same-size albums when track names only differ by explicit markers', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2020-04-24', 'Dog Days', 1, 'Dog Days'),
      row('2', 'kg', '2020-04-24', 'Dog Days (Explicit)', 1, 'Dog Days (Explicit)'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].children.map((child) => child.title)).toEqual(['01. Dog Days (Explicit)'])
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].mergedAlbums[0].reason).toBe('同发行日、曲目数相同且歌曲名规范化后相似，合并为同一专辑')
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2'])
  })

  it('merges same-day same-size albums when only some tracks have explicit markers', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2024-07-22', 'sad songs', 1, '去北极忘记你'),
      row('2', 'wy', '2024-07-22', 'sad songs', 2, 'dishonesty'),
      row('3', 'wy', '2024-07-22', 'sad songs', 3, 'winners'),
      row('4', 'wy', '2024-07-22', 'sad songs', 4, 'camo'),
      row('5', 'kg', '2024-07-22', 'sad songs (Explicit)', 1, '去北极忘记你'),
      row('6', 'kg', '2024-07-22', 'sad songs (Explicit)', 2, 'dishonesty (Explicit)'),
      row('7', 'kg', '2024-07-22', 'sad songs (Explicit)', 3, 'winners'),
      row('8', 'kg', '2024-07-22', 'sad songs (Explicit)', 4, 'camo'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].children.map((child) => child.title)).toEqual([
      '01. 去北极忘记你',
      '02. dishonesty (Explicit)',
      '03. winners',
      '04. camo',
    ])
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].mergedAlbums[0].reason).toBe('同发行日、曲目数相同且歌曲名规范化后相似，合并为同一专辑')
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('merges same-day same-size albums when featured artist parentheticals differ', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'kg', '2024-01-31', 'Bread and Better (feat. 姜涛 & Gentle Bones)', 1, 'Bread and Better (feat. 姜涛 & Gentle Bones)'),
      row('2', 'wy', '2024-01-31', 'Bread and Better (feat. Keung To & Gentle Bones)', 1, 'Bread and Better (feat. Keung To & Gentle Bones)'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(1)
    expect(tree[0].platform).toBe('kg')
    expect(tree[0].children.map((child) => child.title)).toEqual(['01. Bread and Better (feat. 姜涛 & Gentle Bones)'])
    expect(tree[0].mergedAlbums).toHaveLength(1)
    expect(tree[0].mergedAlbums[0].reason).toBe('同发行日、曲目数相同且歌曲名规范化后相似，合并为同一专辑')
    expect(tree[0].deleteSongIds.sort()).toEqual(['1', '2'])
  })

  it('keeps same-day same-size albums separate when a normalized track name differs', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2024-07-22', 'Album One', 1, 'same'),
      row('2', 'wy', '2024-07-22', 'Album One', 2, 'honest'),
      row('3', 'kg', '2024-07-22', 'Album Two', 1, 'same (Explicit)'),
      row('4', 'kg', '2024-07-22', 'Album Two', 2, 'different'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
  })

  it('keeps same-size albums separate when normalized track names match on different dates', () => {
    const rows: PlaylistSongRow[] = [
      row('1', 'wy', '2024-07-22', 'Album One', 1, 'same'),
      row('2', 'kg', '2024-07-23', 'Album Two', 1, 'same (Explicit)'),
    ]

    const tree = buildAlbumSongTreeModel(rows, { totalPlaylist: true })

    expect(tree).toHaveLength(2)
    expect(tree.every((album) => album.mergedAlbums.length === 0)).toBe(true)
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

function albumRows(
  startId: number,
  platform: string,
  publishDate: string,
  albumName: string,
  titles: string[],
  albumId = `${platform}:${albumName}`,
): PlaylistSongRow[] {
  return titles.map((title, index) => row(String(startId + index), platform, publishDate, albumName, index + 1, title, 180 + index, albumId))
}

function row(
  id: string,
  platform: string,
  publishDate: string,
  albumName: string,
  trackNo: number,
  title: string,
  duration = 180,
  albumId = `${platform}:${albumName}`,
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
      albumId,
      albumName,
      duration,
      trackNo,
      qualitys: ['flac'],
      raw: { publishDate, albumSongCount: 10 },
    },
  }
}

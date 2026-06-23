# Easy Music

本项目是一个独立 Electron 桌面专辑下载工具，只包含歌手专辑抓取、歌单管理、下载任务、下载状态、音乐源管理和本地持久化，不包含播放器。

## 功能

- 输入歌手名后抓取酷我、酷狗、QQ、网易云四个平台，并生成平台歌单和总歌单。
- 右侧支持“歌曲列表”和“按专辑”两种展示。
- 下载路径固定为：`下载根目录 / 歌单归属歌手 / 发行日期 专辑名 (实际歌曲数首) / NN. 歌名.ext`。
- 下载链路使用内部 HTTP 请求，不调用浏览器、系统 URL handler 或 IDM。
- 支持导入洛雪自定义音乐源脚本，调用 `musicUrl / lyric / pic`。
- 下载状态保存在本地 SQLite，重启后仍可查看歌单和任务。
- MP3 支持写入 ID3 标题、歌手、专辑、封面和歌词；FLAC 支持 Vorbis Comment 和 Picture；APE 按洛雪处理方式跳过嵌入。

## 开发

```bash
npm install
npm run dev
```

`better-sqlite3` 是原生模块，普通 Node 测试和 Electron 运行需要不同 ABI。项目脚本已经处理：

- `npm run dev` 会先执行 `electron-rebuild -f -w better-sqlite3`，再启动 Electron。
- `npm test` 会先执行 `npm rebuild better-sqlite3`，再运行 Vitest。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm run pack
```

`npm run pack` 会生成 onedir 产物：

```text
release/win-unpacked/Easy Music.exe
```

## 数据位置

运行时数据保存在 Electron 的 `userData` 目录下：

- `library.db`：歌单、歌曲、下载任务、音乐源、设置。
- 下载文件：默认目录为空，需要用户在工具顶部手动选择；选择后会记住该目录。

## 许可说明

本项目使用 Apache-2.0 许可。部分下载流程、音乐源协议和元数据写入思路参考 LX Music Desktop，说明见 `licenses/LX-MUSIC-NOTICE.md`。

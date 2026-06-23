import fs from 'node:fs'
import path from 'node:path'

const input = process.argv[2]
const output = process.argv[3]

if (!input || !output) {
  console.error('用法：node tools/debug/create-lx-debug-source.mjs <原音源脚本> <调试音源输出路径>')
  process.exit(1)
}

const source = fs.readFileSync(input, 'utf8')

const header = `/*!
 * @name easy-music参数调试源
 * @description 基于用户现有音源生成，仅额外记录洛雪 musicUrl 入参到本地日志接收器
 * @version debug
 * @author easy-music-debug
 */
`

let script = source.replace(/\/\*![\s\S]+?\*\//, header.trim())

script = script.replace(
  'const SCRIPT_MD5',
  'const DEBUG_LOG_URL = "http://127.0.0.1:39117/lx-debug-log";\nconst SCRIPT_MD5',
)

script = script.replace(
  /const httpFetch = \(url, options = \{method: "GET"\}\) => \{[\s\S]+?\n\};/,
  `$&

const safeDebugClone = (value) => {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (err) {
        return { __debugString: String(value) };
    }
};

const logLxMusicInfo = async (source, quality, musicInfo) => {
    const payload = {
        event: "musicUrl",
        loggedAt: new Date().toISOString(),
        source,
        quality,
        musicId: musicInfo?.hash ?? musicInfo?.songmid,
        musicInfo: safeDebugClone(musicInfo),
        top: {
            id: musicInfo?.id,
            source: musicInfo?.source,
            name: musicInfo?.name,
            singer: musicInfo?.singer,
            albumName: musicInfo?.albumName,
            songmid: musicInfo?.songmid,
            hash: musicInfo?.hash,
            interval: musicInfo?.interval,
        },
        meta: safeDebugClone(musicInfo?.meta ?? null),
    };
    try {
        await httpFetch(DEBUG_LOG_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            timeout: 3000,
        });
    } catch (err) {
        console.log("easy-music debug log failed", err);
    }
};`,
)

script = script.replace(
  'const songId = musicInfo.hash ?? musicInfo.songmid;',
  'await logLxMusicInfo(source, quality, musicInfo);\n    const songId = musicInfo.hash ?? musicInfo.songmid;',
)

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, script, 'utf8')
console.log(`调试音源已生成：${output}`)

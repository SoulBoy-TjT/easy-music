import fs from 'node:fs'

export class InvalidAudioPayloadError extends Error {
  constructor(ext: string) {
    super(ext === 'mp3' ? '下载内容不是有效的 MP3 音频' : `下载内容不是有效的 ${ext.toUpperCase()} 音频`)
  }
}

export function validateDownloadedAudioFile(filePath: string, ext: string): void {
  const data = fs.readFileSync(filePath)
  if (ext === 'mp3') {
    validateMp3(data)
    return
  }
  if (ext === 'flac') {
    validateFlac(data)
  }
}

export function isReusableDownloadedAudioFile(filePath: string, ext: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false
  try {
    validateDownloadedAudioFile(filePath, ext)
    return true
  } catch {
    return false
  }
}

function validateFlac(data: Buffer): void {
  if (data.subarray(0, 4).toString('ascii') !== 'fLaC') throw new InvalidAudioPayloadError('flac')
}

function validateMp3(data: Buffer): void {
  let offset = 0
  if (data.subarray(0, 3).toString('ascii') === 'ID3' && data.length >= 10) {
    offset = 10 + synchsafeToInt(data.subarray(6, 10))
  }
  if (!isValidMp3FrameHeader(data, offset)) throw new InvalidAudioPayloadError('mp3')
}

function synchsafeToInt(bytes: Buffer): number {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f)
}

function isValidMp3FrameHeader(data: Buffer, offset: number): boolean {
  if (offset < 0 || offset + 4 > data.length) return false
  const b1 = data[offset + 1]
  const b2 = data[offset + 2]
  return (
    data[offset] === 0xff &&
    (b1 & 0xe0) === 0xe0 &&
    ((b1 >> 3) & 0x03) !== 0x01 &&
    ((b1 >> 1) & 0x03) !== 0x00 &&
    ((b2 >> 4) & 0x0f) !== 0x00 &&
    ((b2 >> 4) & 0x0f) !== 0x0f &&
    ((b2 >> 2) & 0x03) !== 0x03
  )
}

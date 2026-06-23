import type { EasyMusicApi } from '../preload'

declare global {
  interface Window {
    easyMusic: EasyMusicApi
  }
}

export {}

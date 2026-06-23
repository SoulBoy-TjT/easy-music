!macro customUnInstall
  ${ifNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 Easy Music 的本地数据？$\r$\n$\r$\n将删除歌单数据库、设置、音乐源和缓存。已下载或转换的音乐文件不会被删除。" IDNO keepEasyMusicAppData
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\easy-music"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    keepEasyMusicAppData:
  ${endIf}
!macroend

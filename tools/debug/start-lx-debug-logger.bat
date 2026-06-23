@echo off
setlocal
cd /d "%~dp0\..\.."
node tools\debug\lx-debug-log-server.mjs

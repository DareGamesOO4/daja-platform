@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-local-stilius.ps1" -InstallAll -PreserveWorkerConfig
set "daja_update_status=%errorlevel%"
pause
exit /b %daja_update_status%

@echo off
setlocal
set "LAB_DIR=%~dp0.."
set "EXTENSION_DIR=%~dp0..\..\linuxdo-personal-feed-manager"
set "PROFILE_DIR=%LAB_DIR%\.browser-profile"
set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "DEBUG_PORT=9227"

if not exist "%EXTENSION_DIR%\manifest.json" echo Extension not found: %EXTENSION_DIR% & exit /b 1
if not exist "%BROWSER%" echo Edge not found: %BROWSER% & exit /b 1
if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

start "" "%BROWSER%" --remote-debugging-port=%DEBUG_PORT% --user-data-dir="%PROFILE_DIR%" --load-extension="%EXTENSION_DIR%" --no-first-run --no-default-browser-check --disable-gpu-sandbox --use-angle=gl "https://linux.do/latest"

echo Browser launched.
echo Profile: %PROFILE_DIR%
echo CDP port: %DEBUG_PORT%

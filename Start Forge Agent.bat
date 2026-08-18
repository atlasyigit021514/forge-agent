@echo off
cd /d "%~dp0"
start "Forge Agent" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4317"

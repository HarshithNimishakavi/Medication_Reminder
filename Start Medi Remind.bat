@echo off
cd /d "%~dp0backend"
start "Medi Remind server" cmd /k npm start
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

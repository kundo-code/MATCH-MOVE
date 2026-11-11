@echo off
chcp 65001 >nul
REM MATCH-MOVE 실행 (Windows): 더블클릭하면 서버가 켜지고 브라우저가 열립니다.
REM 이 창을 닫거나 Ctrl+C를 누르면 서버가 종료됩니다.
cd /d "%~dp0"
echo === MATCH-MOVE 시작 ===

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

where git >nul 2>nul
if not errorlevel 1 if exist .git (
  echo 최신 버전 확인 중...
  git pull --ff-only
)

if not exist node_modules (
  echo 패키지 설치 중... 처음 한 번만 오래 걸립니다.
  call npm install
  if errorlevel 1 (
    echo 패키지 설치에 실패했습니다.
    pause
    exit /b 1
  )
)

echo 서버를 시작합니다. 잠시 후 브라우저가 열립니다.
call npm run dev -- --open
pause

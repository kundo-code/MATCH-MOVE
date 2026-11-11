#!/bin/bash
# MATCH-MOVE 실행 (Mac): 이 파일을 더블클릭하면 서버가 켜지고 브라우저가 열립니다.
# 이 창을 닫거나 Ctrl+C를 누르면 서버가 종료됩니다.
cd "$(dirname "$0")" || exit 1

echo "=== MATCH-MOVE 시작 ==="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  read -n 1 -s -r -p "아무 키나 누르면 창이 닫힙니다..."
  exit 1
fi

# 최신 코드 받기 (인터넷이 없거나 실패해도 그대로 진행)
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  echo "최신 버전 확인 중..."
  git pull --ff-only 2>&1 | tail -2 || true
fi

# 처음 실행이거나 패키지가 바뀐 경우에만 설치
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "패키지 설치 중... (처음 한 번만 오래 걸립니다)"
  npm install || { echo "패키지 설치에 실패했습니다."; read -n 1 -s -r -p "아무 키나 누르면 창이 닫힙니다..."; exit 1; }
fi

echo "서버를 시작합니다. 잠시 후 브라우저가 열립니다. (종료: 이 창 닫기 또는 Ctrl+C)"
npm run dev -- --open

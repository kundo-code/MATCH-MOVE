# MATCH-MOVE

**골프 코스 완전정복용 AI 드론 영상 시스템**
Golf Course Drone Match Move / Course Intelligence — `COURSE INTELLIGENCE MASTER PROMPT v1.0`

카카오맵 코스맵 + 야디지북 + 드론 영상을 입력하면, **검증된 코스 정보만**을 실제 지형에
Match Move 방식으로 고정 표시하는 파이프라인입니다. 홀·거리·벙커·OB·Penalty Area·공략
루트가 실제 촬영 카메라에 락(lock)되어, 드론이 움직여도 지면에서 떨어지거나 미끄러지지
않습니다.

이 저장소의 핵심은 "예쁜 그래픽"이 아니라 **세 가지 전제를 코드로 강제한다**는 점입니다.

| 전제 | 강제하는 위치 |
|---|---|
| ① 확인되지 않은 거리·OB·Penalty Area·경사 수치는 생성하지 않는다 | `matchmove/confidence.py` — 모든 데이터가 출처를 들고 다니고, 근거가 부족하면 **화면에 도달하지 못함** |
| ② 당일 홀컵은 사용하지 않고 Green Center를 표준 Target으로 통일한다 | `matchmove/spec.py` — Green Center가 홀 좌표계의 **원점**이며, `PIN`/`HOLE CUP` 라벨은 예외를 던짐 |
| ③ 원본 드론 영상의 지형과 카메라 움직임을 임의 변경하지 않는다 | `matchmove/camera.py` — 카메라 트랙은 read-only로 잠기고, 파이프라인은 **측정만** 함 |

마스터 프롬프트 전문(36개 섹션)은 [`matchmove/data/master_prompt_v1.0.md`](matchmove/data/master_prompt_v1.0.md)에
그대로 보관되어 있으며, 코드의 각 모듈은 자신이 구현하는 섹션 번호를 명시합니다.

---

## 빠른 시작

```bash
git clone <this repo> && cd MATCH-MOVE
pip install -e .

# 합성 데모 홀로 전체 파이프라인 실행 (실제 골프장 아님 — 테스트용 지오메트리)
matchmove demo -o out/demo
open out/demo/hole07_preview.html
```

`out/demo/hole07_preview.html`이 **QC 플레이어**입니다. 프레임을 스크럽하면서 마커가
지면에 붙어 있는지, 6단계 정보 공개가 제대로 도는지, 무엇이 검증 실패로 제외됐는지를
그림 옆에서 바로 확인할 수 있습니다.

---

## 실제 홀 작업 흐름

### 1. 홀 폴더 만들기

```bash
matchmove init hole07/
# hole07/hole.json      <- 홀 데이터 (그린·티·벙커·거리)
# hole07/project.json   <- 카메라 · 앵커 · 지형
```

두 파일은 서로 참조하도록 이름이 맞춰져 나옵니다. 파일 안의 `_help` 항목은 채우는
사람을 위한 설명이며 실행 시 무시됩니다. **확인 못 한 값은 `null`로 두세요** —
비워두면 제외되고, 지어내지 않습니다.

### 2. 홀 데이터 채우기 (`hole07.json`)

좌표계는 **미터 단위 ENU이며 원점이 Green Center**입니다. `+x` 동쪽, `+y` 북쪽, `+z` 위.
그래서 그린은 `[0,0,0]` 부근, 티박스는 홀 축을 따라 큰 음수 좌표를 갖습니다.

모든 항목은 `source`와 `confidence`를 함께 적습니다.

| confidence | 의미 | 인정 출처 |
|---|---|---|
| `A` CONFIRMED | 공식 데이터 / 신뢰 가능한 야디지북 | `official`, `yardage_book` |
| `B` VISUALLY MATCHED | 지도 ↔ 야디지북 ↔ 드론 상호 대조로 식별 | `course_map`, `drone` |
| `C` ESTIMATED | 눈대중 추정 | `estimate` |

**출처는 자기 자신을 승격시키지 못합니다.** 드론 영상만 보고 `A`라고 적어도 시스템이
자동으로 `B`로 강등합니다. 그리고 표시 하한선은 종류별로 다릅니다.

| 정보 종류 | 필요 등급 | 근거 |
|---|---|---|
| 거리(m/yd) | `A` | 섹션 14 · 32 |
| OB / Red · Yellow Penalty Area | `A` | 섹션 19 · 20 |
| 그린 경사 % / 컨투어 | `A` | 섹션 23 · 24 |
| 그린·티·벙커·워터 등 눈에 보이는 지오메트리 | `B` | 섹션 04 · 21 |

기준에 못 미치면 **대체값을 만들지 않고 제외**하며, 제외 사유는 결과물에 목록으로 남습니다.

#### 코스맵 캡처에서 지오메트리 뽑기

카카오맵/위성 캡처는 좌표계가 없는 스크린샷입니다. 실제 위치를 아는 랜드마크
2개 이상(어파인 보정은 3개 이상)을 알려주면 픽셀 → 미터 변환을 맞춰줍니다.

```python
from matchmove import MapLandmark, fit_map_reference, FeatureType

ref = fit_map_reference([
    MapLandmark("green_center", (904, 618), Vec3(0, 0, 0)),
    MapLandmark("tee_white",    (881, 1533), Vec3(-6, -320, 0)),
    MapLandmark("bunker_lip",   (979, 1041), Vec3(28, -148, 0)),
])
ok, msg = ref.check()          # 자기 랜드마크도 못 맞추면 트레이싱 금지
print(msg)                     # affine fit ... RMS 0.21m, worst 0.44m, 0.350 m/px

green = ref.feature("green", FeatureType.GREEN,
                    [(880, 600), (921, 597), (925, 640), (884, 643)])
```

`ref.check()`가 실패하면 랜드마크별 잔차를 모두 출력합니다 — 최소제곱은 오차를
전체에 퍼뜨리므로, 목록을 보고 튀는 지점을 직접 찾아야 합니다.

> 참고: 야디지북/코스맵 **이미지를 자동으로 읽어내는 단계는 이 파이프라인에 없습니다.**
> 사람(또는 별도 비전 모델)이 피처를 트레이싱해서 홀 스펙에 넣습니다. 야디지 숫자를
> 자동 판독하면 바로 그 지점에서 잘못된 거리가 만들어지기 때문에, 의도적으로 사람의
> 확인을 거치게 되어 있습니다.

### 3. 앵커 마킹 (`project.json`)

드론 프레임에서 **움직이지 않는 지형지물** 4개 이상을 찍고, 그 지점이 코스맵상 어디인지
적습니다 (섹션 05 우선순위: Green Center → 티박스 → 주요 벙커 → 워터 경계 → 페어웨이
커브 → 카트패스 → 트리라인 → 건물 → 능선).

```json
"anchors": {
  "0":   [{"anchor_id": "green_center", "world": [0, 0, 0], "x": 1920, "y": 1180}, ...],
  "120": [{"anchor_id": "green_center", "world": [0, 0, 0], "x": 1918, "y": 1090}, ...]
}
```

`world` 대신 `lat`/`lon`으로 적어도 됩니다(홀 스펙의 `datum`에 Green Center 좌표를 넣으면
자동 변환). SynthEyes·3DEqualizer·Blender에서 이미 푼 트랙이 있다면 `camera_track`으로
바로 넣고 앵커 단계를 건너뛸 수 있습니다.

### 4. 실행

```bash
matchmove solve    project.json          # 카메라 해 + 프레임별 재투영 오차
matchmove validate project.json          # 섹션 36 최종 검증만
matchmove brief    project.json          # 검증 통과한 홀 데이터 블록
matchmove prompt   project.json          # 마스터 프롬프트 + 홀 데이터 (영상 생성용)
matchmove render   project.json -o out/  # 전체 파이프라인 + 모든 익스포트
```

---

## 파이프라인

```
레퍼런스 (카카오맵 · 야디지북 · 드론 영상)
        │
        ├─ 앵커 대응점 ──→ 카메라 해 (DLT 호모그래피 → LM 정밀화)   camera.py / solve.py
        │                     · 재투영 RMS, 앵커별 드리프트 리포트
        │
        ├─ 오버레이 생성 ──→ Green Center 마커 · 공략 루트 · LZ ·   overlay.py
        │                     벙커 · 워터 · OB · 경사 방향
        │                     · 지형 컨폼 + 원근/깊이 스케일       terrain.py
        │                     · 전경 오클루전 (정확한 교차 판정)    occlusion.py
        │
        ├─ 신뢰도 게이트 ──→ 미달 항목 제외 + 사유 기록             confidence.py
        │
        ├─ 최종 검증 ──────→ 섹션 36 체크리스트                     validate.py
        │                     실패 항목은 대체하지 않고 제거
        │
        ├─ 6단계 시퀀스 ──→ 카메라의 실제 홀 진행도로 구간 분할      sequence.py
        │                     ESTABLISHING → TEE SHOT → LANDING ZONE
        │                     → APPROACH → GREEN → GREEN ANALYSIS
        │
        └─ 익스포트                                                  exporters/
              hole07_preview.html   스크럽 가능한 QC 플레이어
              hole07_overlay.json   프레임별 오버레이 트랙 (컴포지터/웹플레이어용)
              hole07_matchmove.jsx  After Effects — 3D 카메라 + 앵커 널
              hole07_matchmove.py   Blender — 카메라 애니메이션 + 커브
              hole07_camera.chan    Nuke / 3DEqualizer 카메라
              hole07_frame*.svg     단일 프레임 SVG
              hole07_brief.md       검증된 홀 데이터 + 제외 목록
              hole07_prompt.md      마스터 프롬프트 + 홀 데이터
              hole07_validation.txt 섹션 36 리포트
```

---

## 6단계 정보 공개 (섹션 25)

구간 경계는 스톱워치가 아니라 **카메라가 티 → Green Center 축에서 실제로 얼마나
전진했는지**로 정해집니다. 티 지오메트리가 없으면 균등 분할로 물러서고, 리포트에
그렇게 했다고 적습니다.

| PHASE | 표시 | 정리 |
|---|---|---|
| 01 ESTABLISHING | HOLE / PAR / 거리 | 홀 전체 파악 |
| 02 TEE SHOT | TEE → CENTER, LANDING ZONE, 티샷 리스크 | 공략 방향 |
| 03 LANDING ZONE | LZ + 인접 리스크 | 티 정보 회수 |
| 04 APPROACH | 어프로치 루트, 그린사이드 리스크 | Green Center로 중심 이동 |
| 05 GREEN | Green Center + 인접 해저드만 | 코스 전역 그래픽 정리 |
| 06 GREEN ANALYSIS | 그린 형상 · 경사 방향 (확인 시 %) | 최종 초점 = Green Center |

각 구간은 읽을 수 있는 최소 길이(기본 1.4초)를 보장받되, **전체 길이는 절대 변하지
않습니다** — 원본 푸티지는 리타이밍되지 않습니다.

---

## Green Center 규칙 (섹션 11 · 12 · 13 · 33)

- Target은 **모든 홀에서 Green Center** 하나로 통일됩니다.
- Green Center는 그린 폴리곤의 **기하 중심**으로 계산되며, 추정한 핀 위치가 아닙니다.
- 라벨은 `GREEN CENTER` 또는 `CENTER`만 허용됩니다. `PIN`, `HOLE CUP`, `핀`, `홀컵` 등을
  붙이려 하면 `TargetLabelError`가 발생하고, 최종 검증에서도 FAIL로 잡힙니다.
- 검증은 Green Center가 실제로 그린 폴리곤 **안에** 떨어지는지까지 확인합니다.

---

## 트래킹 품질

솔버는 앵커 대응점에서 정규화 DLT 호모그래피로 초기 자세를 구한 뒤, 전체 앵커에 대해
재투영 오차를 Levenberg–Marquardt로 최소화합니다. 렌즈 메타데이터가 불확실하면
`refine_focal`로 초점거리도 함께 풉니다.

리포트에는 프레임별 RMS/최대 잔차와 **앵커별 드리프트 기울기(px/frame)** 가 들어갑니다.
잔차가 시간에 따라 우상향하면 그래픽이 서서히 미끄러진다는 뜻이고, 검증에서 FAIL로
걸립니다.

테스트는 마커의 화면 좌표를 매 프레임 다시 지면으로 역투영해서 같은 월드 좌표로
돌아오는지 확인합니다(허용 오차 1e-6 m).

```bash
pip install pytest && python -m pytest -q     # 112 tests
```

---

## 모듈 지도

| 모듈 | 담당 섹션 |
|---|---|
| `geo.py` | WGS84 ↔ ENU 변환, 폴리곤 중심/면적 |
| `mapref.py` | 01B 코스맵 캡처 지오레퍼런싱 (픽셀 → 미터) |
| `confidence.py` | 02 출처 우선순위, 03 신뢰도, 32 안티할루시네이션 |
| `spec.py` | 04 피처 인식, 10 홀 정보, 11–13 Green Center, 35 입력 템플릿 |
| `camera.py` | 06 카메라 분석, 07 매치무브 (핀홀 모델·트랙·투영) |
| `solve.py` | 05 앵커 매칭, 07 지면 평면 트래킹 (DLT + LM) |
| `terrain.py` | 08 지형 인식 트래킹, 지형 컨폼 |
| `occlusion.py` | 09 오클루전 (정확한 선분–다각형 교차) |
| `overlay.py` | 13–24 AR 요소, 27 그래픽 디자인, 28 모션 |
| `sequence.py` | 25 정보 공개 순서, 26 정보 위계 |
| `validate.py` | 36 최종 검증 |
| `prompt.py` | 마스터 프롬프트 + 홀별 데이터 블록 렌더링 |
| `project.py` | 전체 파이프라인 |
| `exporters/` | AE · Blender · Nuke · JSON · SVG · HTML QC |

---

## 예제

`examples/demo_hole07/` — 합성 데모 홀. **실제 골프장이 아니며 야디지도 가상입니다.**
일부러 거부되어야 할 데이터를 섞어 두었습니다.

- 확인되지 않은 워터 → Penalty Area가 아니라 `WATER`로만 표시
- 드론 영상만으로 그린 OB 라인 → 표시 거부, 사유 기록
- 추정 경사 2.4% → 숫자는 제외하고 방향만 표시

```bash
matchmove render examples/demo_hole07/project.json -o out/example
```

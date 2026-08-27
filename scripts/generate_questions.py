#!/usr/bin/env python3
"""
MATCH-MOVE 골프 AI 질문 마스터 DB 생성기

40대/50대/60대/70대 한국 골퍼가 AI(챗GPT/제미나이 등)나 검색엔진에
실제로 물어볼 가능성이 높은 골프 여행 관련 질문을 아래 14개 카테고리 체계로
조합 생성한다.

  국가 → 지역 → 골프장 → 패키지 → 가격 → 날씨 → 이동 → 숙박 → 식사
  → 후기 → 여행사 신뢰 → 안전 → 비교 → 구매

실행:
    python3 scripts/generate_questions.py
출력:
    data/master_questions.csv   (마스터 질문 DB, ~700행)
    data/score_config.csv       (GADS/ARS 가중치 설정값)

점수 체계는 docs/DESIGN.md 의 "GADS/ARS 점수체계" 절 참고.
"""

import csv
import hashlib
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

# ---------------------------------------------------------------------------
# 1. 목적지 (국가-지역) : 한국 시니어 골퍼가 실제 많이 가는 해외/국내 골프 여행지
# ---------------------------------------------------------------------------
# (국가, 지역, 인기도티어 1=최상 2=상 3=중)
DESTINATIONS = [
    ("베트남", "다낭", 1),
    ("베트남", "하노이", 2),
    ("베트남", "호치민", 2),
    ("베트남", "무이네", 3),
    ("베트남", "달랏", 3),
    ("태국", "방콕", 1),
    ("태국", "파타야", 2),
    ("태국", "치앙마이", 3),
    ("태국", "후아힌", 3),
    ("필리핀", "세부", 1),
    ("필리핀", "클락", 2),
    ("필리핀", "마닐라", 3),
    ("중국", "하이난(산야)", 2),
    ("일본", "오키나와", 1),
    ("일본", "규슈(가고시마)", 2),
    ("일본", "홋카이도", 3),
    ("캄보디아", "씨엠립", 3),
    ("말레이시아", "쿠알라룸푸르", 3),
    ("대한민국", "제주", 1),
    ("대한민국", "남해", 2),
    ("대한민국", "경주", 3),
]

AGE_GROUPS = ["40대", "50대", "60대", "70대"]

# ---------------------------------------------------------------------------
# 2. 카테고리별 질문 원형 (템플릿)
#    dest_templates : {지역} 치환, 목적지별로 전개
#    age_templates   : {지역},{연령대} 치환, 연령대 이슈가 강한 카테고리에만 적용
#    general_templates: 목적지 무관 일반/비교형 질문
# ---------------------------------------------------------------------------
CATEGORIES = {
    "국가": {
        "gads_base": 65,
        "dest_templates": [
            "{국가} 골프여행 요즘 갈만한가요?",
            "{국가}{은는} 몇 월에 골프 치기 가장 좋아요?",
            "{국가} 골프여행 처음인데 초보 코스도 괜찮나요?",
            "{국가} 비자 없이 골프여행 갈 수 있나요?",
            "{국가} 골프여행 왕복 비행시간 얼마나 걸려요?",
        ],
        "general_templates": [
            "은퇴 후 골프여행 가기 좋은 나라 추천해주세요.",
            "50대 부부가 같이 가기 좋은 골프여행 국가는 어디예요?",
            "동남아 골프여행 국가 중 물가 저렴한 곳은 어디인가요?",
        ],
    },
    "지역": {
        "gads_base": 63,
        "dest_templates": [
            "{지역} 골프여행 몇 박 몇 일이 적당한가요?",
            "{지역}에 골프장이 몇 개나 있나요?",
            "{지역} 골프투어 비수기는 언제예요?",
            "{지역} 골프장은 시내에서 얼마나 걸리나요?",
        ],
        "general_templates": [
            "국내 골프여행지 중 겨울에도 라운딩 가능한 곳은 어디인가요?",
            "제주도와 동남아 골프여행 중 어디가 더 나을까요?",
        ],
    },
    "골프장": {
        "gads_base": 80,
        "dest_templates": [
            "{지역}에서 시니어가 치기 편한 골프장 추천해주세요.",
            "{지역} 골프장 그린피 카트비 포함인가요?",
            "{지역} 골프장 페어웨이 상태 어떤가요?",
            "{지역} 골프장 캐디 한국어 가능한가요?",
            "{지역} 명문 골프장은 어디예요?",
            "{지역} 골프장 예약은 얼마나 전에 해야 하나요?",
        ],
        "general_templates": [
            "노년층도 무리없이 걸을 수 있는 평지 골프장 어디 있나요?",
        ],
    },
    "패키지": {
        "gads_base": 78,
        "dest_templates": [
            "{지역} 3박5일 골프패키지 일정 어떻게 짜여있나요?",
            "{지역} 골프패키지에 라운딩 몇 회 포함되나요?",
            "{지역} 골프패키지 자유일정 추가할 수 있나요?",
            "{지역} 골프패키지 단체(계모임)로 가면 할인되나요?",
        ],
        "general_templates": [
            "부부동반 골프패키지랑 남성 전용 패키지랑 뭐가 달라요?",
            "골프 안 치는 배우자도 같이 갈 수 있는 패키지 있나요?",
        ],
    },
    "가격": {
        "gads_base": 90,
        "dest_templates": [
            "{지역} 골프여행 4박6일 총 비용 얼마나 드나요?",
            "{지역} 골프패키지 1인 기준 최저가 얼마예요?",
            "{지역} 그린피 포함 패키지 가격이 왜 여행사마다 다른가요?",
            "{지역} 골프여행 성수기 가격 얼마나 오르나요?",
            "{지역} 골프여행 캐디피 팁은 얼마나 챙겨야 하나요?",
        ],
        "general_templates": [
            "60대 부부 골프여행 예산 얼마 정도 잡아야 하나요?",
            "골프여행 가격에 포함 안 되는 숨은 비용은 뭐가 있나요?",
            "카드 할부로 골프패키지 결제 가능한가요?",
        ],
    },
    "날씨": {
        "gads_base": 60,
        "dest_templates": [
            "{지역} 이번 주 날씨 골프 치기 괜찮나요?",
            "{지역} 우기에도 골프여행 가도 되나요?",
            "{지역} 골프여행 갈 때 자외선 대비 어떻게 해야 하나요?",
        ],
        "age_templates": [
            "{연령대}가 {지역} 더운 날씨에 라운딩해도 무리 없을까요?",
        ],
        "general_templates": [
            "무더위에 4라운드 연속 도는 게 체력적으로 괜찮을까요?",
        ],
    },
    "이동": {
        "gads_base": 68,
        "dest_templates": [
            "{지역} 공항에서 골프장까지 이동시간 얼마나 걸려요?",
            "{지역} 골프여행 중 이동은 전용버스로 하나요?",
            "{지역} 인천공항 직항 있나요, 경유해야 하나요?",
            "{지역} 골프백 위탁수하물 규정이 어떻게 되나요?",
        ],
        "age_templates": [
            "{연령대}인데 {지역}까지 장시간 비행 괜찮을까요?",
            "무릎이 안 좋은 {연령대}도 {지역} 골프카트 이동 괜찮을까요?",
        ],
        "general_templates": [
            "휠체어나 보행보조기 필요한 어르신도 골프여행 갈 수 있나요?",
        ],
    },
    "숙박": {
        "gads_base": 70,
        "dest_templates": [
            "{지역} 골프패키지 숙소는 몇 성급 호텔인가요?",
            "{지역} 골프텔이랑 일반 리조트 중 뭐가 나아요?",
            "{지역} 숙소에서 조식 잘 나오나요?",
            "{지역} 숙소 트윈룸 싱글룸 추가요금 얼마예요?",
        ],
        "age_templates": [
            "{연령대} 부부라 침대 낮은 숙소로 바꿀 수 있나요?",
        ],
        "general_templates": [
            "골프장 안에 있는 숙소랑 시내 호텔 중 어디가 편해요?",
        ],
    },
    "식사": {
        "gads_base": 55,
        "dest_templates": [
            "{지역} 골프패키지 식사는 한식 나오나요?",
            "{지역} 현지식이 입에 안 맞으면 어떡하나요?",
            "{지역} 골프장 클럽하우스 식사 별도 비용인가요?",
        ],
        "general_templates": [
            "당뇨나 혈압 때문에 식단 조절 필요한데 현지식 괜찮을까요?",
            "골프여행 중 한식당 따로 방문하는 일정 있나요?",
        ],
    },
    "후기": {
        "gads_base": 85,
        "dest_templates": [
            "{지역} 골프투어 다녀온 사람들 후기 어때요?",
            "{지역} 골프패키지 실제로 가보니 사진이랑 다르던가요?",
            "{지역} 골프장 코스관리 후기 좋은 곳 알려주세요.",
        ],
        "general_templates": [
            "60대 이상 골퍼들이 남긴 여행 후기 어디서 볼 수 있나요?",
            "골프여행 후기 믿을만한 카페나 블로그 추천해주세요.",
            "여행사 후기 조작인지 아닌지 어떻게 구별하나요?",
        ],
    },
    "여행사신뢰": {
        "gads_base": 75,
        "dest_templates": [
            "{지역} 골프여행 전문 여행사 어디가 믿을만한가요?",
        ],
        "general_templates": [
            "골프여행 여행사 사기 안 당하려면 뭘 확인해야 하나요?",
            "여행사 상품 계약 전에 어떤 서류를 요구해야 하나요?",
            "골프여행 예약금 환불 규정은 어떻게 확인하나요?",
            "여행사가 갑자기 폐업하면 예약금은 어떻게 되나요?",
            "공정거래위원회 등록된 골프여행사인지 확인하는 방법 있나요?",
            "여행사 없이 개인이 직접 골프패키지 예약해도 괜찮을까요?",
        ],
    },
    "안전": {
        "gads_base": 73,
        "dest_templates": [
            "{지역} 골프여행 여행자보험 꼭 들어야 하나요?",
            "{지역} 치안은 안전한 편인가요?",
            "{지역}에서 갑자기 아프면 병원 이용 어떻게 하나요?",
        ],
        "age_templates": [
            "지병 있는 {연령대}가 {지역} 골프여행 가도 안전할까요?",
            "혈압약, 당뇨약 챙겨서 {지역} 골프여행 가도 되나요?",
        ],
        "general_templates": [
            "골프여행 중 낙상이나 부상 대비 어떻게 해야 하나요?",
            "해외 골프여행 중 응급상황 발생하면 누구한테 연락하나요?",
        ],
    },
    "비교": {
        "gads_base": 88,
        "dest_templates": [
            "{지역} 골프여행 다른 지역이랑 비교하면 어떤 장점 있나요?",
        ],
        "general_templates": [
            "베트남과 태국 골프여행 중 어디가 더 나을까요?",
            "패키지여행이랑 자유여행 골프투어 중 뭐가 나을까요?",
            "동남아 골프여행 여행사 A사 B사 상품 차이가 뭔가요?",
            "국내 골프여행이랑 해외 골프여행 가성비 비교해주세요.",
            "저가 골프패키지랑 고급 골프패키지 실제로 뭐가 다른가요?",
            "50대 60대 70대 골퍼별로 추천 여행지가 다른가요?",
        ],
    },
    "구매": {
        "gads_base": 82,
        "dest_templates": [
            "{지역} 골프패키지 지금 예약하면 얼마나 할인되나요?",
            "{지역} 골프여행 성수기 예약은 언제 마감되나요?",
        ],
        "general_templates": [
            "골프여행 얼리버드 할인 언제부터 시작하나요?",
            "지인 소개하면 골프패키지 추가 할인 받을 수 있나요?",
            "카카오톡 상담만으로 골프패키지 예약 확정되나요?",
            "골프패키지 계약금은 보통 얼마를 걸어야 하나요?",
            "네이버 카페 공동구매 골프패키지 믿고 사도 되나요?",
        ],
    },
}

L1_ORDER = ["국가", "지역", "골프장", "패키지", "가격", "날씨", "이동", "숙박",
            "식사", "후기", "여행사신뢰", "안전", "비교", "구매"]

# 카테고리별 대상 목적지 수를 제한해 총량을 500~1000 사이로 통제
DEST_SAMPLE_SIZE = {
    "국가": 10, "지역": 10, "골프장": 12, "패키지": 10, "가격": 12,
    "날씨": 8, "이동": 8, "숙박": 8, "식사": 8, "후기": 10,
    "여행사신뢰": 6, "안전": 8, "비교": 6, "구매": 8,
}

CONTENT_TYPE_HEAVY = {"가격", "비교", "후기", "안전", "여행사신뢰", "구매"}


def has_batchim(word):
    """마지막 글자에 받침이 있는지 (한글 완성형 유니코드 계산)"""
    ch = word[-1]
    code = ord(ch)
    if 0xAC00 <= code <= 0xD7A3:
        return (code - 0xAC00) % 28 != 0
    return False


def josa_eun_neun(word):
    return "은" if has_batchim(word) else "는"


def josa_i_ga(word):
    return "이" if has_batchim(word) else "가"


def score_hash(text, mod):
    """질문 문자열 기반 결정적(재현가능) 해시 값 -> 0..mod-1"""
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return int(h[:8], 16) % mod


def compute_gads(category, dest_tier, question):
    base = CATEGORIES[category]["gads_base"]
    tier_bonus = {1: 6, 2: 2, 3: -2}.get(dest_tier, 0)
    jitter = score_hash(question, 9) - 4  # -4..+4
    val = base + tier_bonus + jitter
    return max(1, min(100, val))


def compute_ars(question, idx):
    # 신규 백로그 DB이므로 대부분 미제작(저ARS), 약 6%만 이미 콘텐츠 보유로 시뮬레이션
    if idx % 17 == 0:
        return 60 + score_hash(question, 31)  # 60..90 (이미 대응중)
    return score_hash(question, 35)  # 0..34 (미제작 backlog)


def build_rows():
    rows = []
    idx = 0
    for l1 in L1_ORDER:
        cfg = CATEGORIES[l1]
        dest_n = DEST_SAMPLE_SIZE[l1]
        dests = DESTINATIONS[:dest_n]

        for country, region, tier in dests:
            for tmpl in cfg.get("dest_templates", []):
                q = tmpl.format(**{
                    "국가": country,
                    "지역": f"{country} {region}",
                    "은는": josa_eun_neun(country),
                })
                rows.append((l1, country, region, "", q, tier))
                idx += 1

        for tmpl in cfg.get("age_templates", []):
            for country, region, tier in dests[: max(4, dest_n // 2)]:
                for age in AGE_GROUPS:
                    q = tmpl.format(**{"연령대": age, "지역": f"{country} {region}"})
                    rows.append((l1, country, region, age, q, tier))
                    idx += 1

        for tmpl in cfg.get("general_templates", []):
            rows.append((l1, "", "", "", tmpl, 2))
            idx += 1

    # 중복 질문 제거 (동일 문구가 우연히 겹치는 경우)
    seen = set()
    dedup = []
    for r in rows:
        q = r[4]
        if q in seen:
            continue
        seen.add(q)
        dedup.append(r)
    return dedup


def main():
    rows = build_rows()
    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, "master_questions.csv")

    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([
            "ID", "L1_카테고리", "국가", "지역", "연령대", "질문",
            "GADS", "ARS", "Opportunity", "콘텐츠상태", "콘텐츠타입후보",
            "콘텐츠링크", "최종업데이트일", "담당자", "비고",
        ])
        for i, (l1, country, region, age, question, tier) in enumerate(rows, start=1):
            gads = compute_gads(l1, tier, question)
            ars = compute_ars(question, i)
            opp = gads - ars
            status = "완료" if ars >= 60 else "미제작"
            ctype = "블로그+쇼츠" if l1 in CONTENT_TYPE_HEAVY else "블로그"
            qid = f"MM-{i:04d}"
            w.writerow([
                qid, l1, country, region, age, question,
                gads, ars, opp, status, ctype, "", "", "", "",
            ])

    print(f"생성 완료: {len(rows)}행 -> {out_path}")

    # 점수 가중치 설정 테이블 (Score_Config 탭용)
    cfg_path = os.path.join(DATA_DIR, "score_config.csv")
    with open(cfg_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["지표", "구성요소", "가중치", "설명"])
        w.writerow(["GADS", "검색량추정(Search Volume Proxy)", "35%", "네이버 데이터랩/구글트렌드/키워드플래너 상대값"])
        w.writerow(["GADS", "시급성/시즌성(Seasonality)", "20%", "현재 시점 관련 질문일수록 가중"])
        w.writerow(["GADS", "구매전환근접도(Purchase Intent)", "30%", "가격/비교/구매 카테고리는 가중치 상향"])
        w.writerow(["GADS", "연령대적합성(Age-fit 40~70)", "15%", "타겟 연령대 실사용 가능성"])
        w.writerow(["ARS", "콘텐츠보유여부(Exists)", "40%", "블로그/쇼츠 존재 시 40점 기본 부여"])
        w.writerow(["ARS", "콘텐츠품질/최신성(Quality)", "35%", "6개월 이내 업데이트, 실제 데이터 포함 여부"])
        w.writerow(["ARS", "정보확보용이성(Answerability)", "25%", "여행사 내부자료로 즉시 답변 가능한 정도"])
        w.writerow(["Opportunity", "GADS - ARS", "-", "값이 높을수록 '수요는 큰데 콘텐츠가 없는' 우선순위 질문"])
    print(f"설정 완료: {cfg_path}")


if __name__ == "__main__":
    main()

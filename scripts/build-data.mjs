// 공항(OurAirports)·국가경계(Natural Earth) 원본을 내려받아 앱에서 쓰는 가벼운 JSON으로 변환한다.
//   npm run data
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIRPORT_KO as BASE_KO } from './airport-names-ko.mjs';
import { AIRPORT_KO_EXTRA } from './airport-names-ko-extra.mjs';

const AIRPORT_KO = { ...BASE_KO, ...AIRPORT_KO_EXTRA };

const AIRPORTS_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
const COUNTRIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// 한국 출발지: 국제공항 8곳 (인천은 터미널별로 분리)
const KR_INTL = ['ICN', 'GMP', 'PUS', 'CJU', 'TAE', 'CJJ', 'MWX', 'YNY'];
const KR_TERMINALS = {
  ICN: [
    { id: 'ICN-T1', suffix: 'T1', ko: '인천국제공항 제1터미널', en: 'Incheon International Airport Terminal 1', lat: 37.4492, lon: 126.4513 },
    { id: 'ICN-T2', suffix: 'T2', ko: '인천국제공항 제2터미널', en: 'Incheon International Airport Terminal 2', lat: 37.4687, lon: 126.4332 },
  ],
};

// 도착지 권역 — 대륙 확장 시 여기에 권역을 추가한다.
const REGIONS = [
  { id: 'east-asia', ko: '동아시아', countries: ['JP', 'CN', 'HK', 'MO', 'TW', 'MN'] },
  { id: 'southeast-asia', ko: '동남아시아', countries: ['VN', 'TH', 'PH', 'SG', 'MY', 'ID', 'KH', 'LA', 'MM', 'BN', 'TL'] },
];
const COUNTRY_EN = {
  KR: 'South Korea', JP: 'Japan', CN: 'China', HK: 'Hong Kong', MO: 'Macao', TW: 'Taiwan', MN: 'Mongolia',
  VN: 'Vietnam', TH: 'Thailand', PH: 'Philippines', SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia',
  KH: 'Cambodia', LA: 'Laos', MM: 'Myanmar', BN: 'Brunei', TL: 'Timor-Leste',
};
const COUNTRY_KO = {
  KR: '대한민국', JP: '일본', CN: '중국', HK: '홍콩', MO: '마카오', TW: '대만', MN: '몽골',
  VN: '베트남', TH: '태국', PH: '필리핀', SG: '싱가포르', MY: '말레이시아', ID: '인도네시아',
  KH: '캄보디아', LA: '라오스', MM: '미얀마', BN: '브루나이', TL: '동티모르',
};

function fetchToTmp(url, name) {
  const file = join(tmpdir(), name);
  execFileSync('curl', ['-sSL', '--fail', '-o', file, url], { stdio: 'inherit' });
  return file;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ── 공항 ───────────────────────────────────────────────────────────────
const csv = parseCsv(readFileSync(fetchToTmp(AIRPORTS_URL, 'airports.csv'), 'utf8'));
const wanted = new Set(['KR', ...REGIONS.flatMap((r) => r.countries)]);
const rank = { large_airport: 0, medium_airport: 1 };
const airports = [];
for (const a of csv) {
  if (!wanted.has(a.iso_country) || !a.iata_code) continue;
  if (!(a.type in rank) || a.scheduled_service !== 'yes') continue;
  if (a.iso_country === 'KR' && !KR_INTL.includes(a.iata_code)) continue;
  const base = {
    iata: a.iata_code,
    icao: a.icao_code || a.ident,
    en: a.name,
    ko: AIRPORT_KO[a.iata_code] || null,
    city: a.municipality,
    country: a.iso_country,
    lat: round(+a.latitude_deg, 4),
    lon: round(+a.longitude_deg, 4),
    rank: rank[a.type],
  };
  const terminals = KR_TERMINALS[a.iata_code];
  if (terminals) {
    for (const t of terminals) airports.push({ ...base, id: t.id, ko: t.ko, en: t.en, lat: t.lat, lon: t.lon });
  } else airports.push({ ...base, id: a.iata_code });
}
// 대형 공항 → 한국어명이 있는 공항 → IATA 순
airports.sort((a, b) => a.rank - b.rank || (!a.ko - !b.ko) || a.iata.localeCompare(b.iata));

const origins = airports.filter((a) => a.country === 'KR');
const destinations = airports.filter((a) => a.country !== 'KR');
const regions = REGIONS.map((r) => ({
  id: r.id,
  ko: r.ko,
  countries: r.countries.map((c) => ({ code: c, ko: COUNTRY_KO[c], en: COUNTRY_EN[c] })),
}));
const countryNames = Object.fromEntries(Object.keys(COUNTRY_KO).map((c) => [c, { ko: COUNTRY_KO[c], en: COUNTRY_EN[c] }]));

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/airports.json', JSON.stringify({ origins, destinations, regions, countryNames }));
console.log(`airports: origins ${origins.length}, destinations ${destinations.length}`);

// ── 국가 경계 (GeoJSON) ───────────────────────────────────────────────
const geo = JSON.parse(readFileSync(fetchToTmp(COUNTRIES_URL, 'countries.geojson'), 'utf8'));
const roundCoords = (c) => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(roundCoords));
geo.features = geo.features.map((f) => ({
  type: 'Feature',
  properties: {
    code: f.properties.ISO_A2_EH,
    en: f.properties.NAME,
    ko: f.properties.NAME_KO,
    lx: round(f.properties.LABEL_X),
    ly: round(f.properties.LABEL_Y),
    rank: f.properties.LABELRANK,
  },
  geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
}));
writeFileSync('public/data/countries.geojson', JSON.stringify(geo));
console.log(`countries: ${geo.features.length}`);

// 한전 전자입찰계약정보 API에서 발전사 입찰공고를 가져와 data/bids.json 으로 저장합니다.
// 인증키는 환경변수 KEPCO_API_KEY 로만 받습니다. (코드나 파일에 적지 마세요)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_URL = 'https://bigdata.kepco.co.kr/openapi/v1/electContract.do';

// 조회할 발전사 (API 매뉴얼의 회사구분 코드)
export const COMPANIES = {
  COM02: '한국서부발전',
  COM04: '한국남부발전',
  COM05: '한국중부발전',
  COM06: '한국남동발전',
  COM08: '한국동서발전',
};

// 공고일 조회 범위: 오늘 기준 과거 59일 ~ 미래 29일 (API는 한 번에 최대 90일)
const BACK_DAYS = 59;
const FORWARD_DAYS = 29;
// 마감일이 지난 공고를 며칠까지 보관할지
const KEEP_DAYS_AFTER_DEADLINE = 30;
// 참가자격 본문 최대 글자 수 (파일이 너무 커지는 것을 막기 위함)
const QUALIFICATION_MAX = 10000;

const DAY = 86400000;

const COMPETITION = { Open: '일반경쟁', Destination: '지명경쟁', Limited: '제한경쟁', Private: '수의' };
const BID_TYPE = {
  LimitedLowestPrice: '제한적최저가', LowestPrice: '최저가', QualifiedEval: '적격심사',
  CollectivelyBid: '일괄입찰', Nego: '협상', TotalEvalSuccess: '종합심사낙찰제',
};

/** 한국 시간 기준 'YYYY-MM-DD' (오늘 + offsetDays) */
export function kstYmd(offsetDays = 0, nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600000 + offsetDays * DAY).toISOString().slice(0, 10);
}
const compact = (ymd) => ymd.replace(/-/g, '');

const str = (v) => (v === null || v === undefined || v === 'null' ? '' : String(v).trim());

function toNum(v) {
  const s = str(v).replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** '2026-08-11 15:00:00' 또는 '20260811' 같은 값을 { date:'2026-08-11', time:'15:00' } 로 */
export function splitDateTime(v) {
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : '' };
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5] || '00'}` : '' };
  return null;
}

function categoryOf(raw) {
  if (str(raw.purchaseType) === 'Product') return '물품';
  const item = str(raw.itemType);
  if (item === 'Construction') return '공사';
  if (item === 'Service') return '용역';
  return '공사·용역';
}

/** API 응답 한 건을 화면에서 쓰는 형태로 줄입니다. 필수 값이 없으면 null */
export function normalize(raw) {
  const id = str(raw.no);
  const end = splitDateTime(raw.endDatetime) || splitDateTime(raw.bidAttendReqCloseDatetime);
  if (!id || !end) return null;
  const apply = splitDateTime(raw.bidAttendReqCloseDatetime);
  const notice = splitDateTime(raw.noticeDate);

  const files = [];
  for (let n = 1; n <= 5; n++) {
    const url = str(raw['filelink' + n]);
    if (url) files.push({ name: str(raw['filename' + n]) || `첨부파일${n}`, url });
  }

  return {
    id,
    org: COMPANIES[str(raw.companyId)] || str(raw.companyId),
    place: str(raw.placeName),
    title: str(raw.name),
    category: categoryOf(raw),
    competition: COMPETITION[str(raw.competitionType)] || str(raw.competitionType),
    bidType: BID_TYPE[str(raw.bidType)] || str(raw.bidType),
    price: toNum(raw.presumedPrice),
    notice: notice ? notice.date : '',
    applyClose: apply ? apply.date + (apply.time ? ' ' + apply.time : '') : '',
    deadline: end.date,          // 마감일 = 입찰종료일시 (개찰 전 최종 마감)
    deadlineTime: end.time,
    state: str(raw.progressState),
    qualification: str(raw.etc).replace(/\\n/g, '\n').replace(/\r/g, '').slice(0, QUALIFICATION_MAX),
    files,
  };
}

async function fetchCompany({ apiKey, companyId, begin, end, fetchImpl }) {
  const name = COMPANIES[companyId] || companyId;
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    apiKey, noticeBeginDate: begin, noticeEndDate: end, companyId, returnType: 'json',
  }).toString();

  const res = await fetchImpl(url);
  const text = await res.text();
  const mask = (s) => String(s).split(apiKey).join('***');

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name}: JSON이 아닌 응답 (HTTP ${res.status}) ${mask(text.slice(0, 120))}`);
  }
  const rows = Array.isArray(json) ? json : json && json.data;
  if (!Array.isArray(rows)) {
    if (json && json.errCd !== undefined) {
      throw new Error(`${name}: API 오류 ${json.errCd} - ${mask(json.errMsg || '')}`);
    }
    throw new Error(`${name}: 예상과 다른 응답 형식 (항목: ${Object.keys(json || {}).join(', ')})`);
  }
  return rows;
}

async function readPrevious(dataPath) {
  try {
    const j = JSON.parse(await readFile(dataPath, 'utf-8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

export async function run({ apiKey, dataPath, fetchImpl = fetch, nowMs = Date.now(), log = console.log }) {
  const begin = compact(kstYmd(-BACK_DAYS, nowMs));
  const end = compact(kstYmd(FORWARD_DAYS, nowMs));
  const keepFrom = kstYmd(-KEEP_DAYS_AFTER_DEADLINE, nowMs);

  const byId = new Map();
  for (const it of await readPrevious(dataPath)) {
    if (it && it.id && it.deadline >= keepFrom) byId.set(it.id, it);
  }

  const counts = {};
  const failed = [];
  let succeeded = 0;

  for (const companyId of Object.keys(COMPANIES)) {
    const name = COMPANIES[companyId];
    try {
      const rows = await fetchCompany({ apiKey, companyId, begin, end, fetchImpl });
      let kept = 0, skipped = 0;
      for (const raw of rows) {
        const it = normalize(raw);
        if (it) { byId.set(it.id, it); kept++; } else { skipped++; }
      }
      counts[name] = rows.length;
      succeeded++;
      log(`${name}: ${rows.length}건 받음 (저장 ${kept}, 건너뜀 ${skipped})`);
      if ([100, 500, 1000, 5000, 10000].includes(rows.length)) {
        log(`  ※ ${name}: 건수가 딱 떨어져요. 한 번에 받을 수 있는 개수에 제한이 있는지 확인이 필요합니다.`);
      }
    } catch (e) {
      failed.push(name);
      log(`${name}: 실패 - ${e.message}`);
    }
  }

  if (succeeded === 0) {
    throw new Error('모든 발전사 조회에 실패해서 데이터를 저장하지 않았어요. 위 메시지를 확인해 주세요.');
  }

  const items = [...byId.values()].sort(
    (a, b) => a.deadline.localeCompare(b.deadline) || a.id.localeCompare(b.id),
  );
  const out = { updatedAt: new Date(nowMs).toISOString(), range: { begin, end }, counts, failed, items };
  await mkdir(dirname(dataPath), { recursive: true });
  await writeFile(dataPath, JSON.stringify(out) + '\n', 'utf-8');
  log(`저장 완료: 총 ${items.length}건`);

  if (failed.length) throw new Error(`일부 발전사 조회에 실패했어요: ${failed.join(', ')}`);
}

// 직접 실행했을 때만 동작 (테스트에서 불러올 때는 실행되지 않음)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiKey = (process.env.KEPCO_API_KEY || '').trim();
  if (!apiKey) {
    console.error('KEPCO_API_KEY(인증키)가 설정되지 않았어요. GitHub 저장소의 Secrets에 등록해 주세요.');
    process.exit(1);
  }
  if (apiKey.length !== 40) {
    console.warn(`참고: 인증키 길이가 ${apiKey.length}자예요. 매뉴얼에는 40자리로 안내되어 있어요. 복사할 때 잘리거나 공백이 섞이지 않았는지 확인해 주세요.`);
  }
  const dataPath = fileURLToPath(new URL('../data/bids.json', import.meta.url));
  run({ apiKey, dataPath }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

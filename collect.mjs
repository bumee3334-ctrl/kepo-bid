// 한전 전자입찰계약정보 API에서 발전사 입찰공고를 가져와 data/ 폴더에 저장합니다.
//
// - 시작일~종료일(공고일 기준)을 90일 단위 구간으로 나눠서, 오래된 구간부터 순서대로 요청합니다.
// - 인증키는 환경변수 KEPCO_API_KEY 로만 받습니다. (코드나 파일에 적지 마세요)
// - 기간은 환경변수 BEGIN_DATE / END_DATE 로 받습니다. (예: 2021-09-21) 비우면 기본값을 씁니다.
// - 저장 위치
//     data/bids.json            목록용 (가벼운 정보만)
//     data/detail/YYYY-MM.json  상세용 (참가자격·첨부파일). 공고월별로 나뉘어 있고 공고를 눌렀을 때만 불러옵니다.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

// ---- 조회 설정 (여기 숫자만 바꾸면 됩니다) ----
// 한 번에 요청하는 기간(일). API는 한 번에 최대 90일까지 조회됩니다.
export const CHUNK_DAYS = 90;
// 시작일을 비웠을 때: 오늘로부터 몇 년 전부터 받을지
const DEFAULT_YEARS_BACK = 5;
// 종료일을 비웠을 때: 오늘로부터 며칠 뒤까지 받을지
const DEFAULT_FORWARD_DAYS = 29;
// 요청 사이에 쉬는 시간(밀리초). API에 부담을 덜 주기 위함
const PAUSE_MS = 250;
// 일시적인 오류일 때 다시 시도하는 최대 횟수
const MAX_ATTEMPTS = 3;
// 참가자격 본문 최대 글자 수
const QUALIFICATION_MAX = 10000;

const DAY = 86400000;

const COMPETITION = { Open: '일반경쟁', Destination: '지명경쟁', Limited: '제한경쟁', Private: '수의' };
const BID_TYPE = {
  LimitedLowestPrice: '제한적최저가', LowestPrice: '최저가', QualifiedEval: '적격심사',
  CollectivelyBid: '일괄입찰', Nego: '협상', TotalEvalSuccess: '종합심사낙찰제',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 한국 시간 기준 'YYYY-MM-DD' (오늘 + offsetDays) */
export function kstYmd(offsetDays = 0, nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600000 + offsetDays * DAY).toISOString().slice(0, 10);
}
const compact = (ymd) => ymd.replace(/-/g, '');
const dash = (c) => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;

/** 'YYYYMMDD' 에 n일을 더한 'YYYYMMDD' */
export function addDaysCompact(c, n) {
  const t = Date.UTC(+c.slice(0, 4), +c.slice(4, 6) - 1, +c.slice(6, 8)) + n * DAY;
  return compact(new Date(t).toISOString().slice(0, 10));
}

/** '2021-09-21' 또는 '20210921' 을 'YYYYMMDD' 로. 실제로 있는 날짜가 아니면 null */
export function parseDateInput(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  const c = m[1] + m[2] + m[3];
  return addDaysCompact(c, 0) === c ? c : null;
}

/** 오늘로부터 n년 전 같은 날 (2/29 는 3/1 로) */
function yearsBackCompact(nowMs, years) {
  const [y, mo, d] = kstYmd(0, nowMs).split('-').map(Number);
  return compact(new Date(Date.UTC(y - years, mo - 1, d)).toISOString().slice(0, 10));
}

/** 시작일~종료일을 90일 단위로 나눕니다. 오래된 구간이 앞에 옵니다. (양 끝 날짜 포함) */
export function makeChunks(begin, end, days = CHUNK_DAYS) {
  const chunks = [];
  let s = begin;
  while (s <= end) {
    const e = addDaysCompact(s, days - 1);
    const last = e < end ? e : end;
    chunks.push({ begin: s, end: last });
    s = addDaysCompact(last, 1);
  }
  return chunks;
}

/** 조회 기간 결정: 입력값이 있으면 그것을, 없으면 기본값 */
export function resolveRange({ beginInput, endInput, nowMs = Date.now() }) {
  const b = String(beginInput ?? '').trim();
  const e = String(endInput ?? '').trim();
  const begin = b ? parseDateInput(b) : yearsBackCompact(nowMs, DEFAULT_YEARS_BACK);
  const end = e ? parseDateInput(e) : compact(kstYmd(DEFAULT_FORWARD_DAYS, nowMs));
  if (!begin) throw new Error(`시작일 형식이 올바르지 않아요: "${b}" (예: 2021-09-21)`);
  if (!end) throw new Error(`종료일 형식이 올바르지 않아요: "${e}" (예: 2026-09-21)`);
  if (begin > end) throw new Error(`시작일(${dash(begin)})이 종료일(${dash(end)})보다 늦어요.`);
  return { begin, end };
}

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

/** 한 건을 목록용(가벼움)과 상세용(참가자격·첨부파일)으로 나눕니다 */
export function splitItem(it) {
  const { qualification, files, ...light } = it;
  return { light, detail: { qualification: qualification || '', files: Array.isArray(files) ? files : [] } };
}

/** 상세 파일 이름: 공고월(YYYY-MM)별. 공고일이 없으면 unknown */
export function detailKey(it) {
  return it.notice && /^\d{4}-\d{2}/.test(it.notice) ? it.notice.slice(0, 7) : 'unknown';
}

class RetryableError extends Error {}

async function requestOnce({ apiKey, companyId, begin, end, fetchImpl }) {
  const name = COMPANIES[companyId] || companyId;
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    apiKey, noticeBeginDate: begin, noticeEndDate: end, companyId, returnType: 'json',
  }).toString();
  const mask = (s) => String(s).split(apiKey).join('***');

  let res, text;
  try {
    res = await fetchImpl(url);
    text = await res.text();
  } catch (e) {
    throw new RetryableError(`${name}: 요청 실패 - ${mask(e && e.message ? e.message : e)}`);
  }
  if (res.status >= 500 || res.status === 429) {
    throw new RetryableError(`${name}: 서버 응답 오류 (HTTP ${res.status}) ${mask(text.slice(0, 120))}`);
  }

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

async function fetchCompany(args, sleepImpl) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce(args);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof RetryableError) || attempt === MAX_ATTEMPTS) break;
      await sleepImpl(1000 * attempt);
    }
  }
  throw lastErr;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

export async function run({
  apiKey, dataPath, beginInput, endInput,
  fetchImpl = fetch, nowMs = Date.now(), log = console.log,
  pauseMs = PAUSE_MS, sleepImpl = sleep,
}) {
  const { begin, end } = resolveRange({ beginInput, endInput, nowMs });
  const chunks = makeChunks(begin, end);
  const detailDir = join(dirname(dataPath), 'detail');
  const companyIds = Object.keys(COMPANIES);

  log(`조회 기간(공고일 기준): ${dash(begin)} ~ ${dash(end)}`);
  log(`${CHUNK_DAYS}일 단위 ${chunks.length}개 구간 × 발전사 ${companyIds.length}곳 = 요청 ${chunks.length * companyIds.length}번 (오래된 구간부터 순서대로)`);

  // 이미 저장된 목록을 불러옵니다. (예전 형식이라 상세 내용이 들어 있으면 상세 파일로 옮깁니다)
  const list = new Map();
  const newDetails = new Map(); // 공고월 -> { 공고번호 -> 상세 }
  const putDetail = (it, detail) => {
    const k = detailKey(it);
    if (!newDetails.has(k)) newDetails.set(k, {});
    newDetails.get(k)[it.id] = detail;
  };
  const prev = await readJson(dataPath);
  for (const it of prev && Array.isArray(prev.items) ? prev.items : []) {
    if (!it || !it.id) continue;
    const { light, detail } = splitItem(it);
    list.set(light.id, light);
    if (it.qualification !== undefined || it.files !== undefined) putDetail(light, detail);
  }

  const counts = {};
  const failed = [];
  let okRequests = 0;
  let n = 0;

  for (const ch of chunks) {
    for (const companyId of companyIds) {
      const name = COMPANIES[companyId];
      n++;
      const tag = `[${n}/${chunks.length * companyIds.length}] ${dash(ch.begin)}~${dash(ch.end)} ${name}`;
      try {
        const rows = await fetchCompany({ apiKey, companyId, begin: ch.begin, end: ch.end, fetchImpl }, sleepImpl);
        let kept = 0, skipped = 0;
        for (const raw of rows) {
          const it = normalize(raw);
          if (!it) { skipped++; continue; }
          const { light, detail } = splitItem(it);
          list.set(light.id, light);
          putDetail(light, detail);
          kept++;
        }
        counts[name] = (counts[name] || 0) + rows.length;
        okRequests++;
        log(`${tag}: ${rows.length}건 (저장 ${kept}, 건너뜀 ${skipped})`);
        if ([100, 500, 1000, 5000, 10000].includes(rows.length)) {
          log(`  ※ 건수가 딱 떨어져요. 한 번에 받을 수 있는 개수에 제한이 있는지 확인이 필요합니다. (이 구간을 더 짧게 나눠 다시 받아보세요)`);
        }
      } catch (e) {
        failed.push(`${name} ${ch.begin}~${ch.end}`);
        log(`${tag}: 실패 - ${e.message}`);
      }
      if (pauseMs > 0) await sleepImpl(pauseMs);
    }
  }

  if (okRequests === 0) {
    throw new Error('모든 요청이 실패해서 데이터를 저장하지 않았어요. 위 메시지를 확인해 주세요.');
  }

  // 상세 파일(공고월별)에 합쳐서 저장
  await mkdir(detailDir, { recursive: true });
  for (const [key, add] of newDetails) {
    const file = join(detailDir, `${key}.json`);
    const merged = { ...((await readJson(file)) || {}), ...add };
    await writeFile(file, JSON.stringify(merged) + '\n', 'utf-8');
  }

  // 목록 파일: 최근 공고가 위로 오도록
  const items = [...list.values()].sort(
    (a, b) => (b.notice || '').localeCompare(a.notice || '') || b.id.localeCompare(a.id),
  );
  const out = {
    updatedAt: new Date(nowMs).toISOString(),
    range: { begin, end },
    counts,
    failed,
    items,
  };
  await mkdir(dirname(dataPath), { recursive: true });
  await writeFile(dataPath, JSON.stringify(out) + '\n', 'utf-8');
  log(`저장 완료: 목록 총 ${items.length}건, 상세 파일 ${newDetails.size}개 갱신`);

  if (failed.length) {
    throw new Error(`일부 구간 조회에 실패했어요 (${failed.length}건): ${failed.join(', ')}`);
  }
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
  run({
    apiKey, dataPath,
    beginInput: process.env.BEGIN_DATE, endInput: process.env.END_DATE,
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

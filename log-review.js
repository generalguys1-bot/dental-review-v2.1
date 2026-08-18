// Vercel Serverless Function — /api/log-review
//
// 목적
// 1) (통계) 방문유형/진료분야/치료/좋았던 점/개선사항 "카테고리"만 익명으로 모아
//    어떤 스탭·어떤 진료가 자주 칭찬받는지 파악할 수 있게 웹훅으로 전달
// 2) (부정 피드백 알림) 개선사항을 선택한 환자가 있으면, 그 리뷰가 외부에
//    올라가기 전에 데스크/원장님이 먼저 알 수 있도록 즉시 알림 전송
// 3) (직원별 칭찬 집계 대시보드) Upstash Redis가 연결되어 있으면, 담당자
//    역할·항목별 칭찬 횟수와 개선사항, 게시 확인 수를 누적 집계해서
//    /api/get-stats + admin.html 대시보드에서 바로 볼 수 있게 저장
//
// 이 함수는 리뷰 "본문 텍스트"나 이름/연락처 등 개인 식별 정보는 절대
// 받지도, 전달하지도, 저장하지도 않습니다 (index.html에서 애초에 보내지 않음).
//
// 보안 설계
// - Webhook 주소(Slack Incoming Webhook, 카카오워크, Make/Zapier 등)는
//   프론트엔드 URL 파라미터에 절대 넣지 않고, 아래처럼 Vercel의
//   Environment Variables에만 등록합니다. (QR코드/URL로 새어나가지 않음)
// - 병원이 여러 곳이면(멀티테넌트) clinicId별로 아래 네이밍 규칙을 따라
//   환경변수를 등록하면 자동으로 해당 병원 웹훅으로 전송됩니다.
//     STATS_WEBHOOK_URL__<clinicId>
//     ADMIN_WEBHOOK_URL__<clinicId>
//   등록이 없으면 전역 기본값(STATS_WEBHOOK_URL, ADMIN_WEBHOOK_URL)을 사용합니다.
//   (clinicId는 setup.html에서 지정한 cid 값. 없으면 병원명이 대신 쓰입니다.)
// - 직원별 칭찬 집계는 create-link.js와 동일한 Upstash Redis를 그대로
//   사용합니다. 이미 짧은 링크(QR) 기능을 쓰고 있다면 별도 설정 없이 바로
//   집계가 시작됩니다. Redis가 연결되어 있지 않으면 집계만 조용히 건너뛰고
//   웹훅 전송(1, 2번)은 그대로 정상 동작합니다.
//
// 웹훅 수신 측 예시
// - Slack Incoming Webhook: { text: "..." } 형태를 그대로 받습니다.
// - Google Apps Script Web App으로 Google Sheets에 한 줄씩 적재하는 것도 가능합니다.
//   (Apps Script에서 doPost(e)로 JSON.parse(e.postData.contents) 받아 append)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN;

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`Redis error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

const rateLimitStore = globalThis.__logReviewRateLimitStore || (globalThis.__logReviewRateLimitStore = new Map());
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 10;

function isRateLimited(key) {
  const now = Date.now();
  const timestamps = (rateLimitStore.get(key) || []).filter(t => now - t < WINDOW_MS);
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);
  if (rateLimitStore.size > 5000) {
    for (const [k, v] of rateLimitStore) {
      if (v.every(t => now - t > WINDOW_MS)) rateLimitStore.delete(k);
    }
  }
  return timestamps.length > MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// clinicId에 특수문자가 섞여도 안전한 환경변수 키로 변환
function safeEnvKey(clinicId) {
  return String(clinicId || 'default').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

function resolveWebhook(baseName, clinicId) {
  const perClinicKey = `${baseName}__${safeEnvKey(clinicId)}`;
  return process.env[perClinicKey] || process.env[baseName] || '';
}

async function postToWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('log-review webhook failed:', err);
  }
}

// 병원 내 대시보드 집계용 Redis 키 안전화 (콜론/특수문자가 섞여도 필드로 안전하게 저장)
function safeField(str) {
  return String(str || 'unknown').replace(/[^a-zA-Z0-9_::가-힣-]/g, '_');
}

// Redis에 통계 증가 반영 (실패해도 웹훅/사용자 경험에는 영향 없도록 개별적으로 무시)
async function bumpStats(clinicId, payload) {
  if (!REDIS_URL || !REDIS_TOKEN) return; // Redis 미연결 시 조용히 건너뜀
  const metaKey = `stats:${clinicId}:meta`;
  const roleKey = `stats:${clinicId}:role`;
  const itemKey = `stats:${clinicId}:item`;
  const improvementKey = `stats:${clinicId}:improvement`;

  const ops = [];
  ops.push(redis(['HINCRBY', metaKey, 'totalReviews', 1]));
  if (payload.hasImprovement) ops.push(redis(['HINCRBY', metaKey, 'withImprovement', 1]));

  (payload.experienceItems || []).forEach(e => {
    if (!e || !e.role || !e.id) return;
    ops.push(redis(['HINCRBY', roleKey, safeField(e.role), 1]));
    ops.push(redis(['HINCRBY', itemKey, `${safeField(e.role)}::${safeField(e.id)}`, 1]));
  });

  (payload.improvementItems || []).forEach(i => {
    if (!i || !i.category || !i.id) return;
    ops.push(redis(['HINCRBY', improvementKey, `${safeField(i.category)}::${safeField(i.id)}`, 1]));
  });

  await Promise.allSettled(ops);
}

// "리뷰를 올렸어요" 확인 카운트 (게시 전환율 파악용, 개인정보 없음)
async function bumpPostedConfirmed(clinicId) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await redis(['HINCRBY', `stats:${clinicId}:meta`, 'postedConfirmed', 1]);
  } catch (err) {
    console.error('bumpPostedConfirmed failed:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const { clinicId, type } = req.body || {};

  if (!clinicId) {
    return res.status(400).json({ error: 'Missing clinicId' });
  }

  // 환자가 "리뷰를 올렸어요"를 확인 누른 경우 — 집계만 하고 바로 종료
  if (type === 'posted_confirmed') {
    await bumpPostedConfirmed(clinicId);
    return res.status(200).json({ ok: true });
  }

  const {
    language, visit, category, treatment,
    experienceRoles, experienceItems, hasImprovement, improvementCategories, improvementItems
  } = req.body || {};

  const timestamp = new Date().toISOString();

  const statsPayload = {
    type: 'review_stat',
    clinicId, timestamp, language, visit, category, treatment,
    experienceRoles: Array.isArray(experienceRoles) ? experienceRoles : [],
    hasImprovement: !!hasImprovement,
    improvementCategories: Array.isArray(improvementCategories) ? improvementCategories : []
  };

  const statsWebhook = resolveWebhook('STATS_WEBHOOK_URL', clinicId);
  const adminWebhook = resolveWebhook('ADMIN_WEBHOOK_URL', clinicId);

  const tasks = [];
  if (statsWebhook) tasks.push(postToWebhook(statsWebhook, statsPayload));

  if (hasImprovement && adminWebhook) {
    const summary = (statsPayload.improvementCategories.length
      ? statsPayload.improvementCategories.join(', ')
      : '기타 의견');
    const alertPayload = {
      type: 'negative_feedback_alert',
      text: `⚠️ [${clinicId}] 개선사항이 포함된 리뷰가 작성되었어요 (${summary}). 환자가 외부 플랫폼에 올리기 전에 먼저 확인해보시는 걸 권장드려요.`,
      ...statsPayload
    };
    tasks.push(postToWebhook(adminWebhook, alertPayload));
  }

  // 직원별 칭찬 집계 대시보드용 Redis 누적 (Redis 미연결 시 자동으로 건너뜀)
  tasks.push(bumpStats(clinicId, {
    hasImprovement: !!hasImprovement,
    experienceItems: Array.isArray(experienceItems) ? experienceItems : [],
    improvementItems: Array.isArray(improvementItems) ? improvementItems : []
  }));

  // 웹훅 전송 성공 여부와 무관하게 사용자 경험은 막지 않음
  await Promise.allSettled(tasks);

  return res.status(200).json({ ok: true });
}

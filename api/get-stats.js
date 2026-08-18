// Vercel Serverless Function — /api/get-stats
//
// 목적: log-review.js가 Redis에 누적해둔 익명 통계(담당자별 칭찬 횟수,
// 개선사항 항목별 횟수, 게시 확인 수)를 admin.html 대시보드가 읽어갈 수
// 있도록 반환한다. 리뷰 원문이나 환자 개인정보는 애초에 저장되지 않으므로
// 이 API도 그런 값은 절대 반환하지 않는다.
//
// 준비 사항
// - create-link.js와 동일한 Upstash Redis 연결이 필요하다 (이미 짧은 링크
//   기능을 쓰고 있다면 추가 설정 없이 바로 동작한다).
// - 이 엔드포인트는 병원 운영진만 봐야 하는 정보이므로, Vercel 환경변수에
//   ADMIN_DASHBOARD_KEY를 설정해두면 ?key=값이 일치할 때만 응답한다.
//   설정하지 않으면(테스트/내부용) 누구나 clinicId만 알면 볼 수 있으니,
//   실제 운영 시에는 꼭 설정해서 admin.html 링크에 ?key=... 를 붙여 쓰는
//   걸 권장한다.

const rateLimitStore = globalThis.__getStatsRateLimitStore || (globalThis.__getStatsRateLimitStore = new Map());
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;

function isRateLimited(key) {
  const now = Date.now();
  const timestamps = (rateLimitStore.get(key) || []).filter(t => now - t < WINDOW_MS);
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);
  return timestamps.length > MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN;

async function redisHGetAll(key) {
  const res = await fetch(`${REDIS_URL}/hgetall/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Redis error: ${res.status}`);
  const data = await res.json();
  // Upstash HGETALL은 [field1, value1, field2, value2, ...] 형태의 flat 배열로 반환됨
  const flat = data.result || [];
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}

// 대시보드 표시용 한글 라벨 (index.html의 한국어 번역과 동일한 값)
const ROLE_LABELS = { doctor: '원장님', counselor: '상담실장님', staff: '진료실 선생님', desk: '데스크·예약' };
const EXPERIENCE_ITEM_LABELS = {
  accurate_diagnosis: '정확한 진단', careful_procedure: '꼼꼼한 시술', pain_minimization: '통증 최소화',
  thorough_explanation: '충분한 설명', digital_cadcam: '최신 디지털 캐드캠 장비', oral_scan: '정밀 구강 스캔',
  simulation_3d: '3D 시뮬레이션 상담', digital_xray: '디지털 엑스레이·CT 촬영', gentle_chairside: '편안한 진료 태도',
  kind_consult: '친절한 상담', transparent_cost: '투명한 비용 안내', no_overselling: '과잉권유 없음',
  tailored_plan: '맞춤 플랜 제안', skilled_assist: '능숙한 어시스트', careful_care: '세심한 케어',
  comfortable_atmosphere: '편안한 분위기', hygiene: '청결한 위생관리', easy_booking: '편리한 예약',
  kind_response: '친절한 응대', short_wait: '짧은 대기시간'
};
const IMPROVEMENT_CATEGORY_LABELS = { wait_booking: '대기·예약', cost_info: '비용·안내', facility: '시설·환경', communication: '설명·소통' };
const IMPROVEMENT_ITEM_LABELS = {
  long_wait: '대기시간이 길었어요', hard_reschedule: '예약 변경이 어려웠어요', cost_info_lacking: '비용 안내가 아쉬웠어요',
  cost_burden: '진료비가 부담됐어요', parking_inconvenient: '주차가 불편했어요', waiting_area_small: '대기공간이 좁았어요',
  explanation_lacking: '설명이 조금 부족했어요', followup_lacking: '진료 후 안내가 아쉬웠어요'
};

function toSortedList(hash, resolveLabel) {
  return Object.entries(hash)
    .map(([field, count]) => ({ field, count: Number(count) || 0, label: resolveLabel(field) }))
    .sort((a, b) => b.count - a.count);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({
      error: 'redis_not_configured',
      message: 'Vercel 프로젝트에 Upstash Redis가 연결되어 있지 않아요. Storage 탭에서 연결 후 다시 시도해주세요.'
    });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const requiredKey = process.env.ADMIN_DASHBOARD_KEY;
  if (requiredKey && req.query.key !== requiredKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const clinicId = req.query.clinicId || req.query.cid;
  if (!clinicId) {
    return res.status(400).json({ error: 'Missing clinicId' });
  }

  try {
    const [meta, roleHash, itemHash, improvementHash] = await Promise.all([
      redisHGetAll(`stats:${clinicId}:meta`),
      redisHGetAll(`stats:${clinicId}:role`),
      redisHGetAll(`stats:${clinicId}:item`),
      redisHGetAll(`stats:${clinicId}:improvement`)
    ]);

    const totalReviews = Number(meta.totalReviews) || 0;
    const withImprovement = Number(meta.withImprovement) || 0;
    const postedConfirmed = Number(meta.postedConfirmed) || 0;

    const roles = toSortedList(roleHash, field => ROLE_LABELS[field] || field);
    const items = toSortedList(itemHash, field => {
      const [role, id] = field.split('::');
      const roleLabel = ROLE_LABELS[role] || role;
      const itemLabel = EXPERIENCE_ITEM_LABELS[id] || id;
      return `${roleLabel} · ${itemLabel}`;
    });
    const improvements = toSortedList(improvementHash, field => {
      const [category, id] = field.split('::');
      const catLabel = IMPROVEMENT_CATEGORY_LABELS[category] || category;
      const itemLabel = IMPROVEMENT_ITEM_LABELS[id] || id;
      return `${catLabel} · ${itemLabel}`;
    });

    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.status(200).json({
      clinicId,
      totalReviews,
      withImprovement,
      postedConfirmed,
      postedConfirmRate: totalReviews > 0 ? Math.round((postedConfirmed / totalReviews) * 100) : 0,
      roles,
      items,
      improvements
    });
  } catch (err) {
    console.error('get-stats failed:', err);
    return res.status(500).json({ error: 'get_stats_failed' });
  }
}

// Vercel Serverless Function — /api/create-link
//
// 목적: setup.html에서 입력한 병원 설정(치과 이름, 리뷰 링크, 전화번호 등
// 최대 15개 필드)을 Upstash Redis에 저장하고, 그 대신 쓸 수 있는 짧은 코드를
// 발급한다. index.html은 긴 파라미터 대신 `?c=짧은코드` 하나만 받아서
// /api/get-link로 원본 설정을 조회해 그대로 사용한다.
//
// 준비 사항 (필수)
// - Vercel 프로젝트에 Upstash Redis를 연결하면 아래 두 환경변수가
//   자동으로 채워진다: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   (Vercel 대시보드 → Storage → Create Database → Upstash for Redis,
//   무료 플랜으로 충분함)
// - 연결 후 재배포하면 바로 동작한다.
//
// 코드 형식: clinicId(cid)를 입력했다면 그 값을 사람이 읽기 쉬운 슬러그로
// 우선 사용하고, 이미 사용 중이면 짧은 랜덤 접미사를 붙인다. cid가 없으면
// 완전 랜덤 6자리 코드를 발급한다.

const rateLimitStore = globalThis.__createLinkRateLimitStore || (globalThis.__createLinkRateLimitStore = new Map());
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 20;

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

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function randomSuffix(len = 4) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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

  const {
    name, google, naver, homepage, logo, color, doctorPhoto, doctorGreeting,
    region, phone, kakaoChannel, instagram, blog, youtube, event, cid
  } = req.body || {};

  if (!name || !google) {
    return res.status(400).json({ error: 'Missing required fields (name, google)' });
  }

  const config = {
    name, google, naver, homepage, logo, color, doctorPhoto, doctorGreeting,
    region, phone, kakaoChannel, instagram, blog, youtube, event, cid
  };
  // 빈 값 정리
  Object.keys(config).forEach(k => { if (!config[k]) delete config[k]; });

  try {
    let slug = cid ? slugify(cid) : '';
    if (!slug) slug = randomSuffix(6);

    // 슬러그 중복이면 접미사를 붙여 유일하게 만듦 (최대 5회 시도)
    for (let i = 0; i < 5; i++) {
      const existing = await redis(['GET', `link:${slug}`]);
      if (!existing) break;
      slug = `${cid ? slugify(cid) : randomSuffix(6)}-${randomSuffix(3)}`;
    }

    await redis(['SET', `link:${slug}`, JSON.stringify(config)]);

    return res.status(200).json({ slug });
  } catch (err) {
    console.error('create-link failed:', err);
    return res.status(500).json({ error: 'create_link_failed', message: '링크 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
}

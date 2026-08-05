// Vercel Serverless Function — /api/get-link
//
// 목적: index.html이 `?c=짧은코드`로 접속했을 때, 그 코드에 저장된
// 병원 설정(JSON)을 돌려준다. create-link.js와 짝을 이루는 함수.
//
// 준비 사항: create-link.js와 동일하게 UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN 환경변수가 필요하다.

const rateLimitStore = globalThis.__getLinkRateLimitStore || (globalThis.__getLinkRateLimitStore = new Map());
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 60;

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

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Redis error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'redis_not_configured' });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const slug = req.query.c;
  if (!slug) {
    return res.status(400).json({ error: 'Missing c parameter' });
  }

  try {
    const raw = await redisGet(`link:${slug}`);
    if (!raw) {
      return res.status(404).json({ error: 'not_found' });
    }
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // 짧은 캐시(브라우저/CDN) 허용 — 클리닉 설정은 자주 바뀌지 않음
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.status(200).json(config);
  } catch (err) {
    console.error('get-link failed:', err);
    return res.status(500).json({ error: 'get_link_failed' });
  }
}

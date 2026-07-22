// Vercel Serverless Function
// 배포 시 Vercel 프로젝트의 Environment Variables에 ANTHROPIC_API_KEY를 등록하세요.
// (Anthropic API 키는 https://console.anthropic.com 에서 발급)

// ------------------------------------------------------------
// 간단한 IP 기준 rate limit (같은 사람의 반복 호출만 차단, 서로 다른
// 환자·치과의 정상적인 동시 사용은 막지 않음)
// 주의: 함수 인스턴스가 새로 뜨면(cold start) 초기화돼요. 완벽한 분산
// rate limit이 필요하면 Upstash Redis 같은 외부 스토어 연동을 권장해요.
// ------------------------------------------------------------
const rateLimitStore = globalThis.__reviewRateLimitStore || (globalThis.__reviewRateLimitStore = new Map());
const WINDOW_MS = 60 * 1000;   // 1분
const MAX_REQUESTS = 6;        // 1분당 최대 6회 (동일 IP 기준)

function isRateLimited(key) {
  const now = Date.now();
  const timestamps = (rateLimitStore.get(key) || []).filter(t => now - t < WINDOW_MS);
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);

  // 메모리 누수 방지: store가 너무 커지면 오래된 키 정리
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({
      error: 'rate_limited',
      text: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.'
    });
  }

  const {
    clinicName, language, visit, category, treatment,
    experience, improvements, additionalNote, region
  } = req.body || {};

  if (!clinicName || !visit || !treatment || !Array.isArray(experience) || experience.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const targetLanguage = language || 'Korean';

  // 지역/키워드는 선택 입력이며, 억지로 반복 삽입하지 않고 자연스러울 때만
  // 한 번 언급되도록 유도한다 (리뷰 품질과 플랫폼 정책 준수가 우선).
  const regionLine = region
    ? `- Clinic area (mention naturally at most once ONLY if it fits smoothly into a sentence, e.g. when referring to location convenience; never force it or repeat it, never turn it into a keyword list): ${region}`
    : '';

  // 담당자별 경험 항목 정리
  const byRole = {};
  experience.forEach(e => {
    if (!byRole[e.role]) byRole[e.role] = [];
    byRole[e.role].push(e.label);
  });
  const experienceLines = Object.entries(byRole)
    .map(([role, items]) => `  - ${role}: ${items.join(', ')}`)
    .join('\n');

  const improvementItems = Array.isArray(improvements) ? [...improvements] : [];
  if (additionalNote) improvementItems.push(additionalNote);
  const improvementLine = improvementItems.length
    ? `- Minor thing that could be improved (if present, weave in ONE gentle, constructive sentence near the end; keep overall tone positive): ${improvementItems.join(', ')}`
    : `- Nothing to improve mentioned (do not invent any negative content)`;

  const prompt = `You are helping a real dental patient write a natural, authentic Google review.
Using the information below, write ONE natural review as if written by the patient themselves.

IMPORTANT: Write the entire review ONLY in ${targetLanguage}. Do not include any other language, translation, or commentary — output only the review text itself, in ${targetLanguage}.

- Clinic name: ${clinicName}
- Visit type: ${visit}
- Treatment area: ${category || ''}
- Treatment received: ${treatment}
- What stood out, by staff member:
${experienceLines}
${improvementLine}
${regionLine}

Requirements:
- 3-5 natural sentences, written the way a real person writes a review (not like an advertisement)
- If there are multiple staff members mentioned, naturally reference one or two of them (e.g. the dentist, the treatment coordinator) the way a genuine review would
- If there's something to improve, phrase it as a gentle, constructive note, not a complaint — only one sentence for this
- No emojis
- No markdown, no quotation marks, no star ratings — output only the review body text
- Avoid overused clichés ("highly recommend", "very satisfied") — be specific and natural instead

[Medical advertising compliance guardrails — must follow]
- Never use absolute or guaranteed claims about medical outcomes (e.g. "fully cured", "100% effective", "no side effects", "painless", "guaranteed for life")
- Never compare to or disparage other clinics or specific competing treatments
- Never invent unverifiable statistics about treatment outcomes (e.g. "90% less pain")
- Never imply or mention any discount, promotion, or reward in exchange for writing this review
- Never generate any personally identifying information (real name, birth date, phone number, etc.)
- Never stuff or repeat location/keyword phrases — a genuine patient mentions their area naturally at most once, if at all
- The review must read like a genuine, understated personal account from a patient — never like an advertisement written by the clinic`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'upstream_error' });
    }

    const data = await response.json();
    const text = (data.content || [])
      .map(block => block.text || '')
      .join('')
      .trim();

    return res.status(200).json({ text });
  } catch (err) {
    console.error('generate-review failed:', err);
    return res.status(500).json({ error: 'generation_failed' });
  }
}

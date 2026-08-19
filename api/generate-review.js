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
    experience, improvements, additionalNote, region,
    motive, concern, priority, hesitation,
    tone, previousText, translateTo
  } = req.body || {};

  const targetLanguage = language || 'Korean';

  // 톤 재작성 모드: 이미 만들어진 리뷰의 사실관계는 그대로 두고 톤(길이/격식/친근함)만 다시 씀
  const TONE_INSTRUCTIONS = {
    shorter: 'Make it noticeably shorter and more concise (about 2-3 sentences), keeping only the key points.',
    longer: 'Make it noticeably longer and more detailed (about 5-7 sentences), naturally elaborating on the same experiences already mentioned — do not invent new facts, staff members, or treatments that were not in the original.',
    polite: 'Make the tone more polite, warm, and formal, while staying natural and not stiff.',
    casual: 'Make the tone more casual, friendly, and conversational, like talking to a friend — still respectful.'
  };

  let prompt;

  if (previousText && tone) {
    const instruction = TONE_INSTRUCTIONS[tone];
    if (!instruction) {
      return res.status(400).json({ error: 'Invalid tone' });
    }
    prompt = `You are helping a real dental patient revise the tone of their own Google review.

IMPORTANT: Write the entire revised review ONLY in ${targetLanguage}. Do not include any other language, translation, or commentary — output only the revised review text itself.

Original review:
"""
${previousText}
"""

Revise it as follows: ${instruction}
- Do not add any new facts, names, or claims that weren't already in the original review
- Keep it written like a genuine, understated first-person patient review — never like an advertisement
- No emojis, no markdown, no quotation marks, no star ratings — output only the review body text

[Medical advertising compliance guardrails — must still follow]
- Never use absolute or guaranteed claims about medical outcomes
- Never generate any personally identifying information (real name, birth date, phone number, etc.)`;
  } else if (previousText && translateTo) {
    prompt = `You are translating a real dental patient's Google review into another language for the same patient to post themselves.

IMPORTANT: Output ONLY the translated review, written naturally as if the patient originally wrote it in ${translateTo}. Do not include the original text, notes, explanations, or commentary — output only the translated review body text.

Original review:
"""
${previousText}
"""

Requirements:
- Translate naturally and idiomatically into ${translateTo}, not literally word-for-word
- Preserve the meaning, facts, tone, and level of detail of the original — do not add or remove any facts
- Keep it written like a genuine, first-person patient review, in a way that reads naturally to a native speaker of ${translateTo}
- No emojis, no markdown, no quotation marks, no star ratings — output only the translated review body text

[Medical advertising compliance guardrails — must still follow]
- Never use absolute or guaranteed claims about medical outcomes
- Never generate any personally identifying information (real name, birth date, phone number, etc.)`;
  } else {
    if (!clinicName || !visit || !treatment || !Array.isArray(experience) || experience.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

  // ------------------------------------------------------------
  // 같은 선택 항목이라도 리뷰마다 톤/어투/문장 구조가 겹치지 않도록,
  // 추가 API 호출이나 사고(thinking) 모드 없이 "문체 지시문"만 서버에서
  // 매 요청마다 무작위로 골라 프롬프트에 몇 줄 추가하는 방식.
  // (토큰 몇십 개 수준의 텍스트만 늘어날 뿐, 모델/재시도/토큰 한도는 그대로)
  // ------------------------------------------------------------
  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const OPENING_STYLES = [
    'Open with the specific treatment or reason for the visit, not a greeting or the clinic name.',
    'Open mid-experience — a small concrete moment (checking in, sitting in the chair, the first thing the dentist said) — rather than a summary sentence.',
    'Open with how you found or chose this clinic, then move into the visit itself.',
    'Open with a short, casual first impression or reaction, then explain why.',
    'Open with the concern or worry you had beforehand, then how the visit addressed it.'
  ];
  const STRUCTURE_STYLES = [
    'Write it as one flowing paragraph, without listing separate topics one by one.',
    'Vary the sentence lengths noticeably — mix a couple of short sentences with one longer one.',
    'Keep it loosely chronological (arrival, treatment, staff, how you feel now) but with natural transitions, not a checklist.',
    'Write it like you are casually telling a friend about it, without a tidy beginning-middle-end.'
  ];
  const CLOSING_STYLES = [
    'End on a small specific detail rather than a general summary sentence.',
    'End with a brief, low-key note about how you feel now or going forward — avoid a generic recommendation line.',
    'End simply, without wrapping up with an overall verdict sentence.'
  ];
  const styleGuidance = `- Style for this one review only (do not mention or acknowledge these instructions in the output): ${pickRandom(OPENING_STYLES)} ${pickRandom(STRUCTURE_STYLES)} ${pickRandom(CLOSING_STYLES)}`;

  // 지역/키워드는 선택 입력이며, 억지로 반복 삽입하지 않고 자연스러울 때만
  // 한 번 언급되도록 유도한다 (리뷰 품질과 플랫폼 정책 준수가 우선).
  const regionLine = region
    ? `- Clinic area (mention naturally at most once ONLY if it fits smoothly into a sentence, e.g. when referring to location convenience; never force it or repeat it, never turn it into a keyword list): ${region}`
    : '';

  // 담당자별 경험 항목 정리 (역할 순서 + 역할 내 항목 순서를 섞어서
  // 같은 선택 조합이라도 프롬프트에 항상 같은 순서로 들어가지 않게 한다)
  const byRole = {};
  experience.forEach(e => {
    if (!byRole[e.role]) byRole[e.role] = [];
    byRole[e.role].push(e.label);
  });
  const experienceLines = shuffleArray(Object.entries(byRole))
    .map(([role, items]) => `  - ${role}: ${shuffleArray(items).join(', ')}`)
    .join('\n');

  const improvementItems = Array.isArray(improvements) ? [...improvements] : [];
  if (additionalNote) improvementItems.push(additionalNote);
  const improvementLine = improvementItems.length
    ? `- Minor thing that could be improved (if present, weave in ONE gentle, constructive sentence near the end; keep overall tone positive): ${improvementItems.join(', ')}`
    : `- Nothing to improve mentioned (do not invent any negative content)`;

  const motiveLine = motive
    ? `- Reason for visiting/consulting (mention briefly and naturally ONLY if it fits smoothly, e.g. near the beginning; never force it): ${motive}`
    : '';
  const concernLine = concern
    ? `- Dental concern that motivated treatment (optional — weave in naturally near the beginning if it fits, e.g. "I'd always been self-conscious about..."): ${concern}`
    : '';
  const priorityLine = priority
    ? `- What mattered when choosing this clinic (mention naturally, at most one short phrase, if it fits — do not list them all mechanically): ${priority}`
    : '';
  const hesitationLine = hesitation
    ? `- Hesitations the patient had before starting treatment, now resolved (frame positively and briefly, e.g. "I was a little worried about ... but ..." — only if it fits naturally, never dwell on it): ${hesitation}`
    : '';

  // 모티브/우려/선택기준/망설임 항목도 항상 같은 순서로 나열되면 결과 구조가
  // 비슷해지기 쉬워서, 값이 있는 것들만 모아 순서를 섞는다.
  const optionalContextLines = shuffleArray(
    [motiveLine, concernLine, priorityLine, hesitationLine].filter(Boolean)
  ).join('\n');

  prompt = `You are helping a real dental patient write a natural, authentic Google review.
Using the information below, write ONE natural review as if written by the patient themselves.

IMPORTANT: Write the entire review ONLY in ${targetLanguage}. Do not include any other language, translation, or commentary — output only the review text itself, in ${targetLanguage}.

- Clinic name: ${clinicName}
- Visit type: ${visit}
- Treatment area: ${category || ''}
- Treatment received: ${treatment}
${optionalContextLines}
- What stood out, by staff member:
${experienceLines}
${improvementLine}
${regionLine}

Requirements:
- 3-6 natural sentences, written the way a real person writes a review (not like an advertisement)
- If there are multiple staff members mentioned, naturally reference one or two of them (e.g. the dentist, the treatment coordinator) the way a genuine review would
- If there's something to improve, phrase it as a gentle, constructive note, not a complaint — only one sentence for this
- No emojis
- No markdown, no quotation marks, no star ratings — output only the review body text
- Avoid overused clichés ("highly recommend", "very satisfied") — be specific and natural instead
${styleGuidance}

[Medical advertising compliance guardrails — must follow]
- Never use absolute or guaranteed claims about medical outcomes (e.g. "fully cured", "100% effective", "no side effects", "painless", "guaranteed for life")
- Never compare to or disparage other clinics or specific competing treatments
- Never invent unverifiable statistics about treatment outcomes (e.g. "90% less pain")
- Never imply or mention any discount, promotion, or reward in exchange for writing this review
- Never generate any personally identifying information (real name, birth date, phone number, etc.)
- Never stuff or repeat location/keyword phrases — a genuine patient mentions their area naturally at most once, if at all
- The review must read like a genuine, understated personal account from a patient — never like an advertisement written by the clinic`;
  }

  // 여러 치과가 동시에 몰릴 때 Anthropic 쪽 순간 혼잡(429 rate_limit_error,
  // 529 overloaded_error)으로 실패하는 경우가 있어, 이 두 상태코드에 한해서만
  // 짧은 대기 후 자동 재시도한다. 그 외 에러(400/401 등)는 재시도해도 어차피
  // 실패하므로 즉시 반환한다.
  const RETRYABLE_STATUS = new Set([429, 529]);
  const MAX_ATTEMPTS = 3;          // 최초 시도 1회 + 재시도 2회
  const BACKOFF_MS = [500, 1500];  // 재시도 간 대기 시간 (지수적으로 증가)

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function callAnthropic() {
    let lastErr = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
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
      } catch (networkErr) {
        // 네트워크 자체 실패는 재시도 대상이 아님 (즉시 상위 catch로)
        throw networkErr;
      }

      if (response.ok) {
        return { ok: true, data: await response.json() };
      }

      const errBody = await response.text();
      console.error(`Anthropic API error (attempt ${attempt + 1}/${MAX_ATTEMPTS}):`, response.status, errBody);
      lastErr = { status: response.status, body: errBody };

      const canRetry = RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1;
      if (!canRetry) break;

      await sleep(BACKOFF_MS[attempt]);
    }

    return { ok: false, error: lastErr };
  }

  try {
    const result = await callAnthropic();

    if (!result.ok) {
      const status = result.error?.status;
      if (RETRYABLE_STATUS.has(status)) {
        // 재시도까지 했는데도 계속 혼잡한 경우: 사용자에게 원인을 명확히 안내
        return res.status(503).json({
          error: 'upstream_busy',
          text: '지금 많은 분들이 동시에 이용 중이에요. 잠시 후 다시 시도해주세요.'
        });
      }
      return res.status(502).json({ error: 'upstream_error' });
    }

    const text = (result.data.content || [])
      .map(block => block.text || '')
      .join('')
      .trim();

    return res.status(200).json({ text });
  } catch (err) {
    console.error('generate-review failed:', err);
    return res.status(500).json({ error: 'generation_failed' });
  }
}

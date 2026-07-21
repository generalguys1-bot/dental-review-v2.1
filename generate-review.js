// Vercel Serverless Function
// 배포 시 Vercel 프로젝트의 Environment Variables에 ANTHROPIC_API_KEY를 등록하세요.
// (Anthropic API 키는 https://console.anthropic.com 에서 발급)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    clinicName, visit, category, treatment,
    experience, improvements, additionalNote
  } = req.body || {};

  if (!clinicName || !visit || !treatment || !Array.isArray(experience) || experience.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

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
    ? `- 아쉬웠던 점 (있다면 리뷰 끝에 부드럽고 건설적인 한 문장으로만 짧게 포함, 전체 톤은 여전히 긍정적으로 유지): ${improvementItems.join(', ')}`
    : `- 아쉬웠던 점: 없음 (부정적인 내용을 지어내지 말 것)`;

  const prompt = `너는 실제 환자가 남기는 자연스러운 구글 치과 리뷰를 대신 작성해주는 도우미야.
아래 정보를 참고해서, 실제 사람이 쓴 것처럼 자연스럽고 담백한 한국어 구글 리뷰를 1개 작성해줘.

- 치과 이름: ${clinicName}
- 방문 유형: ${visit}
- 진료 분야: ${category || ''}
- 받은 치료: ${treatment}
- 담당자별로 좋았던 점:
${experienceLines}
${improvementLine}

조건:
- 3~5문장 정도의 자연스러운 리뷰체 (과장된 광고 문구 금지)
- 담당자별 항목이 여러 개면, 자연스럽게 한두 명(예: 원장님, 상담실장님)을 실제 후기처럼 언급해도 좋음
- 아쉬운 점이 있다면 비난조가 아니라 담백한 개선 제안처럼 한 문장만 넣기
- 이모지는 쓰지 않기
- 마크다운, 따옴표, 별점 텍스트 없이 리뷰 본문만 출력
- 클리셰 표현("매우 만족", "강추") 남발하지 말고, 담백하고 구체적으로

[의료광고 준수 가드레일 — 반드시 지킬 것]
- "완치", "100% 효과", "부작용 없음", "무통증", "평생 보장" 등 의료 효과를 단정·보장하는 표현은 절대 쓰지 말 것
- 다른 치과나 특정 치료법과 비교·폄하하는 표현 금지
- 치료 결과를 객관적으로 확인할 수 없는 수치(예: "통증 90% 감소")를 임의로 만들어내지 말 것
- 할인, 이벤트, 금전적 혜택을 암시하거나 리뷰 작성의 대가를 언급하는 내용 금지
- 환자 개인을 특정할 수 있는 정보(실명, 생년월일, 연락처 등)는 생성하지 말 것
- 어디까지나 "환자 개인의 주관적 경험 후기"처럼 담백하게 작성하고, 병원이 작성한 광고처럼 보이지 않게 할 것`;

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

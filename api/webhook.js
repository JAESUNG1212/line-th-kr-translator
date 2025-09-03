// api/webhook.js
// Node 18+ (Vercel) 기준: fetch 전역 사용 가능. 만약 node-fetch 사용 중이면 import 유지해도 OK.

// ──────────────────────────────────────────────────────────────
// 환경설정
//  - OPENAI_API_KEY : OpenAI 키 (Vercel 환경변수에 저장됨)
//  - OPENAI_MODEL   : 기본 gpt-4o-mini (원하면 gpt-4o로 바꾸되 무료계정은 실패 가능)
//  - LINE_CHANNEL_ACCESS_TOKEN : LINE 채널 액세스 토큰(long-lived)
// ──────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini"; // 무료 안정용
const LINE_TOKEN     = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 간단한 타이문자 감지 (방향 추정용)
const THAI_RE = /[\u0E00-\u0E7F]/;

// ──────────────────────────────────────────────────────────────
// 시스템 프롬프트 (모든 요청 공통 규칙)
// ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a STRICT bilingual translator between **Korean** and **Thai** in LINE.

## GOALS
- Do ONLY translation. NO explanations, NO commentary, NO prefix/suffix.
- Be **friendly + polite** always.
- Keep the original tone (casual/friendly), but **Korean output** must be natural **-요/해요** style.
- **Thai output** must be male polite ending "**ครับ**" (use **ค่ะ/คะ** only if the speaker is female, but default is male).
- Preserve emojis, punctuation, "**ㅋㅋ/ㅎㅎ**", "**555**" etc. Do not remove them.

## NAME RULE
- If Korean source contains **"깨우"**, translate it as **"แก้ว"** in Thai.
- If Thai source contains **"แก้ว"**, translate it as **"깨우"** in Korean.
(These are the SAME PERSON's name.)

## DIRECTION
- Detect the source language automatically:
  - If input is mostly **Korean** → output **Thai** (male polite "**ครับ**").
  - If input is mostly **Thai** → output **Korean** (친근한 존댓말).
- Never output JSON, brackets, labels, or any meta text. Translation ONLY (single line or multiple lines as needed).

## STYLE
- Korean output: friendly polite (자연스런 -요/해요), not stiff.
- Thai output: male polite, end sentences with "**ครับ**" where natural.
- Do not add extra content.
`;

// ──────────────────────────────────────────────────────────────
// OpenAI 호출 (mini 우선)  — 무료계정 레이트리밋을 고려한 간단 재시도 포함
// ──────────────────────────────────────────────────────────────
async function callOpenAI({ model, user, temperature = 0.2, maxTokens = 320 }) {
  const targetModel = model || OPENAI_MODEL || "gpt-4o-mini";

  const body = {
    model: targetModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: user },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let text;
  try { text = await r.text(); } catch { text = ""; }

  if (!r.ok) {
    // 무료/한도/권한 문제는 429/400/401/403 등으로 옴
    const err = new Error(text || `OpenAI ${r.status}`);
    err.status = r.status;
    throw err;
  }

  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`OpenAI JSON parse error: ${e?.message || e}`);
  }

  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("Empty completion");
  return out;
}

// ──────────────────────────────────────────────────────────────
// LINE 응답 유틸
// ──────────────────────────────────────────────────────────────
async function replyToLine(replyToken, text) {
  const payload = {
    replyToken,
    messages: [{ type: "text", text }],
  };
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
}

// ──────────────────────────────────────────────────────────────
// 핸들러
// ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }
  try {
    const { events } = req.body || {};
    if (!events || !Array.isArray(events)) {
      return res.status(200).json({ ok: true });
    }

    for (const ev of events) {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      const text = (ev.message?.text || "").trim();
      const replyToken = ev.replyToken;

      if (!text) {
        await replyToLine(replyToken, "번역할 문장이 비어 있어요. 다시 보내 주세요.");
        continue;
      }

      // 간단한 방향 안내(모델이 알아서 하지만 안전빵)
      const isThai = THAI_RE.test(text);
      const directionHint = isThai
        ? "(Thai → Korean)\n"
        : "(Korean → Thai)\n";

      // 사용자 프롬프트 구성
      const userPrompt = `${directionHint}${text}`;

      let translated;
      try {
        translated = await callOpenAI({
          model: OPENAI_MODEL || "gpt-4o-mini",
          user: userPrompt,
          temperature: 0.2,
          maxTokens: 340,
        });
      } catch (e) {
        // 레이트 리밋/쿼터 등 무료계정 이슈 안내
        console.error("[OpenAI error]", e?.status, e?.message);
        await replyToLine(
          replyToken,
          "번역에 실패했어요. (서버/쿼터 문제일 수 있어요) 잠시 뒤 다시 시도해 주세요."
        );
        continue;
      }

      // 최종 전송
      await replyToLine(replyToken, translated);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e);
    return res.status(200).json({ ok: true });
  }
}

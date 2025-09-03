// api/webhook.js
import fetch from "node-fetch";

/**
 * 요구사항 요약
 * - 오직 번역만 (잡담/설명 금지)
 * - 항상 “친근한 존댓말”로 번역
 * - KR->TH: 태국어는 남성 존댓말(ครับ/ครับครับ 금지, "ครับ" 1회), 애칭 “แก้ว”는 "แก้ว"로 유지
 * - TH->KR: 한국어는 남성 친근 존댓말(~요/~해요)
 * - 한국어 입력 시: 태국어 1줄 + [직역] 한국어 1줄
 * - 태국어 입력 시: 한국어 1줄 + [직역] 태국어 1줄
 * - ㅋㅋ/ㅎㅎ/555 등은 자연스럽게 유지/반영
 * - JSON/코드 금지, 일반 텍스트 2줄만
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // 상위 모델 (권한/쿼터 OK면 사용)
const FALLBACK_MODEL = "gpt-4o-mini";                      // 실패 시 자동 폴백
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const DEBUG = process.env.DEBUG === "1";

// --------------------- OpenAI 호출 ---------------------
async function callOpenAI({ model, prompt }) {
  const body = {
    model,
    input: prompt,
    response_format: { type: "text" }, // 텍스트만 받기
    max_output_tokens: 2000
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (DEBUG) console.log(`[OpenAI ${model}] status=${resp.status} body=${raw}`);
  if (!resp.ok) throw new Error(`OpenAI ${model} error: ${resp.status} ${raw}`);

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`OpenAI ${model} invalid_json`); }

  const text = data?.output_text?.trim?.() || "";
  if (!text) throw new Error(`OpenAI ${model} empty_text`);
  return text;
}

// 상위 모델 실패하면 mini로 자동 폴백
async function translateWithFallback(prompt) {
  try {
    return await callOpenAI({ model: OPENAI_MODEL, prompt });
  } catch (e) {
    console.error("[OpenAI primary failed]", e?.message);
    try {
      return await callOpenAI({ model: FALLBACK_MODEL, prompt });
    } catch (e2) {
      console.error("[OpenAI fallback failed]", e2?.message);
      throw e2;
    }
  }
}

// --------------------- 번역 프롬프트 ---------------------
const SYSTEM_PROMPT = `
You are a STRICT translation engine used by a Korean man and his Thai girlfriend on LINE.

### Hard rules
- Only translate the given message. NEVER chat, explain, or add commentary.
- Output exactly two lines (no extra text):
  1) The natural, friendly-polite translation in the target language.
  2) A literal back-translation line prefixed with "[직역] ".
- Preserve emojis and laughter (e.g., ㅋㅋ/ㅎㅎ/555) naturally.
- No JSON, no code, no quotes around the sentences.

### Style
- Korean -> Thai: 
  - Output polite male Thai ending **"ครับ"** (exactly once per sentence; not duplicated).
  - Use girlfriend's pet name “แก้ว” as **"แก้ว"**.
- Thai -> Korean:
  - Output friendly polite Korean (~요/~해요).
- Keep the message concise and natural.

### Direction handling
- If input language is Korean:
  - Line1: Thai translation (male polite "ครับ").
  - Line2: "[직역] " + literal Korean (back-translation of the Thai line into Korean).
- If input language is Thai:
  - Line1: Korean translation (friendly polite).
  - Line2: "[직역] " + literal Thai (back-translation of the Korean line into Thai).
`;

// 사용자 입력을 프롬프트에 꽂기
function buildPrompt(userText) {
  return `${SYSTEM_PROMPT}\n\nUser message:\n${userText}\n\nReturn only the two lines as specified.`;
}

// --------------------- LINE 유틸 ---------------------
async function replyToLine(replyToken, text) {
  const resp = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (DEBUG) {
    const t = await resp.text();
    console.log("[LINE reply]", resp.status, t);
  }
  if (!resp.ok) throw new Error(`LINE reply ${resp.status}`);
}

// --------------------- 핸들러 ---------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body || {};
    const events = body.events || [];
    if (DEBUG) console.log("[Webhook body]", JSON.stringify(body).slice(0, 2000));

    for (const ev of events) {
      if (ev.type !== "message") continue;
      if (!ev.message || ev.message.type !== "text") continue;

      const userText = (ev.message.text || "").trim();
      if (!userText) continue;

      const prompt = buildPrompt(userText);

      let resultText;
      try {
        resultText = await translateWithFallback(prompt);
      } catch (e) {
        console.error("[Translate failed]", e?.message);
        resultText = `[번역 실패] ${userText}`;
      }

      // 안전: 5000자 제한
      if (resultText.length > 5000) resultText = resultText.slice(0, 5000);

      // 응답
      try {
        await replyToLine(ev.replyToken, resultText);
      } catch (e) {
        console.error("[LINE reply failed]", e?.message);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[Webhook error]", e?.message);
    return res.status(200).json({ ok: false });
  }
}

import fetch from "node-fetch";

/**
 * 견고한 안전모드 + 모델 폴백
 * - JSON 파싱 제거 (텍스트만 받기)
 * - gpt-4o(또는 OPENAI_MODEL) → 실패 시 gpt-4o-mini 자동 폴백
 * - 디버그 로그 강화 (DEBUG=1 설정 시)
 * - KR→TH: 1줄 태국어(남성 존댓말, “깨우”→“แก้ว”), 다음줄에 한국어 직역
 * - TH→KR: 한국어 1줄 (친근한 존댓말 ~요/~해요)
 * - ㅋㅋ/ㅎㅎ ↔ 555/ฮ่าๆ 보정 (설명문 금지)
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DEBUG = process.env.DEBUG === "1";

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

RULES:
- OUTPUT MUST BE ONLY THE FINAL TRANSLATION TEXT. 
- DO NOT add explanations, markdown, code fences, JSON, or any extra text.
- If the input is Korean:
  1) Replace the name "깨우" with "แก้ว".
  2) Translate to Thai, male polite tone (end with "ครับ").
  3) First line: Thai translation only.
  4) Second line: literal Korean back-translation in parentheses like (…).
- If the input is Thai:
  - Translate to Korean (friendly polite form ~요/~해요), single line only.
- Normalize laughter:
  - ㅋㅋ/ㅎㅎ -> 555/ฮ่าๆ in Thai
  - 555/ฮ่าๆ -> ㅋㅋ/ㅎㅎ in Korean
- AGAIN: Output ONLY the final lines as described. No extra words.
`;

function cleanText(s) {
  if (!s) return "";
  // 코드펜스/마크다운 제거
  s = s.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[a-zA-Z]*\n?/, "").replace(/```$/, "")
  );
  // 흔한 불필요 머리말 제거 시도
  s = s.replace(/^(?:\s*Output\s*:|\s*Result\s*:|\s*Translation\s*:)\s*/i, "");
  return s.trim();
}

async function callOpenAI(model, userText) {
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
    max_tokens: 500,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  let json;
  try {
    json = await r.json();
  } catch (e) {
    if (DEBUG) console.log("OpenAI JSON parse error:", e);
    return { ok: false, reason: "json_parse_error", text: "" };
  }

  if (DEBUG) {
    console.log("=== OpenAI status:", r.status, r.statusText);
    console.log("=== OpenAI raw:", JSON.stringify(json, null, 2).slice(0, 4000));
  }

  if (!r.ok) {
    const reason = json?.error?.message || r.statusText || "openai_error";
    return { ok: false, reason, text: "" };
  }

  const raw = json?.choices?.[0]?.message?.content || "";
  const text = cleanText(raw);
  if (!text) return { ok: false, reason: "empty_content", text: "" };

  // 설명문 들어간 흔적 있으면 제거 재시도
  if (text.includes("```")) {
    const cleaned = cleanText(text);
    if (cleaned) return { ok: true, reason: "ok", text: cleaned };
  }

  return { ok: true, reason: "ok", text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userMsg = (event.message.text || "").trim();
      if (DEBUG) console.log("User says:", userMsg);

      // 1차: 설정된 모델(기본 gpt-4o)
      let ai = await callOpenAI(OPENAI_MODEL, userMsg);

      // 4o/5가 막혔거나 쿼터 문제일 수 있음 → 2차 폴백: gpt-4o-mini
      if (!ai.ok) {
        if (DEBUG) console.log("Primary model failed:", ai.reason);
        if (OPENAI_MODEL !== "gpt-4o-mini") {
          const fallback = await callOpenAI("gpt-4o-mini", userMsg);
          if (fallback.ok) ai = fallback;
          else if (DEBUG) console.log("Fallback mini failed:", fallback.reason);
        }
      }

      let replyText =
        ai.ok && ai.text ? ai.text : "번역에 실패했어요. 다시 시도해 주세요.";

      // LINE Reply
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: replyText }],
        }),
      });
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("Handler error:", e);
    res.status(500).send("Internal Server Error");
  }
}

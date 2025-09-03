// api/webhook.js
import fetch from "node-fetch";

/**
 * 요구사항 요약
 * - 오직 번역만 (설명/잡담 X)
 * - 한국↔태국 상호 번역, 남성 존댓말(요/합니다) & 태국어는 남성 공손체(ครับ)
 * - 한국어 입력: 태국어 1줄 + (다음줄) 한국어 직역 미리보기
 * - 태국어 입력: 한국어 1줄 + (다음줄) 태국어 직역 미리보기
 * - ㅋㅋ/ㅎㅎ/555/ลืม 등 특수한 표현은 자연스럽게 변환
 * - JSON으로만 응답(스키마 강제), 파싱 실패 시 자동 재시도 → mini로 폴백
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";     // 주 모델
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const LINE_API = "https://api.line.me/v2/bot/message/reply";
const OAI_URL   = "https://api.openai.com/v1/responses";

// ---------- 유틸 ----------
const jsonHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${OPENAI_API_KEY}`,
};

function replyMessage(replyToken, text) {
  return fetch(LINE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

function isThai(txt) {
  return /[\u0E00-\u0E7F]/.test(txt);
}

function buildSystemPrompt() {
  return `
You are a STRICT translation engine between Korean and Thai for LINE chat.
RULES:
- OUTPUT ONLY JSON that matches the provided JSON Schema. No extra text.
- If input is Korean ➜ produce Thai (male polite tone using "ครับ") as "primary",
  and put a literal Korean back-translation preview in "preview".
- If input is Thai ➜ produce Korean (male polite 존댓말) as "primary",
  and put Thai literal back-translation preview in "preview".
- Be concise; one sentence per field.
- Never include any explanations, notes, or extra keys.
- No code fences. No markdown. Only JSON.
`;
}

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "translation_payload",
    schema: {
      type: "object",
      properties: {
        primary: { type: "string" }, // 최종 번역문
        preview: { type: "string" }, // 원문 언어로의 직역 미리보기
      },
      required: ["primary", "preview"],
      additionalProperties: false,
    },
    strict: true,
  },
};

async function callOpenAI(model, userText, direction) {
  const content = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content:
        `Input language: ${direction === "KR->TH" ? "Korean" : "Thai"}\n` +
        `Output target: ${direction === "KR->TH" ? "Thai (male polite 'ครับ')" : "Korean (남성 공손 존댓말)"}\n` +
        `Text: """${userText}"""`,
    },
  ];

  const res = await fetch(OAI_URL, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      model,
      input: content,
      temperature: 0.2,
      max_output_tokens: 350,
      response_format: RESPONSE_FORMAT, // ★ JSON 스키마 강제
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status} ${errText}`);
  }

  const data = await res.json();

  // responses API: data.output[0].content[0].text
  const text =
    data?.output?.[0]?.content?.[0]?.text ??
    data?.output_text ??
    data?.choices?.[0]?.message?.content ??
    "";

  if (!text) throw new Error("Empty OpenAI response");

  // 견고한 파서: JSON 스키마 강제지만, 혹시나 깨지면 복구 시도
  try {
    return JSON.parse(text);
  } catch {
    // 가장 바깥 {}만 추출하여 재시도
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* no-op */
      }
    }
    throw new Error("JSON parse failed");
  }
}

async function translate(userText) {
  const direction = isThai(userText) ? "TH->KR" : "KR->TH";

  // 1차: 지정 모델(예: gpt-4o)
  try {
    const r = await callOpenAI(OPENAI_MODEL, userText, direction);
    if (typeof r?.primary === "string" && typeof r?.preview === "string") {
      return r;
    }
    throw new Error("schema mismatch");
  } catch (e) {
    // 2차: mini 폴백
    try {
      const r2 = await callOpenAI("gpt-4o-mini", userText, direction);
      if (typeof r2?.primary === "string" && typeof r2?.preview === "string") {
        return r2;
      }
      throw new Error("fallback schema mismatch");
    } catch (e2) {
      // 마지막: 그냥 원문 반환
      return { primary: "[번역 실패] " + userText, preview: "" };
    }
  }
}

// ---------- LINE Webhook ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  try {
    const { events } = req.body || {};
    if (!Array.isArray(events)) {
      res.status(200).json({ ok: true });
      return;
    }

    for (const ev of events) {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;
      const text = (ev.message?.text || "").trim();
      if (!text) continue;

      // 번역
      const out = await translate(text);
      const final = out.preview
        ? `${out.primary}\n\n— 미리보기: ${out.preview}`
        : out.primary;

      await replyMessage(ev.replyToken, final);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    // 안전망
    try {
      const ev = req.body?.events?.[0];
      if (ev?.replyToken) {
        await replyMessage(ev.replyToken, "번역 형식 오류가 발생했어요. 다시 시도해 주세요.");
      }
    } catch {}
    res.status(200).json({ ok: true });
  }
}

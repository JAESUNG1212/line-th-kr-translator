// api/webhook.js
import fetch from "node-fetch";

/**
 * ─────────────────────────────────────────────────────────────────
 * 안정판 번역 Webhook (버그 수정版)
 *  - 오직 번역만 (설명/잡담 금지)
 *  - 항상 “친근한 존댓말” 번역
 *  - TH->KR: 한국어는 ~요/해요
 *  - KR->TH: 태국어는 남성 존댓말(ครับ) + “깨우”는 고유명사 “แก้ว”로
 *  - JSON 강제 & 파싱 보정, 실패시 단문 대체, 429 자동 재시도
 *  - LINE 메시지 길이(2,000자) 안전 가드
 *  - ❗ OpenAI 응답 파싱 버그 수정: choices[0].message.content 를 사용
 * ─────────────────────────────────────────────────────────────────
 */

// ---- 환경변수
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // 기본 gpt-4o-mini 권장
const BACKLITERAL = (process.env.BACKLITERAL || "on").toLowerCase() !== "off"; // 직역줄 on/off

// ---- 상수
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const LINE_MAX = 2000; // LINE text message 최대 길이

// ---- 유틸
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trimFence(s) {
  if (!s) return s;
  // ```json ... ```
  return s
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function safeParseJSON(str) {
  try {
    if (typeof str !== "string") return null;
    const cleaned = trimFence(str);
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function detectThai(text) {
  // 태국어 유니코드 블록 포함 여부
  return /[\u0E00-\u0E7F]/.test(text);
}

function truncateLine(s, limit = LINE_MAX) {
  if (typeof s !== "string") return "";
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + "…";
}

// ---- OpenAI 호출 (429 재시도, 타임아웃 보장)
// ❗ 수정: API 전체 raw 텍스트가 아니라, data.choices[0].message.content 를 뽑아 반환
async function askOpenAI(messages, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    const status = res.status;
    const data = await res.json().catch(() => null);

    if (!res.ok || !data) {
      return { ok: false, status, content: null, errorRaw: JSON.stringify(data) };
    }

    const content =
      data?.choices?.[0]?.message?.content?.toString() ?? "";

    return { ok: true, status, content, errorRaw: null };
  } catch (e) {
    return { ok: false, status: 0, content: null, errorRaw: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function askWithRetry(messages, { timeoutMs = 15000, retries = 2 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    last = await askOpenAI(messages, { timeoutMs });
    if (last?.status === 429 && i < retries) {
      // 429면 점진 백오프 후 재시도
      await sleep(800 * (i + 1));
      continue;
    }
    return last;
  }
  return last;
}

// ---- LINE Reply
async function lineReply(replyToken, texts = []) {
  // 항상 최소 1줄 보장
  const messages =
    texts.length > 0
      ? texts.map((t) => ({ type: "text", text: truncateLine(t) }))
      : [{ type: "text", text: "번역에 실패했어요. 다시 시도해 주세요." }];

  const res = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  // LINE 응답도 로깅
  const raw = await res.text();
  if (!res.ok) {
    console.error("LINE Reply Error:", res.status, raw);
  }
}

// ---- System Prompt (JSON 강제)
const SYSTEM_PROMPT = `
You are a strict translation engine for a Korean man and his Thai girlfriend on LINE.
Return a pure JSON object ONLY (no code fence, no commentary).

Rules:
- Detect source: if input has Thai letters → translate to Korean.
- Otherwise → translate to Thai.
- KR → TH: Use friendly polite Thai for a male speaker (end with "ครับ"), and whenever "깨우" is a name, use the Thai proper name "แก้ว". Do not translate names other than mapping "깨우" → "แก้ว".
- TH → KR: Use friendly polite Korean (~요/해요).
- No extra comments, no emojis, no examples.
- Never add explanations.
- Keep it natural, concise, and conversation-ready.

Return JSON:
{
  "translated": "<final natural translation>",
  "literal": "<literal/word-by-word if helpful, otherwise empty string>"
}
`;

// ---- 사용자 프롬프트 생성
function buildUserPrompt(userText, sourceIsThai) {
  return `
Input:
${userText}

Meta:
- Source: ${sourceIsThai ? "TH" : "KR"}
- Target: ${sourceIsThai ? "KR" : "TH"}
- Only translate. No extra comments.
- Keep honorific style (${sourceIsThai ? "KR: 친근한 존댓말(요/해요)" : "TH: 남성 존댓말(ครับ)"}).
`;
}

// ---- 메인 핸들러
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (!OPENAI_API_KEY) return res.status(500).send("Missing OPENAI_API_KEY");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const events = body?.events || [];
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(200).json({ ok: true });
    }

    for (const event of events) {
      const replyToken = event?.replyToken;
      const text = event?.message?.text;

      // 텍스트 메시지 외는 무시
      if (!replyToken || !text || event.type !== "message") continue;

      const isThai = detectThai(text);

      const messages = [
        { role: "system", content: SYSTEM_PROMPT.trim() },
        { role: "user", content: buildUserPrompt(text, isThai).trim() },
      ];

      // OpenAI 호출 (재시도 포함)
      const { ok, status, content, errorRaw } = await askWithRetry(messages, {
        timeoutMs: 15000,
        retries: 2,
      });

      // 디버깅 로그
      console.log("OpenAI status:", status);
      if (content) console.log("CONTENT:", content.slice(0, 1000));
      if (errorRaw) console.log("OpenAI errorRaw:", errorRaw);

      let outTexts = [];

      if (ok && typeof content === "string" && content.trim()) {
        // assistant의 content(우리가 강제한 JSON 문자열)를 파싱
        const parsed = safeParseJSON(content);
        const translated = parsed?.translated?.toString()?.trim() || "";
        const literal = parsed?.literal?.toString()?.trim() || "";

        if (translated) {
          outTexts.push(translated);
          if (BACKLITERAL && literal) {
            outTexts.push(`(직역) ${literal}`);
          }
        } else {
          outTexts = ["번역 형식 파싱에 실패했어요. 다시 한 번 보내주세요."];
        }
      } else {
        // 401/429/timeout 등 실패 시 단문 대체
        outTexts = ["번역에 실패했어요. 다시 시도해 주세요."];
        console.error("OpenAI error:", status, errorRaw);
      }

      await lineReply(replyToken, outTexts);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(200).json({ ok: false });
  }
}

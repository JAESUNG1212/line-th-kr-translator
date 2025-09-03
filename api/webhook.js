import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (설명/잡담 금지)
 * - 항상 “친근한 존댓말”로 번역
 * - KR→TH: 태국어는 남성 존댓말 톤(~ครับ 사용), "깨우"→"แก้ว", 한글 금지
 * - TH→KR: 한국어는 남성 친근 존댓말(~요/해요)
 * - 한국어 입력 시: 태국어 1줄 + (GPT가 번역한 태국어를 한국어로 직역 1줄)
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋ/ㅎㅎ → 555/ฮ่าๆ 변환
 * - JSON 강제 X (일반 텍스트만 출력)
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // 기본 모델
const FALLBACK_MODEL = "gpt-4o-mini"; // 실패 시 자동 폴백
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DEBUG = process.env.DEBUG;

// OpenAI 호출기 (모델에 따라 엔드포인트 분기)
async function callOpenAI({ model, prompt }) {
  const useChat = /gpt-5|gpt-4o/i.test(model); // 상위 모델은 chat.completions

  const url = useChat
    ? "https://api.openai.com/v1/chat/completions"
    : "https://api.openai.com/v1/responses";

  const body = useChat
    ? {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
      }
    : {
        model,
        input: prompt,
        response_format: { type: "text" },
        max_output_tokens: 2000,
      };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (DEBUG) console.log(`[OpenAI ${model}] status=${resp.status} body=${raw}`);
  if (!resp.ok)
    throw new Error(`OpenAI ${model} error: ${resp.status} ${raw}`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI ${model} invalid_json`);
  }

  // chat.completions
  if (useChat) {
    const text = data?.choices?.[0]?.message?.content?.trim?.() || "";
    if (!text) throw new Error(`OpenAI ${model} empty_text`);
    return text;
  }

  // responses
  const text = data?.output_text?.trim?.() || "";
  if (!text) throw new Error(`OpenAI ${model} empty_text`);
  return text;
}

// 폴백 포함 번역기
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

// LINE Reply API
async function replyMessage(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
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
}

// 번역 프롬프트
function buildPrompt(userText, isKorean) {
  return isKorean
    ? `다음 한국어 문장을 태국어로 번역해줘. 조건:
- 남성이 사용하는 친근한 존댓말로 번역 (태국어 끝에 ~ครับ)
- "깨우"라는 단어는 "แก้ว"로 번역
- 한국어 단어는 태국어 번역문에 절대 섞지 말 것
- ㅋㅋ, ㅎㅎ, 하하 → 555 또는 ฮ่าๆ 로 변환
출력 형식:
1. 번역된 태국어 (자연스럽게)
2. (그 아래줄) 한국어로 직역한 버전

문장: ${userText}`
    : `다음 태국어 문장을 한국어로 번역해줘. 조건:
- 남성이 사용하는 친근한 존댓말(~요/~해요)
- 태국어 단어는 한국어 번역문에 절대 섞지 말 것
- 555, ฮ่าๆ → ㅋㅋ/ㅎㅎ로 변환
출력 형식: 번역된 한국어 한 줄만

문장: ${userText}`;
}

// Webhook 엔드포인트
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userText = event.message.text;
      const isKorean = /[가-힣]/.test(userText);

      const prompt = buildPrompt(userText, isKorean);
      const translation = await translateWithFallback(prompt);

      await replyMessage(event.replyToken, translation);
    }
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
}

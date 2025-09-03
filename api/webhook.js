import fetch from "node-fetch";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const FALLBACK_MODEL = "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DEBUG = !!process.env.DEBUG;

// ----- 공통 fetch + 타임아웃 -----
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ----- OpenAI 호출 (엔드포인트 분기 + 429 백오프) -----
async function callOpenAIOnce({ model, prompt }) {
  const useChat = /gpt-5|gpt-4o$/i.test(model); // gpt-5, gpt-4o 는 Chat
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
        response_format: { type: "text" }, // Responses API에서만 허용
        max_output_tokens: 2000,
      };

  if (DEBUG) console.log(`[OPENAI REQ] model=${model} chat=${useChat}`);

  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    20000
  );

  const text = await resp.text();
  if (DEBUG) console.log(`[OPENAI RES] status=${resp.status} body=${text.slice(0, 300)}...`);

  if (!resp.ok) {
    // 429 / 400 등 에러 본문 포함해 던짐
    throw new Error(`OpenAI ${model} ${resp.status}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI ${model} invalid_json`);
  }

  if (useChat) {
    const out = data?.choices?.[0]?.message?.content?.trim?.() || "";
    if (!out) throw new Error(`OpenAI ${model} empty_text`);
    return out;
  } else {
    const out = data?.output_text?.trim?.() || "";
    if (!out) throw new Error(`OpenAI ${model} empty_text`);
    return out;
  }
}

// 429 백오프 2회 포함
async function callOpenAI({ model, prompt }) {
  let delay = 800;
  for (let i = 0; i < 3; i++) {
    try {
      return await callOpenAIOnce({ model, prompt });
    } catch (e) {
      if (DEBUG) console.log(`[OPENAI ERR] try=${i + 1} ${e.message}`);
      if (/ 429: /.test(e.message) && i < 2) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
}

// 폴백 호출
async function translateWithFallback(prompt) {
  try {
    return await callOpenAI({ model: OPENAI_MODEL, prompt });
  } catch (e) {
    console.error("[OpenAI primary failed]", e.message);
    try {
      return await callOpenAI({ model: FALLBACK_MODEL, prompt });
    } catch (e2) {
      console.error("[OpenAI fallback failed]", e2.message);
      throw e2;
    }
  }
}

// ----- LINE reply -----
async function replyMessage(replyToken, text) {
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
  const t = await resp.text();
  if (DEBUG) console.log(`[LINE REPLY] status=${resp.status} ${t.slice(0, 200)}...`);
}

// ----- 프롬프트 -----
function buildPrompt(userText, isKorean) {
  if (isKorean) {
    return `다음 한국어 문장을 태국어로 번역해줘. 조건:
- 남성이 사용하는 친근한 존댓말(문장 끝에 ~ครับ)
- "깨우"는 반드시 "แก้ว" 로 번역
- 한국어 단어는 태국어 문장에 섞지 말 것
- ㅋㅋ/ㅎㅎ/하하 → 555 또는 ฮ่าๆ
출력 형식:
1) 번역된 태국어
2) 다음 줄에 한국어 직역 한 줄

문장: ${userText}`;
  } else {
    return `다음 태국어 문장을 한국어로 번역해줘. 조건:
- 남성이 사용하는 친근한 존댓말(~요/~해요)
- 태국어 단어는 한국어 문장에 섞지 말 것
- 555, ฮ่าๆ → ㅋㅋ/ㅎㅎ
출력 형식: 번역된 한국어 한 줄만

문장: ${userText}`;
  }
}

// ----- 핸들러 -----
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const events = req.body?.events || [];

    for (const event of events) {
      // 재전송 무시
      if (event?.deliveryContext?.isRedelivery) {
        if (DEBUG) console.log("[SKIP] redelivery event");
        continue;
      }
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userText = event.message.text || "";
      const isKorean = /[가-힣]/.test(userText);
      const prompt = buildPrompt(userText, isKorean);

      let out;
      try {
        out = await translateWithFallback(prompt);
      } catch (e) {
        // 429/쿼터/기타 에러… 사용자에게는 친절 메시지
        out = "번역에 실패했어요. (서버/쿼터 문제일 수 있어요) 잠시 뒤 다시 시도해 주세요.";
      }
      await replyMessage(event.replyToken, out);
    }
    // 항상 200으로 응답해서 재전송 막기
    return res.status(200).end();
  } catch (e) {
    console.error("Webhook fatal:", e.message);
    return res.status(200).end();
  }
}

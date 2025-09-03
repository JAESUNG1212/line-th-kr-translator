import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (설명/잡담 X)
 * - 항상 “친근한 존댓말”로 번역
 * - KR→TH: 태국어는 남성 존댓말 톤 (~ครับ 사용), “깨우” → “แก้ว”, 한글 금지
 * - TH→KR: 한국어는 남성 친근 존댓말 (~요/해요)
 * - 한국어 입력 시: 태국어 1줄 + (GPT가 번역한 태국어를 다시 한국어로 직역한 백번역 1줄)
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋ/ㅎㅎ → 555/ฮ่าๆ 변환
 * - JSON 강제 (잡담 금지)
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// JSON이 앞뒤로 깨져도 중괄호만 뽑아 파싱
function parseLooseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const maybe = text.slice(first, last + 1);
      return JSON.parse(maybe);
    }
    throw new Error("JSON parse failed");
  }
}

// OpenAI 호출
async function callOpenAI({ model, content }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: content,
      temperature: 0.2,
      max_output_tokens: 800,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "translation",
          schema: {
            type: "object",
            properties: {
              primary: { type: "string" },
              backtranslation: { type: "string" }
            },
            required: ["primary"],
            additionalProperties: false
          },
          strict: true
        }
      },
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("OpenAI HTTP", res.status, txt);
    throw new Error(`OpenAI ${res.status}`);
  }

  const data = await res.json();
  const out = data?.output?.[0]?.content?.[0]?.text ?? "";
  const parsed = parseLooseJSON(out);
  if (!parsed?.primary) throw new Error("no primary");

  return parsed;
}

// 모델 폴백 (gpt-5 → gpt-4o → gpt-4o-mini)
async function translateWithFallback(prompt) {
  const order = [
    OPENAI_MODEL,
    "gpt-4o",
    "gpt-4o-mini"
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  let lastErr;
  for (const m of order) {
    try {
      return await callOpenAI({ model: m, content: prompt });
    } catch (e) {
      lastErr = e;
      console.error("[OpenAI Fail]", m, e?.message);
    }
  }
  throw lastErr || new Error("All models failed");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userText = event.message.text.trim();

    // 프롬프트 생성
    const prompt = [
      {
        role: "system",
        content: `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.
Rules:
- Always output pure JSON with fields { "primary": "...", "backtranslation": "..." }
- No commentary, no explanation.
- If input is Korean: translate into Thai (male polite tone, use ครับ), and also give literal Korean backtranslation.
- If input is Thai: translate into Korean (friendly 존댓말). Backtranslation can be empty "".
- Replace "깨우" with "แก้ว".
- Replace ㅋㅋ/ㅎㅎ with 555/ฮ่าๆ.
`
      },
      {
        role: "user",
        content: userText
      }
    ];

    let replyText = "";
    try {
      const result = await translateWithFallback(prompt);

      if (result.backtranslation && result.backtranslation.trim() !== "") {
        replyText = `${result.primary}\n(${result.backtranslation})`;
      } else {
        replyText = result.primary;
      }
    } catch (err) {
      console.error("Translate Error", err);
      replyText = "번역에 실패했어요. 다시 시도해 주세요.";
    }

    // LINE Reply API
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: replyText }],
      }),
    });
  }

  res.status(200).end();
}

import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (설명/잡담 X)
 * - 항상 "친근한 존댓말"로 번역
 * - KR→TH: 태국어는 남성 존댓말 톤(~ครับ 사용), "깨우" → "แก้ว"
 * - TH→KR: 한국어는 남성 친근 존댓말(~요/해요)
 * - 한국어 입력 시: 태국어 1줄 + (GPT가 번역한 태국어를 다시 한국어로 직역한 1줄)
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋ/ㅎㅎ → 555/ฮ่าๆ 변환
 * - JSON 강제 X (일반 텍스트 출력)
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

Rules:
1. If input is Korean:
   - Translate to Thai in friendly polite male tone ("ครับ").
   - Replace "깨우" with "แก้ว".
   - Always output two lines:
     ① Thai translation only
     ② Korean back-translation of the Thai line (so user can see exactly how GPT translated it).
   - Do NOT mix Hangul in the Thai line.

2. If input is Thai:
   - Translate to Korean in friendly polite male tone (~요/~해요).
   - Output only one Korean line.

3. Always keep style natural, smooth, affectionate, and concise.
4. Replace 웃음 표현: "ㅋㅋ", "ㅎㅎ", "하하" → "555" or "ฮ่าๆๆ" in Thai.
`;

export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const events = req.body.events;
      if (!events || events.length === 0) {
        return res.status(200).send("No events");
      }

      for (const event of events) {
        if (event.type === "message" && event.message.type === "text") {
          const userText = event.message.text;

          const payload = {
            model: OPENAI_MODEL,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userText },
            ],
            temperature: 0.2,
          };

          const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify(payload),
          });

          const result = await response.json();

          if (!response.ok || !result.choices) {
            console.error("OpenAI API Error:", result);
            await replyMessage(event.replyToken, "번역에 실패했어요. 다시 시도해주세요.");
            continue;
          }

          const translated = result.choices[0].message?.content?.trim();
          if (!translated) {
            await replyMessage(event.replyToken, "번역 결과가 비어있어요.");
            continue;
          }

          await replyMessage(event.replyToken, translated);
        }
      }

      return res.status(200).send("OK");
    } catch (err) {
      console.error("Handler Error:", err);
      return res.status(500).send("Internal Server Error");
    }
  } else {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

// LINE Reply API
async function replyMessage(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = {
    replyToken: replyToken,
    messages: [{ type: "text", text }],
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error("LINE API Error:", await response.text());
    }
  } catch (err) {
    console.error("Reply Error:", err);
  }
}

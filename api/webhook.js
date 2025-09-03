import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (설명/잡담 금지)
 * - 항상 "친근한 존댓말"로 번역
 * - KR→TH: 태국어는 남성 친근 존댓말 (~ครับ 사용), "깨우" → "แก้ว"
 * - TH→KR: 한국어는 남성 친근 존댓말 (~요/~해요)
 * - 한국어 입력 시: 태국어 1줄 + GPT가 번역한 태국어를 다시 한국어 직역 1줄
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋㅋ/ㅎㅎ → 555/ฮ่าๆ 변환
 * - JSON 강제 출력 ( {"text":"..."} 형식만 )
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

Rules:
- Always translate only, no explanation, no commentary.
- KR→TH: Translate Korean into Thai (male speaker, polite/friendly tone ending with ครับ). 
- Replace "깨우" with "แก้ว".
- After the Thai line, add a second line in Korean explaining what you sent in Thai (literal back-translation).
- TH→KR: Translate Thai into Korean (male speaker, polite/friendly tone, ending ~요/~해요).
- Convert "ㅋㅋㅋ" or "ㅎㅎ" to "555" or "ฮ่าๆ".
- Output must ALWAYS be valid JSON in the format:
{"text":"...translation..."}
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const body = req.body;

  try {
    for (const event of body.events) {
      if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text;

        // OpenAI API 호출
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage },
            ],
            temperature: 0.2,
          }),
        });

        const data = await response.json();

        let translatedText = "번역에 실패했어요. 다시 시도해주세요.";

        if (data.choices && data.choices.length > 0) {
          try {
            // GPT 응답을 JSON으로 파싱
            const parsed = JSON.parse(data.choices[0].message.content);
            translatedText = parsed.text;
          } catch (err) {
            console.error("파싱 오류:", err, data.choices[0].message.content);
            translatedText = "번역 형식 파싱에 실패했어요. 다시 보내주세요.";
          }
        } else {
          console.error("OpenAI 응답 오류:", data);
        }

        // LINE Reply API 호출
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: translatedText }],
          }),
        });
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("에러 발생:", error);
    res.status(500).send("Internal Server Error");
  }
}

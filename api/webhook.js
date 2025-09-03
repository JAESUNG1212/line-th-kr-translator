import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (설명/잡담 X)
 * - 항상 "친근한 존댓말"로 번역
 * - KR→TH: 태국어는 남성 존댓말 톤(~ครับ 사용), "깨우" → "แก้ว", 한글 금지
 * - TH→KR: 한국어는 남성 친근 존댓말(~요/~해요)
 * - 한국어 입력 시: 태국어 1줄 + (GPT가 번역한 태국어를 한국어 직역 1줄)
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋ/ㅎㅎ = 555/ฮ่าๆ 변환
 * - JSON 강제 출력 {"text":"..."} (그 외 텍스트 금지)
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

RULES:
1. Output ONLY valid JSON in the format: {"text":"..."}.
2. No explanations, no commentary, no markdown.
3. Korean → Thai:
   - Translate into Thai using male polite tone (~ครับ).
   - Replace "깨우" with "แก้ว".
   - After Thai line, add one more line with Korean literal back-translation.
   - Example:
     {"text":"สวัสดีครับ\\n(안녕하세요)"}
4. Thai → Korean:
   - Translate into friendly polite Korean (~요/~해요).
   - Example:
     {"text":"밥 먹었어요?"}
5. Laughter:
   - ㅋㅋㅋ/ㅎㅎㅎ → 555/ฮ่าๆ
   - 555/ฮ่าๆ → ㅋㅋㅋ/ㅎㅎㅎ
6. ABSOLUTELY no text outside JSON.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const events = req.body.events;
    for (const event of events) {
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
            temperature: 0.3,
          }),
        });

        const data = await response.json();

        // OpenAI 응답 파싱 보정
        let raw = data.choices?.[0]?.message?.content?.trim() || "";
        let translatedText = "번역 형식 오류가 발생했어요.";

        try {
          // JSON 부분만 정규식으로 추출
          const match = raw.match(/{\s*"text"\s*:\s*".*"\s*}/s);
          if (match) {
            translatedText = JSON.parse(match[0]).text;
          }
        } catch (e) {
          console.error("JSON parse error:", e, raw);
        }

        // LINE Reply API
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
    console.error("Error:", error);
    res.status(500).send("Internal Server Error");
  }
}

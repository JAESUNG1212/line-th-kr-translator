import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (잡담/설명 금지)
 * - 항상 "친근한 존댓말"로 번역
 * - KR→TH: 태국어는 남성 친근 존댓말 톤(~ครับ), "깨우"→"แก้ว", 한글 금지
 * - TH→KR: 한국어는 남성 친근 존댓말 (~요/~해요)
 * - 한국어 입력 시: 태국어 + 직역 한국어 2줄
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋ/ㅎㅎ → 555/ฮ่าๆ
 * - JSON 강제 출력
 * - "ครับ" 자동 강제 덧붙이지 않고 모델이 판단
 */

// 환경변수로 모델/옵션 제어
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";  // ✅ 기본 gpt-4o
const BACKLITERAL = process.env.BACKLITERAL !== "off";       // 직역 줄 on/off (기본 on)

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

RULES:
1. Only translate. No explanations, no commentary.
2. Always output in JSON: { "result": "...translated text..." }
3. If input is Korean → output must be Thai translation (male, polite, friendly tone ~ครับ) 
   + if BACKLITERAL is on, also append Korean literal back-translation line.
   Format: "<Thai translation>\\n<literal Korean back-translation>"
4. If input is Thai → output must be Korean translation (male, polite, friendly tone ~요/~해요).
5. Replace "깨우" with "แก้ว".
6. Never include Hangul in Thai output.
7. Laughter: "ㅋㅋㅋ","ㅎㅎ" → "555" or "ฮ่าๆๆ".
8. Absolutely no additional text besides the translation.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;

    // LINE webhook 이벤트 처리
    if (body.events && body.events.length > 0) {
      const event = body.events[0];

      if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text;

        // OpenAI 번역 요청
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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

        let replyText = "번역에 실패했어요. 다시 시도해주세요.";
        if (data.choices && data.choices.length > 0) {
          try {
            const content = data.choices[0].message.content.trim();
            const json = JSON.parse(content);
            replyText = json.result;
          } catch (err) {
            replyText = "번역 형식 파싱에 실패했어요. 다시 보내주세요.";
          }
        }

        // LINE Reply API 호출
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: replyText }],
          }),
        });
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

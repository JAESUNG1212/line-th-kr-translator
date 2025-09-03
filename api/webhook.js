import fetch from "node-fetch";

/**
 * 안전모드 버전
 * - JSON 강제/파싱 제거 → OpenAI가 준 최종 텍스트 그대로 사용
 * - KR→TH: 첫 줄 태국어(남성 존댓말, “깨우”→“แก้ว”), 두 번째 줄 한국어 직역
 * - TH→KR: 한국어 친근 존댓말(~요/~해요) 1줄
 * - ㅋㅋ/ㅎㅎ ↔ 555/ฮ่าๆ 보정
 * - “설명/코드펜스/마크다운 금지, 결과는 최종 번역문만”을 강하게 요청
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
  3a) First line: Thai translation.
  3b) Second line: literal Korean back-translation in parentheses like (…).
- If the input is Thai:
  - Translate to Korean (friendly polite form ~요/~해요), single line only.
- Normalize laughter:
  - ㅋㅋ/ㅎㅎ -> 555/ฮ่าๆ in Thai
  - 555/ฮ่าๆ -> ㅋㅋ/ㅎㅎ in Korean
- AGAIN: Output ONLY the final lines as described. No extra words.
`;

function stripCodeFences(s) {
  if (!s) return "";
  // 코드펜스 제거
  return s.replace(/```[\s\S]*?```/g, (block) => {
    // 코드블럭 안에 텍스트만 남기되, 가끔 json/언어 지시어 제거
    return block.replace(/```[a-zA-Z]*\n?/, "").replace(/```$/, "");
  }).trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userMessage = event.message.text?.trim() || "";

      // OpenAI 호출 (JSON 모드 제거)
      const payload = {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 500,
      };

      const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await aiResp.json();
      if (DEBUG) {
        console.log("=== OpenAI raw ===");
        console.log(JSON.stringify(data, null, 2));
      }

      let raw = data?.choices?.[0]?.message?.content || "";
      let translatedText = stripCodeFences(raw).trim();

      // 혹시 모델이 또 설명문을 섞으면 길이가 과도하거나 "```" 포함 여부 체크
      if (!translatedText || translatedText.toLowerCase().includes("explain") || translatedText.includes("```")) {
        translatedText = translatedText
          .replace(/^[\s\S]*?(\S)/, "$1") // 앞쪽 설명성 문장 제거 시도
          .replace(/```[\s\S]*?```/g, "")
          .trim();
      }

      // 완전 비어있다면 실패 안내
      if (!translatedText) translatedText = "번역에 실패했어요. 다시 시도해 주세요.";

      // LINE Reply
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

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Internal Server Error");
  }
}

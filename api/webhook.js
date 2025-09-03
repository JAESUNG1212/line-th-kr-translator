import fetch from "node-fetch";

/**
 * 요구사항 요약
 * - 오직 번역만 (설명/잡담 금지)
 * - KR→TH: 남성 존댓말(~ครับ), "깨우"→"แก้ว", 첫 줄 태국어 / 두 번째 줄 한국어 직역
 * - TH→KR: 한국어 남성 친근 존댓말(~요/~해요)
 * - ㅋㅋ/ㅎㅎ ↔ 555/ฮ่าๆ 보정
 * - 결과는 무조건 {"text":"..."} 한 덩어리 JSON만
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 디버그용(원하면 Vercel 환경변수에 DEBUG=1 추가)
const DEBUG = process.env.DEBUG === "1";

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

OUTPUT FORMAT (MANDATORY):
- You MUST output ONLY a single valid JSON object: {"text":"..."} (no markdown, no explanations).
- Never wrap with code fences. No extra text.
- If Korean → Thai:
  1) Replace "깨우" with "แก้ว".
  2) Translate Korean to Thai (male polite tone, end with "ครับ").
  3) Then add a second line (same message) as a Korean literal back-translation.
  Example: {"text":"สวัสดีครับ\\n(안녕하세요)"}
- If Thai → Korean:
  - Translate into friendly/polite Korean (~요/~해요) and output in one line.
- Normalize laughter:
  - ㅋㅋㅋ/ㅎㅎㅎ → 555/ฮ่าๆ in Thai
  - 555/ฮ่าๆ → ㅋㅋㅋ/ㅎㅎㅎ in Korean
- ABSOLUTELY NO TEXT OUTSIDE JSON.
`;

/** OpenAI 응답에서 {"text":"..."}만 최대한 안전하게 뽑아내기 */
function extractTextStrict(raw) {
  if (!raw) return null;

  // 1) 코드펜스 제거 (```json ... ``` 등)
  raw = raw.replace(/```[\s\S]*?```/g, (block) => {
    // 코드펜스 안쪽에 JSON이 있으면 꺼냄
    const m = block.match(/{[\s\S]*}/);
    return m ? m[0] : "";
  }).trim();

  // 2) 그대로 파싱 시도
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.text === "string") {
      return obj.text;
    }
  } catch (_) {}

  // 3) 문서 내 첫 { 와 마지막 } 범위 추출 후 파싱
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = raw.slice(first, last + 1);
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj.text === "string") {
        return obj.text;
      }
    } catch (_) {}
  }

  // 4) "text":"..."" 패턴만이라도 잡기 (따옴표/개행 포함 넉넉히)
  const m = raw.match(/"text"\s*:\s*"([\s\S]*?)"/);
  if (m && m[1] != null) {
    // JSON 문자열 언이스케이프
    let s = m[1];
    s = s.replace(/\\"/g, '"')
         .replace(/\\\\/g, "\\")
         .replace(/\\n/g, "\n")
         .replace(/\\t/g, "\t");
    return s;
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userMessage = event.message.text;

      // OpenAI 호출
      const payload = {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        // JSON 모드(지원 모델에서 강제 구조화)
        response_format: { type: "json_object" },
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

      let raw = data?.choices?.[0]?.message?.content?.trim() || "";
      let translatedText = extractTextStrict(raw);

      if (!translatedText) {
        if (DEBUG) console.log("Parse failed raw:", raw);
        translatedText = "번역 형식 오류가 발생했어요.";
      }

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

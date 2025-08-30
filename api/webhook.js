// Vercel 서버리스 함수: /api/webhook 로 배포됨
import fetch from "node-fetch";

// 간단한 태국어 문자 범위 체크 (있으면 태국어라고 가정)
const hasThai = (t = "") => /[\u0E00-\u0E7F]/.test(t);

// 번역 프롬프트 (재성님 규칙 반영)
const SYSTEM_PROMPT = `
You are a bilingual translator for a Korean man and his Thai girlfriend chatting on LINE.
Rules:
1) Detect language automatically. If input is Korean, translate to Thai in a friendly polite tone for a girlfriend (ผม ... ครับ / ค่ะ handling naturally). Do NOT include any Hangul in Thai output.
2) If input is Thai, translate to natural Korean (남성, 친근한 존댓말).
3) Keep emojis and laughter: "ㅋㅋ/ㅎㅎ/하하" -> "555/ฮ่าๆ", and vice versa.
4) Keep it conversational and concise; no extra explanations. Return ONLY the translated text.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK"); // LINE health checks

  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  const events = req.body?.events || [];

  // 각 이벤트 처리
  for (const event of events) {
    try {
      // 텍스트만 처리
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userText = event.message.text || "";
      const sourceType = event.source?.type; // "user" | "group" | "room"

      // (선택) 명령어: /raw 는 번역 없이 그대로 에코 (디버그용)
      if (userText.startsWith("/raw ")) {
        await reply(event.replyToken, userText.slice(5), LINE_TOKEN);
        continue;
      }

      // GPT 번역 호출
      const translated = await translateWithGPT(userText, OPENAI_API_KEY);

      // 그룹/룸/1:1 어디서든 같은 방으로 답장
      await reply(event.replyToken, translated, LINE_TOKEN);

      // (선택) 한국어 입력인데 너무 긴 경우 잘라주기 등 처리 가능
    } catch (e) {
      console.error("Event error:", e);
      // LINE은 200응답만 받으면 재시도 안 하니, 개별 에러는 무시하고 다음으로
    }
  }

  return res.status(200).send("OK");
}

async function translateWithGPT(text, OPENAI_API_KEY) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT.trim() },
        { role: "user", content: text }
      ],
      temperature: 0.4,
      max_tokens: 512
    })
  }).then(r => r.json());

  const out = r?.choices?.[0]?.message?.content?.trim();
  return out?.slice(0, 1900) || "번역에 실패했어요. 조금만 줄여서 다시 보내주세요.";
}

async function reply(replyToken, text, LINE_TOKEN) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}

import fetch from "node-fetch";

// 입력이 한국어일 때: 태국어 번역 + 한국어 직역(백번역)을 같이 보내고,
// 입력이 태국어일 때: 한국어 번역만 보냅니다.
// '깨우'는 반드시 'แก้ว'로 번역, 남성 존댓말 톤, 웃음치환 포함.

const SYSTEM_PROMPT = `
You are a bilingual translator for a Korean man and his Thai girlfriend on LINE.

Global style & rules:
- Male polite tone (ครับ) in Thai outputs when translating from Korean.
- Natural friendly polite tone in Korean outputs when translating from Thai.
- If the Korean input contains the name "깨우", always translate it as "แก้ว" in Thai.
- Laughter mapping: ㅋㅋ / ㅎㅎ / 하하 <-> 555 / ฮ่าๆ
- Do not add explanations.

Output format:
- If the INPUT is Korean (KR→TH):
  Return STRICT JSON (no code fences, no extra text):
  {
    "mode": "KR→TH",
    "th": "<Thai translation only, no Hangul, male polite tone>",
    "ko_backliteral": "<literal back-translation to Korean of your Thai output>"
  }
- If the INPUT is Thai (TH→KR):
  Return STRICT JSON:
  {
    "mode": "TH→KR",
    "ko": "<natural Korean translation in friendly polite male tone>"
  }
Ensure valid JSON. Do not include any additional keys or commentary.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  const events = req.body?.events || [];

  for (const event of events) {
    try {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userText = event.message.text ?? "";

      // 1) GPT에게 번역 + 구조화(JSON) 요청
      const gpt = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: SYSTEM_PROMPT.trim() },
            { role: "user", content: userText },
          ],
        }),
      }).then((r) => r.json());

      const raw = gpt?.choices?.[0]?.message?.content?.trim() || "";
      const data = safeParseJSON(raw);

      // 2) LINE으로 응답 구성
      let messages = [];
      if (data && data.mode === "KR→TH" && typeof data.th === "string") {
        // 첫 줄: 태국어 번역
        messages.push({ type: "text", text: data.th.slice(0, 1900) });
        // 둘째 줄: 한국어 직역(백번역)
        if (typeof data.ko_backliteral === "string" && data.ko_backliteral.length) {
          messages.push({ type: "text", text: `(직역) ${data.ko_backliteral.slice(0, 1900)}` });
        }
      } else if (data && data.mode === "TH→KR" && typeof data.ko === "string") {
        messages.push({ type: "text", text: data.ko.slice(0, 1900) });
      } else {
        // 파싱 실패 시 대비: 원문 그대로 에코 (디버그용)
        messages.push({ type: "text", text: "번역 형식 파싱에 실패했어요. 다시 한번 보내주세요." });
      }

      // 3) 답장 보내기
      await replyToLine(event.replyToken, messages, LINE_TOKEN);

    } catch (e) {
      console.error("Event error:", e);
      // 에러가 있어도 200 반환(라인 재시도 방지)
    }
  }

  return res.status(200).send("OK");
}

function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function replyToLine(replyToken, messages, LINE_TOKEN) {
  // LINE은 한 번에 최대 5개 메시지까지 허용
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });
}

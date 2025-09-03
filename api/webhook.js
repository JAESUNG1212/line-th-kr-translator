import fetch from "node-fetch";

/**
 * 요구사항
 * - 무조건 번역만 (GPT가 대답/잡담 절대 금지)
 * - 한국어 입력 → 태국어(남성 존댓말, "깨우"= "แก้ว") + 한국어 직역 2줄
 * - 태국어 입력 → 한국어(남성 존댓말) 1줄
 * - ㅋㅋ/ㅎㅎ/하하 ↔ 555/ฮ่าๆ 치환
 */

const SYSTEM_PROMPT = `
You are a pure translation engine for a Korean man and his Thai girlfriend on LINE.

Important:
- NEVER chat, answer, or add comments.
- ONLY translate messages exactly as instructed.
- NO greetings, NO explanations, NO extra text.

Translation rules:
- Korean → Thai:
  • Output Thai in friendly polite male tone (ครับ).
  • If input contains "깨우", always translate as "แก้ว".
  • Do NOT include Hangul in Thai output.
  • Also provide a literal back-translation of your Thai sentence into Korean.
- Thai → Korean:
  • Output natural Korean in friendly polite male tone.
- Laughter mapping:
  • ㅋㅋ / ㅎㅎ / 하하 ↔ 555 / ฮ่าๆ

Format strictly:
- If input is Korean:
  {
    "mode": "KR→TH",
    "th": "<THAI translation only>",
    "ko_backliteral": "<literal Korean back-translation>"
  }
- If input is Thai:
  {
    "mode": "TH→KR",
    "ko": "<Korean translation>"
  }
`;

const REQ_HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

const MAX_LEN = 1900;
const hasHangul = (s = "") => /[가-힣]/.test(s);
const hasThai = (s = "") => /[\u0E00-\u0E7F]/.test(s);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  const events = req.body?.events || [];

  for (const ev of events) {
    try {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      const userText = (ev.message.text || "").trim();

      // 1) GPT 호출
      const jsonResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: REQ_HEADERS(OPENAI_API_KEY),
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: SYSTEM_PROMPT.trim() },
            { role: "user", content: userText },
          ],
        }),
      }).then((r) => r.json());

      const raw = jsonResp?.choices?.[0]?.message?.content?.trim() || "";
      const data = safeParseJSON(raw);

      let messages = [];

      if (data && data.mode === "KR→TH" && typeof data.th === "string") {
        // 한국어 → 태국어 + 직역
        const th = enforceThaiRules(data.th, userText).slice(0, MAX_LEN);
        messages.push({ type: "text", text: th });

        if (typeof data.ko_backliteral === "string" && data.ko_backliteral.length) {
          messages.push({
            type: "text",
            text: `(직역) ${data.ko_backliteral.slice(0, MAX_LEN)}`,
          });
        }
      } else if (data && data.mode === "TH→KR" && typeof data.ko === "string") {
        // 태국어 → 한국어
        messages.push({ type: "text", text: data.ko.slice(0, MAX_LEN) });
      } else {
        // JSON 실패 시 폴백
        const fallback = await fallbackTranslate(userText, OPENAI_API_KEY);
        messages = fallback.length ? fallback : [{ type: "text", text: "번역 실패. 다시 시도해주세요." }];
      }

      await replyToLine(ev.replyToken, messages, LINE_TOKEN);
    } catch (e) {
      console.error("Event error:", e);
    }
  }

  return res.status(200).send("OK");
}

/** JSON 파서 */
function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** JSON 실패 시 폴백 번역 */
async function fallbackTranslate(text, OPENAI_API_KEY) {
  const isKR = hasHangul(text);

  const sys =
    isKR
      ? `Translate to Thai (male polite tone, use "ครับ"; replace "깨우" with "แก้ว"; no Hangul). Then provide literal Korean back-translation on next line prefixed with "(직역) ". Output exactly 2 lines.`
      : `Translate Thai to Korean (friendly polite male tone). Output 1 line only.`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: REQ_HEADERS(OPENAI_API_KEY),
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text },
      ],
    }),
  }).then((x) => x.json());

  const out = r?.choices?.[0]?.message?.content?.trim() || "";
  if (!out) return [];

  if (isKR) {
    const parts = out.split("\n").map((s) => s.trim()).filter(Boolean);
    const msgs = [];
    if (parts[0]) msgs.push({ type: "text", text: parts[0].slice(0, MAX_LEN) });
    if (parts[1]) msgs.push({ type: "text", text: parts[1].startsWith("(직역)") ? parts[1] : `(직역) ${parts[1]}` });
    return msgs;
  } else {
    return [{ type: "text", text: out.slice(0, MAX_LEN) }];
  }
}

/** 태국어 출력 보정 */
function enforceThaiRules(thaiOut = "", originalKR = "") {
  let s = thaiOut;

  // 깨우 → แก้ว
  if (originalKR.includes("깨우") && !s.includes("แก้ว")) {
    s = s.replace(/เกอู|แกอู|Kaeu|Kaeo|Gaeu|Gaeo/gi, "แก้ว");
    if (!s.includes("แก้ว")) s = "แก้ว " + s;
  }

  // 한글 제거
  s = s.replace(/[가-힣]/g, "");

  // 웃음 보정
  s = s.replace(/ㅋㅋ+|ㅎㅎ+|하하+/g, "555");

  // 문장 끝에 ครับ 없으면 보강
  if (!/ครับ[\s.!?…]*$/.test(s) && s.trim().length > 0) {
    s = s + " ครับ";
  }

  return s.trim();
}

/** LINE reply */
async function replyToLine(replyToken, messages, LINE_TOKEN) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

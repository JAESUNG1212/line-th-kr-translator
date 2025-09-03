import fetch from "node-fetch";

/**
 * 요구사항
 * - 한국어 입력 → 태국어(남성 존댓말, "깨우"는 항상 "แก้ว") + 한국어 직역(백번역) 2줄로 답장
 * - 태국어 입력 → 한국어(남성 친절 존댓말) 1줄로 답장
 * - ㅋㅋ/ㅎㅎ/하하 ↔ 555/ฮ่าๆ 치환
 * - 출력은 먼저 JSON을 강제해서 파싱하고, 실패 시 안전한 폴백 수행
 */

const SYSTEM_PROMPT = `
You are a bilingual translator for a Korean man and his Thai girlfriend on LINE.

Global rules:
- Korean → Thai: Output Thai in friendly polite *male* tone (use ครับ naturally). Never include Hangul in Thai output.
- If the Korean input contains the name "깨우", always translate it as "แก้ว".
- Also provide a literal back-translation of your Thai sentence into Korean (to show exactly how it was phrased).
- Thai → Korean: Output natural Korean in friendly polite *male* tone.
- Laughter mapping: ㅋㅋ / ㅎㅎ / 하하 ↔ 555 / ฮ่าๆ
- IMPORTANT: Always respond in VALID JSON only. No code fences, no extra commentary.

Format strictly:
- If input is Korean:
  {
    "mode": "KR→TH",
    "th": "<THAI translation only>",
    "ko_backliteral": "<literal Korean back-translation of that Thai>"
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

      // 1) 1차: JSON 강제 프롬프트로 요청
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
        // 한국어 → 태국어(+직역)
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
        // 2) 폴백: JSON 파싱 실패 시 간단 프롬프트로 재시도
        const fallback = await fallbackTranslate(userText, OPENAI_API_KEY);
        messages = fallback.length ? fallback : [{ type: "text", text: "번역에 실패했어요. 다시 시도해 주세요." }];
      }

      await replyToLine(ev.replyToken, messages, LINE_TOKEN);
    } catch (e) {
      console.error("Event error:", e);
      // 에러가 있어도 LINE 재시도 방지 위해 200
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

/** 폴백 번역: JSON 실패 시 간단히 1~2줄이라도 보장 */
async function fallbackTranslate(text, OPENAI_API_KEY) {
  // ㅋㅋ/ㅎㅎ/하하 ↔ 555/ฮ่าๆ 치환은 모델에 맡기지 않고 부분 치환도 고려 가능하나,
  // 여기서는 프롬프트로 유도.
  const isKR = hasHangul(text);

  const sys =
    isKR
      ? `Translate to Thai (male polite tone, use "ครับ"; replace name "깨우" with "แก้ว"; no Hangul). Then provide a literal Korean back-translation on the next line prefixed with "(직역) ". Keep laughter mapping ㅋㅋ/ㅎㅎ/하하 ↔ 555/ฮ่าๆ. Output exactly two lines.`
      : `Translate Thai to Korean (friendly polite male tone). Keep laughter mapping 555/ฮ่าๆ ↔ ㅋㅋ/ㅎㅎ/하하. Output one line only.`;

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

  // 폴백은 라인 메시지 1~2개로 분할
  if (isKR) {
    const parts = out.split("\n").map((s) => s.trim()).filter(Boolean);
    const first = (parts[0] || "").slice(0, MAX_LEN);
    const second = (parts[1] || "").slice(0, MAX_LEN);
    const msgs = [];
    if (first) msgs.push({ type: "text", text: first });
    if (second) msgs.push({ type: "text", text: second.startsWith("(직역)") ? second : `(직역) ${second}` });
    return msgs;
  } else {
    return [{ type: "text", text: out.slice(0, MAX_LEN) }];
  }
}

/** 태국어 출력에 규칙 강제(깨우→แก้ว 등 추가 보강) */
function enforceThaiRules(thaiOut = "", originalKR = "") {
  let s = thaiOut;

  // "깨우"가 원문에 있으면 태국어 쪽엔 반드시 "แก้ว"가 있어야 함
  if (originalKR.includes("깨우") && !s.includes("แก้ว")) {
    // 간단 치환: 한국어 이름 그대로가 섞였거나 누락된 경우 앞에 애칭 보강
    s = s.replace(/เกอู|แกอู|Kaeu|Kaeo|Gaeu|Gaeo/gi, "แก้ว");
    if (!s.includes("แก้ว")) s = s.replace(/(^|\s)(คุณ|เธอ)(\s|$)/, "$1แก้ว$3");
  }

  // 한글이 실수로 섞였으면 제거
  s = s.replace(/[가-힣]/g, "");

  // 웃음 치환은 모델이 해주지만 혹시 섞이면 간단 보정
  s = s.replace(/ㅋㅋ+|ㅎㅎ+|하하+/g, "555");

  // 남성 존댓말 끝맺음이 없으면 가볍게 보강(너무 과한 수정은 피함)
  // 문장 끝에 ครับ 이 전혀 없다면 한 번 정도 덧붙임
  if (!/ครับ[\s.!?…]*$/.test(s) && !s.includes("ค่ะ") && s.trim().length > 0) {
    s = s.replace(/([^\s])\s*$/, "$1 ครับ");
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

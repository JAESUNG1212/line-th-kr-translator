import fetch from "node-fetch";

/**
 * 요구사항 (최종)
 * - 오직 번역만 (잡담/설명 금지)
 * - 항상 "친근한 존댓말"로 번역
 *   • KR→TH: 태국어는 남성 공손체 톤(자연스러울 때 ครับ 사용), "깨우"→"แก้ว", 한글 금지
 *   • TH→KR: 한국어는 남성 친근 존댓말(~요/~해요)
 * - 한국어 입력 시: ①태국어 ②(직역) 한국어 2줄
 * - 태국어 입력 시: 한국어 1줄
 * - ㅋㅋ/ㅎㅎ/하하 ↔ 555/ฮ่าๆ
 * - JSON 강제 + 폴백
 * - 'ครับ' 자동 강제 덧붙이기 없음 (모델 판단)
 */

// 환경변수로 모델/옵션 제어
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";   // ← 기본 gpt-5
const BACKLITERAL = process.env.BACKLITERAL !== "off";       // 직역 줄 on/off (기본 on)

const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.

You MUST NEVER chat, greet, add commentary, or explain. ONLY translate as instructed.

Global style (apply ALWAYS):
- Output must be natural, smooth, and idiomatic while preserving meaning.
- Thai outputs: friendly male polite tone (use "ครับ" naturally when appropriate; not overly stiff).
- Korean outputs: friendly male polite tone (~요/~해요), not awkward or literal-sounding.

Conversion rules:
- Korean → Thai (KR→TH):
  • Output THAI ONLY (NO Hangul).
  • If input contains "깨우", ALWAYS translate that name as "แก้ว".
  • ALSO provide a literal back-translation of your THAI output into Korean, in friendly polite style.
- Thai → Korean (TH→KR):
  • Output natural Korean in friendly male polite tone (~요/~해요).

Laughter mapping:
- ㅋㅋ / ㅎㅎ / 하하 ↔ 555 / ฮ่าๆ

STRICTLY return VALID JSON ONLY (no code fences, no extra text):
- If input is Korean:
  {"mode":"KR→TH","th":"<THAI only, friendly male polite tone, no Hangul>","ko_backliteral":"<literal Korean in friendly polite tone>"}
- If input is Thai:
  {"mode":"TH→KR","ko":"<Korean translation in friendly polite tone>"}

Forbidden:
- Do NOT include Hangul in the "th" value.
- Do NOT output anything other than the JSON objects above.
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

      // 1) JSON 강제 호출 (GPT-5)
      const jsonResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: REQ_HEADERS(OPENAI_API_KEY),
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0.5, // 자연스러움 소폭↑
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
        // KR→TH: 1) 태국어, 2) (직역) 한국어(옵션)
        const thClean = enforceThaiRules(data.th, userText).slice(0, MAX_LEN);
        messages.push({ type: "text", text: thClean });

        const back = (data.ko_backliteral || "").trim();
        if (BACKLITERAL && back) messages.push({ type: "text", text: `(직역) ${back.slice(0, MAX_LEN)}` });

      } else if (data && data.mode === "TH→KR" && typeof data.ko === "string") {
        // TH→KR: 한국어 1줄
        messages.push({ type: "text", text: data.ko.slice(0, MAX_LEN) });

      } else {
        // 2) 폴백: JSON 실패 시 강제 1~2줄 형식으로 재요청
        const fb = await fallbackTranslate(userText, OPENAI_API_KEY);
        messages = fb.length ? fb : [{ type: "text", text: "번역에 실패했어요. 다시 시도해 주세요." }];
      }

      await replyToLine(ev.replyToken, messages, LINE_TOKEN);
    } catch (e) {
      console.error("Event error:", e);
    }
  }

  return res.status(200).send("OK");
}

/* ---------- Helpers ---------- */

function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function fallbackTranslate(text, OPENAI_API_KEY) {
  const isKR = hasHangul(text);

  const sys = isKR
    ? `You output EXACTLY two lines:\n1) THAI ONLY (no Hangul; friendly male polite tone; map ㅋㅋ/ㅎㅎ/하하→555/ฮ่าๆ; replace "깨우"→"แก้ว")\n2) "(직역) " + literal Korean back-translation of line 1 in friendly polite tone. No other text.`
    : `Translate Thai to Korean in a friendly male polite tone (~요/~해요). Output EXACTLY one line. Map 555/ฮ่าๆ→ㅋㅋ/ㅎㅎ/하하. No extra text.`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: REQ_HEADERS(OPENAI_API_KEY),
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.5,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text },
      ],
    }),
  }).then((x) => x.json());

  const out = r?.choices?.[0]?.message?.content?.trim() || "";
  if (!out) return [];

  if (isKR) {
    const [line1, line2] = out.split("\n").map((s) => s.trim()).filter(Boolean);
    // 1줄: 태국어 (한글 제거 보정)
    const th = enforceThaiRules(line1 || "", text).slice(0, MAX_LEN);
    const msgs = [{ type: "text", text: th }];
    // 2줄: (직역) 한국어 (옵션)
    if (BACKLITERAL && line2) {
      msgs.push({ type: "text", text: line2.startsWith("(직역)") ? line2.slice(0, MAX_LEN) : `(직역) ${line2}`.slice(0, MAX_LEN) });
    }
    return msgs;
  } else {
    return [{ type: "text", text: out.slice(0, MAX_LEN) }];
  }
}

/**
 * 태국어 출력 보정
 * - "깨우"가 원문에 있으면 반드시 "แก้ว" 포함
 * - 태국어 줄에 한글 섞이면 제거
 * - 웃음 보정
 * - 'ครับ'는 자동 강제하지 않음(모델 판단)
 */
function enforceThaiRules(thaiOut = "", originalKR = "") {
  let s = thaiOut;

  // 깨우 → แก้ว (혹시 다른 표기 치환)
  if (originalKR.includes("깨우") && !s.includes("แก้ว")) {
    s = s.replace(/เกอู|แกอู|Kaeu|Kaeo|Gaeu|Gaeo/gi, "แก้ว");
    if (!s.includes("แก้ว")) s = "แก้ว " + s;
  }

  // 태국어 라인에 한글 섞이면 제거
  s = s.replace(/[가-힣]/g, "");

  // 웃음 보정
  s = s.replace(/ㅋㅋ+|ㅎㅎ+|하하+/g, "555");

  return s.trim();
}

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

// api/webhook.js
// 번역 전용 LINE Webhook (KR↔TH)
// - 오직 번역만: 챗봇 대화/설명 금지
// - 항상 "친근한 존댓말" 톤 유지
// - KR→TH: 태국어는 남성 공손체(ครับ), 여자친구 호칭은 “แก้ว” 사용 (한글 입력에 “깨우” 등 오타를 넣어도 “แก้ว”로 통일)
// - TH→KR: 자연스러운 한국어 존댓말(~요/~해요)
// - 한국어 입력 시: KR→TH + (옵션) 직역 한국어 줄
// - 태국어 입력 시: TH→KR 1줄
// - ㅋㅋ/ㅎㅎ/555/ฮ่า 등의 감탄/웃음은 자연스럽게 처리 (과도한 반복 제거)
// - JSON 파싱/형식 오류, 화살표(-> vs →) 등도 최대한 자동 보정
// - 장문/이모지도 안전 처리
// - 모델 실패시 안전 폴백 번역

import fetch from "node-fetch";

// ====== 환경변수 ======
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5"; // 기본 gpt-5
const BACKLITERAL = process.env.BACKLITERAL !== "off";     // (직역 줄) 기본 on

// ====== 상수 ======
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const MAX_LEN = 1000; // 너무 긴 텍스트 안전 컷

// ====== 유틸 ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasHangul(s) {
  return /[가-힣]/.test(s);
}
function hasThai(s) {
  return /[\u0E00-\u0E7F]/.test(s);
}

// 태국어 특수 문자/중복 웃음 정리
function cleanThaiLaugh(text) {
  let t = text || "";
  // 555, ฮ่า, 5555555 -> 555 / ฮ่า
  t = t.replace(/5{3,}/g, "555").replace(/ฮ่า{2,}/g, "ฮ่า");
  return t;
}

// “깨우/깨어/깨유/แก้ว/ฯฯ” 등 -> “แก้ว” 통일 (한국어 입력일 때 문맥상 이름 치환)
function unifyKaew(text) {
  if (!text) return text;
  // 흔한 한글/영문 표기 → 태국어 “แก้ว”
  return text
    .replace(/깨우|깨유|깨오|깨요|개우|게우|kaew|kæw/gi, "แก้ว");
}

// 모델이 JSON 아니고 코드펜스로 감싸거나 따옴표/화살표가 섞여도 파싱 시도
function safeParseJSON(s) {
  if (!s) return null;
  let t = s.trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "");

  // 스마트따옴표 → 표준
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // 화살표 통일 -> / → 로
  t = t.replace(/-\>/g, "→");

  // JSON 본문만 추출
  const m = t.match(/\{[\s\S]*\}$/m);
  if (m) t = m[0];

  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function clip(s) {
  if (!s) return "";
  s = s.trim();
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN);
  return s;
}

// ====== 시스템 프롬프트 ======
const SYSTEM_PROMPT = `
You are a STRICT translation engine for a Korean man and his Thai girlfriend on LINE.
You MUST NEVER chat, greet, comment, or explain. ONLY translate as instructed.

Output JSON ONLY (no code fence, no extra words), using one of two schemas:

1) When input is KOREAN (KR→TH), return:
{
  "mode": "KR→TH",
  "th": "<Thai translation as a friendly, polite MALE tone with 'ครับ'. Use girlfriend name 'แก้ว' when '깨우/kaew' etc. appear>",
  "ko_backliteral": "<literal Korean back-translation for checking>"
}

2) When input is THAI (TH→KR), return:
{
  "mode": "TH→KR",
  "ko": "<Natural Korean polite tone (~요/~해요). If 'แก้ว' is used, keep name as '깨우' in Korean.>"
}

Rules:
- Keep tone “friendly & polite”. No slang or rude terms.
- Remove excessive repeated laughs: 555555 → 555; ฮ่าฮ่าฮ่า → ฮ่า.
- KR→TH: Always masculine polite Thai ending “ครับ”.
- Normalize girlfriend name: any '깨우/kaew' variants → 'แก้ว' in Thai.
- TH→KR: Natural Korean polite tone. Don't add honorifics that sound awkward.
- ONLY JSON. No code-blocks, no comments, no keys other than shown.
`;

// ====== OpenAI 호출 ======
async function askOpenAI(messages, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.4,
        messages,
      }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e?.message || "abort" };
  } finally {
    clearTimeout(id);
  }
}

// ====== 폴백 번역 (평문 지시) ======
async function fallbackTranslate(src) {
  // 아주 단순 지시: plain text 1줄
  const isKR = hasHangul(src);
  const isTH = hasThai(src);
  const prompt = isKR
    ? `Translate to Thai in friendly polite MALE tone with "ครับ". Keep girlfriend name as "แก้ว". Text: ${src}`
    : `Translate to Korean in natural polite tone (~요/~해요). Keep "แก้ว" as "깨우". Text: ${src}`;

  const { ok, json } = await askOpenAI([
    { role: "system", content: "You are a concise translator. Output plain sentence only. No commentary."},
    { role: "user", content: prompt }
  ], { timeoutMs: 12000 });

  if (!ok || !json) return null;

  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) return null;

  if (isKR) {
    const th = cleanThaiLaugh(unifyKaew(text)) + (text.endsWith("ครับ") ? "" : " ครับ");
    const arr = [{ type: "text", text: clip(th) }];
    if (BACKLITERAL) arr.push({ type: "text", text: "(직역) 폴백 번역" });
    return arr;
  } else if (isTH) {
    return [{ type: "text", text: clip(text) }];
  }
  return null;
}

// ====== LINE Reply ======
async function lineReply(replyToken, messages) {
  return fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// ====== 메인 핸들러 ======
export default async function handler(req, res) {
  // LINE webhook는 POST만 수신
  if (req.method !== "POST") {
    res.status(200).json({ ok: true }); // 핑/검증 시 200
    return;
  }

  try {
    const body = req.body;

    // LINE webhook 구조
    const events = body?.events || [];
    if (!events.length) {
      res.status(200).json({ ok: true });
      return;
    }

    // 여러 이벤트가 올 수 있으나, 일반적으로 1건 처리
    for (const ev of events) {
      const replyToken = ev.replyToken;
      const msgType = ev.message?.type;
      const userText = ev.message?.text?.trim();

      if (!replyToken || msgType !== "text" || !userText) {
        // 텍스트 외에는 무시
        continue;
      }

      const inputIsKR = hasHangul(userText);
      const inputIsTH = hasThai(userText);

      // OpenAI에게 엄격 JSON 포맷 요구
      const { ok, json, status } = await askOpenAI([
        { role: "system", content: SYSTEM_PROMPT.trim() },
        { role: "user", content: userText }
      ], { timeoutMs: 18000 });

      let messages = [];

      if (ok && json) {
        const raw = json?.choices?.[0]?.message?.content?.trim() || "";
        const data = safeParseJSON(raw);

        // mode 유연 처리 (-> 를 →로 교체, 소문자 비교)
        const modeNorm = (data?.mode || "").toLowerCase().replace(/-\>/g, "→");

        // KR→TH 판단
        const looksKR2TH =
          (modeNorm.includes("kr") && modeNorm.includes("th") && modeNorm.includes("kr→th")) ||
          (inputIsKR && typeof data?.th === "string");

        // TH→KR 판단
        const looksTH2KR =
          (modeNorm.includes("th") && modeNorm.includes("kr") && modeNorm.includes("th→kr")) ||
          (inputIsTH && typeof data?.ko === "string");

        if (data && looksKR2TH && typeof data.th === "string") {
          let th = data.th;
          th = unifyKaew(th);
          th = cleanThaiLaugh(th);
          if (!/ครับ[.!?]?$/.test(th)) th = th.replace(/\s+$/,"") + " ครับ";
          messages.push({ type: "text", text: clip(th) });

          const back = (data.ko_backliteral || "").trim();
          if (BACKLITERAL && back) {
            messages.push({ type: "text", text: `(직역) ${clip(back)}` });
          }
        } else if (data && looksTH2KR && typeof data.ko === "string") {
          messages.push({ type: "text", text: clip(data.ko) });
        } else {
          // JSON 못 읽거나 미스매치 → 폴백
          const fb = await fallbackTranslate(userText);
          if (fb && fb.length) messages = fb;
        }
      }

      if (!messages.length) {
        // 그래도 없으면 마지막 가드
        messages = [{ type: "text", text: "번역에 실패했어요. 다시 시도해 주세요." }];
      }

      await lineReply(replyToken, messages);
      // 과도한 호출 방지
      await sleep(50);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    // 최종 가드
    res.status(200).json({ ok: true });
  }
}

// server.js (ESM)

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ✅ Cheerio (ESM): no default export
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// ===============================
// Health
// ===============================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ===============================
// Helpers
// ===============================
function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeLevel(level) {
  const lvl = String(level || "B2").toUpperCase().trim();
  const allowed = new Set(["A1", "A2", "B1", "B2", "C1"]);
  return allowed.has(lvl) ? lvl : "B2";
}

function levelSpec(lvl) {
  switch (lvl) {
    case "A1":
      return `
Use very simple words and short sentences (5–8 words).
Speak slowly. Use present tense mostly.
Ask ONE question at a time.
Avoid idioms, slang, and phrasal verbs.
Give only minimal correction if needed (1 short fix).
`.trim();
    case "A2":
      return `
Use simple vocabulary and short sentences (8–12 words).
Use present and past simple.
Ask ONE clear follow-up question.
Give gentle corrections with a short example.
Avoid complex idioms and advanced phrasal verbs.
`.trim();
    case "B1":
      return `
Use everyday vocabulary and natural short paragraphs.
Use present/past/future. Some common phrasal verbs are OK.
Ask follow-up questions and encourage longer answers.
Correct gently and explain briefly (1–2 lines).
`.trim();
    case "B2":
      return `
Speak naturally and clearly with varied sentence structures.
Use common idioms occasionally (not too many).
Ask deeper follow-up questions and challenge the user a bit.
Correct gently and give a better alternative phrasing.
`.trim();
    case "C1":
      return `
Speak fluently with advanced vocabulary and nuanced phrasing.
Use idioms and collocations naturally.
Ask analytical questions, request justification and examples.
Provide precise corrections and style improvements (concise).
`.trim();
    default:
      return `
Speak naturally and clearly at B2 level.
Ask follow-up questions.
Correct gently when needed.
`.trim();
  }
}

// ✅ Basic SSRF protection: allow only TED-Ed host
function isAllowedTedEdUrl(url) {
  try {
    const u = new URL(url);
    // Allow only https and TED-Ed domain
    if (u.protocol !== "https:") return false;
    return u.hostname === "ed.ted.com";
  } catch {
    return false;
  }
}

// ✅ Fetch with timeout (Node 18+ has AbortController)
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Helps some sites return full HTML
        "User-Agent":
          "Mozilla/5.0 (compatible; EnglishFlowBot/1.0; +https://englishflow-ai.onrender.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ✅ Extract TED-Ed context (title + description + canonical + keywords if available)
async function extractTedEdContext(tedUrl) {
  if (!tedUrl || !isAllowedTedEdUrl(tedUrl)) {
    return null;
  }

  const res = await fetchWithTimeout(tedUrl, 8000);
  if (!res.ok) return null;

  const html = await res.text();
  const $ = cheerio.load(html);

  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").text() ||
    "";

  const description =
    $("meta[property='og:description']").attr("content") ||
    $("meta[name='description']").attr("content") ||
    $("meta[name='twitter:description']").attr("content") ||
    "";

  const canonical =
    $("link[rel='canonical']").attr("href") ||
    $("meta[property='og:url']").attr("content") ||
    tedUrl;

  // TED-Ed sometimes has keywords; optional
  const keywords = $("meta[name='keywords']").attr("content") || "";

  return {
    title: String(title || "").trim(),
    description: String(description || "").trim(),
    canonical: String(canonical || "").trim(),
    keywords: String(keywords || "").trim(),
  };
}

// ===============================
// Step 2/4/9: Writing feedback
// ===============================
app.post("/ai/writing-feedback", async (req, res) => {
  try {
    const { text, level = "B2", stepName = "Writing" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'text'." });
    }

    const lvl = normalizeLevel(level);

    const system = `You are an English tutor. Level: ${lvl}.
Return ONLY valid JSON with keys:
corrected_text (string),
key_issues (array of strings),
rewrite_suggestions (array of strings),
quick_tips (array of strings).`;

    const user = `Step: ${stepName}
Student text:
${text}

Return the JSON now.`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const content = completion.choices?.[0]?.message?.content?.trim() || "";
    const json = parseJsonSafely(content);

    if (!json) {
      return res.status(502).json({
        error: "Model did not return valid JSON.",
        raw: content,
      });
    }

    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// ===============================
// Step 6: Vocabulary (+ native translations)
// ===============================
app.post("/ai/vocabulary", async (req, res) => {
  try {
    const {
      words,
      level = "B2",
      // ✅ preferred: one language selected in Home (e.g. "pt-BR", "es", "de")
      nativeLanguageCode,
      // ✅ optional: allow multiple languages if you ever want
      nativeLanguageCodes,
    } = req.body || {};

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ error: "Missing or invalid 'words' array." });
    }

    const cleanWords = words
      .map((w) => String(w || "").trim())
      .filter(Boolean);

    if (cleanWords.length === 0) {
      return res.status(400).json({ error: "Missing or invalid 'words' array." });
    }

    const lvl = normalizeLevel(level);

    // ✅ Decide which native languages to return translations for
    let langs = [];
    if (Array.isArray(nativeLanguageCodes) && nativeLanguageCodes.length > 0) {
      langs = nativeLanguageCodes.map((c) => String(c || "").trim()).filter(Boolean);
    } else if (nativeLanguageCode && String(nativeLanguageCode).trim()) {
      langs = [String(nativeLanguageCode).trim()];
    }

    // Normalize languages (defensive): keep stable keys and avoid duplicates
    const seen = new Set();
    langs = langs.filter((c) => {
      const key = c.toLowerCase().replaceAll("_", "-");
      if (!key) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const translationsRule =
      langs.length > 0
        ? `
Also include:
translations (object) where keys are exactly: ${JSON.stringify(langs)}
- Each value is a SHORT, natural translation of the WORD (not the definition).
- If a translation is not possible, return "" (empty string).
`
        : `
Also include:
translations (object) as {} (empty) because no native language was provided.
`;

    const system = `
You are an English vocabulary coach. Level: ${lvl}.

Return ONLY valid JSON: an array of items, each item with:
word (string),
definition (string),
synonyms (array of strings),
examples (array of strings),
collocations (array of strings).
${translationsRule}

STRICT RULES:
- Return JSON only. No markdown, no extra text.
- Keep definitions in English.
- Synonyms/examples/collocations should be appropriate for level ${lvl}.
`.trim();

    const user = `
Words: ${cleanWords.join(", ")}
Return the JSON array now.
`.trim();

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const content = completion.choices?.[0]?.message?.content?.trim() || "";
    const json = parseJsonSafely(content);

    if (!json || !Array.isArray(json)) {
      return res.status(502).json({
        error: "Model did not return a valid JSON array.",
        raw: content,
      });
    }

    // ✅ Normalize output defensively: always ensure `translations` exists
    const normalized = json.map((it) => {
      const obj = typeof it === "object" && it ? it : {};
      const translations =
        obj.translations && typeof obj.translations === "object" ? obj.translations : {};
      return { ...obj, translations };
    });

    return res.json(normalized);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// ===============================
// Step 7: Sentences feedback
// POST /ai/sentences-feedback
// ===============================
app.post("/ai/sentences-feedback", async (req, res) => {
  try {
    const { items, level } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing 'items' (array)." });
    }

    const cleanItems = items
      .map((it) => ({
        word: String(it.word || "").trim(),
        sentences: Array.isArray(it.sentences)
          ? it.sentences.map((s) => String(s || "").trim())
          : [],
      }))
      .filter(
        (it) =>
          it.word &&
          it.sentences.length === 2 &&
          it.sentences.every((s) => s.length > 0)
      );

    if (cleanItems.length === 0) {
      return res
        .status(400)
        .json({ error: "Each item must have a word and 2 sentences." });
    }

    const lvl = normalizeLevel(level);

    const system = `
You are an English teacher for level ${lvl}.
Return ONLY valid JSON (no markdown, no extra text).

Required JSON schema:
{
  "results": [
    {
      "word": "string",
      "sentences": [
        {
          "original": "string",
          "corrected": "string",
          "issues": ["string"],
          "tips": ["string"]
        },
        {
          "original": "string",
          "corrected": "string",
          "issues": ["string"],
          "tips": ["string"]
        }
      ],
      "overall_tips": ["string"]
    }
  ]
}
`.trim();

    const user = `
Analyze these items. Each item has a word and exactly 2 sentences.
Keep corrections natural and ${lvl}-friendly.
Return the JSON now.

Items:
${JSON.stringify({ items: cleanItems }, null, 2)}
`.trim();

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const json = parseJsonSafely(content);

    if (!json) {
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw: content,
      });
    }

    return res.json(json);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ===============================
// Step 10: Resume + Score
// POST /ai/resume-score
// ✅ Accepts BOTH payload formats:
//   A) { level, drafts: [..], newWords: [], sentencesByWord: {} }  (iOS app)
//   B) { level, writing1, writing2, writing100, newWords, sentencesByWord } (legacy)
// ===============================
app.post("/ai/resume-score", async (req, res) => {
  try {
    const body = req.body || {};

    const lvl = normalizeLevel(body.level || "B2");

    // Format A (preferred)
    const drafts = Array.isArray(body.drafts) ? body.drafts : null;

    // Format B (legacy)
    const writing1 = String(body.writing1 ?? "");
    const writing2 = String(body.writing2 ?? "");
    const writing100 = String(body.writing100 ?? "");

    const finalDrafts = drafts
      ? drafts.map((d) => String(d || "")).filter((t) => t.trim().length > 0)
      : [writing1, writing2, writing100].filter((t) => t.trim().length > 0);

    const newWords = Array.isArray(body.newWords) ? body.newWords : [];
    const sentencesByWord =
      body.sentencesByWord && typeof body.sentencesByWord === "object"
        ? body.sentencesByWord
        : {};

    const system = `You are an English tutor and evaluator. Level: ${lvl}.
Return ONLY valid JSON with keys:
summary (string),
score_total (int 0-100),
breakdown (object with grammar, clarity, vocabulary, improvement; each 0-25),
next_steps (array of strings).`;

    const user = `Student session data:
- Drafts: ${JSON.stringify(finalDrafts)}
- New words: ${JSON.stringify(newWords)}
- Sentences by word: ${JSON.stringify(sentencesByWord)}

Return the JSON now.`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const content = completion.choices?.[0]?.message?.content?.trim() || "";
    const json = parseJsonSafely(content);

    if (!json) {
      return res.status(502).json({
        error: "Model did not return valid JSON.",
        raw: content,
      });
    }

    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// ===============================
// Step 8: Conversation
// POST /ai/conversation
// ✅ Uses TED-Ed context automatically if tedUrl is provided
// Body: { level, vocabulary, messages, tedUrl?, topicResume? }
// ===============================
app.post("/ai/conversation", async (req, res) => {
  try {
    const { level, topicResume, vocabulary, messages, tedUrl } = req.body || {};

    if (!level || !Array.isArray(messages)) {
      return res.status(400).json({
        error: "Missing required fields: level, messages",
      });
    }

    const lvl = normalizeLevel(level);
    const spec = levelSpec(lvl);

    // ✅ Try TED-Ed context first (if tedUrl provided)
    const tedContext = tedUrl ? await extractTedEdContext(String(tedUrl).trim()) : null;

    const safeVocab = Array.isArray(vocabulary)
      ? vocabulary
          .map((w) => String(w || "").trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];

    const systemPrompt = `
You are an English conversation partner.
Target level: ${lvl} (CEFR).

STYLE & LEVEL RULES:
${spec}

GLOBAL RULES (always):
- Be friendly and encouraging.
- Keep focus on the TED-Ed topic when possible.
- Use the provided vocabulary naturally when it fits (do not force).
- Always ask a follow-up question at the end.
- Corrections: keep them gentle, short, and helpful.
- Never output JSON. Output plain conversational text only.
`.trim();

    const contextPrompt = `
TED-Ed context:
${
  tedContext
    ? `Title: ${tedContext.title || "Unknown"}
Description: ${tedContext.description || "No description available"}
URL: ${tedContext.canonical || tedUrl || ""}`
    : `No TED-Ed context fetched (missing/invalid tedUrl or fetch failed).`
}

Fallback topic summary (if any):
${String(topicResume || "").trim() || "No summary provided."}

Key vocabulary:
${safeVocab.join(", ")}

If the user has no messages yet, start by asking ONE open question about the TED-Ed topic.
`.trim();

    const chatMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: contextPrompt },
      ...messages.map((m) => ({
        role: String(m.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
        content: String(m.content || ""),
      })),
    ];

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      messages: chatMessages,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";
    if (!reply) {
      return res.status(502).json({ error: "Empty reply from model" });
    }

    return res.json({
      reply,
      // Optional debug fields (safe to remove later)
      usedTedUrl: Boolean(tedContext),
      tedTitle: tedContext?.title || null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).send(err?.message || "Conversation error");
  }
});

// ===============================
// Listen (keep at bottom)
// ===============================
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("Server running on", port);
});

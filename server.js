import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Helper: safe JSON parse from model output
function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// -------------------------------
// Conversation helpers (TED-Ed)
// -------------------------------
function normalizeLevel(level) {
  const L = String(level || "B2").toUpperCase().trim();
  const allowed = new Set(["A1", "A2", "B1", "B2", "C1"]);
  return allowed.has(L) ? L : "B2";
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

function isValidTedEdLessonUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return (
      u.protocol === "https:" &&
      u.hostname === "ed.ted.com" &&
      u.pathname.startsWith("/lessons/")
    );
  } catch {
    return false;
  }
}

/**
 * Fetches TED-Ed lesson page and extracts:
 * - title
 * - description
 * Uses meta og tags and some fallbacks.
 */
async function fetchTedEdContext(lessonUrl) {
  const url = String(lessonUrl || "").trim();

  if (!url || !isValidTedEdLessonUrl(url)) {
    return {
      url,
      title: "",
      description: "",
      extractedText: "",
      ok: false,
      reason: !url ? "missing_url" : "invalid_ted_ed_url",
    };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "EnglishFlowBot/1.0",
        Accept: "text/html",
      },
      signal: controller.signal,
    });

    const html = await resp.text();
    const $ = cheerio.load(html);

    // Prefer meta tags
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const ogDesc = $('meta[property="og:description"]').attr("content") || "";

    // Fallbacks
    const h1 = $("h1").first().text().trim() || "";
    const pageTitle = $("title").text().trim() || "";
    const metaDesc = $('meta[name="description"]').attr("content") || "";

    // Try JSON-LD (sometimes has clean data)
    let ldTitle = "";
    let ldDesc = "";
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        if (!ldTitle && json?.name) ldTitle = String(json.name).trim();
        if (!ldDesc && json?.description) ldDesc = String(json.description).trim();
      } catch {}
    });

    const title = (ldTitle || ogTitle || h1 || pageTitle || "").trim();
    const description = (ldDesc || ogDesc || metaDesc || "").trim();

    const extractedText = [
      title ? `Title: ${title}` : "",
      description ? `Description: ${description}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      url,
      title,
      description,
      extractedText,
      ok: true,
    };
  } catch (e) {
    return {
      url,
      title: "",
      description: "",
      extractedText: "",
      ok: false,
      reason: "fetch_failed",
    };
  } finally {
    clearTimeout(t);
  }
}

// -------------------------------
// Existing endpoints
// -------------------------------
app.post("/ai/writing-feedback", async (req, res) => {
  try {
    const { text, level = "B2", stepName = "Writing" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'text'." });
    }

    const system = `You are an English tutor. Level: ${level}.
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

app.post("/ai/vocabulary", async (req, res) => {
  try {
    const { words, level = "B2" } = req.body || {};
    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ error: "Missing or invalid 'words' array." });
    }

    const system = `You are an English vocabulary coach. Level: ${level}.
Return ONLY valid JSON: an array of items, each item with:
word (string),
definition (string),
synonyms (array of strings),
examples (array of strings),
collocations (array of strings).`;

    const user = `Words: ${words.join(", ")}
Return the JSON array now.`;

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

    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// ===============================
// AI: Sentences feedback (Step 7)
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

    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/ai/resume-score", async (req, res) => {
  try {
    const {
      writing1 = "",
      writing2 = "",
      writing100 = "",
      newWords = [],
      sentencesByWord = {},
      level = "B2",
    } = req.body || {};

    const system = `You are an English tutor and evaluator. Level: ${level}.
Return ONLY valid JSON with keys:
summary (string),
score_total (int 0-100),
breakdown (object with grammar, clarity, vocabulary, improvement; each 0-25),
next_steps (array of strings).`;

    const user = `Student session data:
- Draft 1: ${writing1}
- Draft 2: ${writing2}
- 100-word paragraph: ${writing100}
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
// AI: Conversation (Step 8)
// POST /ai/conversation
// Uses TED-Ed link context instead of resume
// ===============================
app.post("/ai/conversation", async (req, res) => {
  try {
    const {
      level,
      videoUrl,     // preferred
      tedUrl,       // optional alias
      topicResume,  // kept for backward-compat, but not required now
      vocabulary = [],
      messages = []
    } = req.body || {};

    const lvl = normalizeLevel(level);

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid 'messages' array." });
    }

    const lessonLink = String(videoUrl || tedUrl || "").trim();
    const ted = await fetchTedEdContext(lessonLink);

    // Clean and unique vocabulary (case-insensitive)
    const cleanedVocab = Array.isArray(vocabulary)
      ? vocabulary
          .map((w) => String(w || "").trim())
          .filter(Boolean)
      : [];

    const seen = new Set();
    const uniqueVocab = cleanedVocab.filter((w) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const spec = levelSpec(lvl);

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
TED-Ed lesson link:
${ted.url || "No link provided."}

TED-Ed context (use this as the main reference):
${ted.extractedText || "Could not extract TED-Ed content. Use the fallback summary below if available."}

Fallback summary (if needed):
${String(topicResume || "").trim() || "No summary provided."}

Key vocabulary:
${uniqueVocab.length ? uniqueVocab.join(", ") : "(none)"}

If this is the first turn (no messages yet), start by asking ONE open question about the topic.
Otherwise, continue the conversation naturally.
`.trim();

    // Normalize roles to "user" | "assistant"
    const safeMessages = messages.map((m) => ({
      role: String(m?.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
      content: String(m?.content || ""),
    }));

    const completion = await openai.chat.completions.create({
      model: MODEL, // ✅ consistent model
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contextPrompt },
        ...safeMessages,
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";
    if (!reply) {
      return res.status(502).json({ error: "Empty reply from model" });
    }

    // Return reply + extracted TED info (useful for debugging / UI)
    return res.json({
      reply,
      ted: {
        url: ted.url,
        title: ted.title,
        description: ted.description,
        ok: ted.ok,
        reason: ted.reason,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Conversation error" });
  }
});

// IMPORTANT: keep listen at the end (or after all routes)
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("Server running on", port);
});

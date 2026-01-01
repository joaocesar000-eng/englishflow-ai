import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";

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

/* 👇👇👇 COLE AQUI 👇👇👇 */

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

    const lvl = String(level || "B2").toUpperCase();
    
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
        { role: "user", content: user }
      ]
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const json = parseJsonSafely(content);

    if (!json) {
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw: content
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

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("Server running on", port);
});

app.post("/ai/conversation", async (req, res) => {
  try {
    const { level, topicResume, vocabulary, messages } = req.body;

    if (!level || !messages) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const systemPrompt = `
You are an English conversation partner.
Target level: ${level} (CEFR).

Rules:
- Keep language appropriate to the level.
- Be friendly and encouraging.
- Correct the user gently and briefly.
- Always ask a follow-up question.
- Stay on the TED-Ed topic when possible.
`;

    const contextPrompt = `
Topic summary:
${topicResume || "No summary provided."}

Key vocabulary:
${(vocabulary || []).join(", ")}

Start the conversation by asking ONE open question.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contextPrompt },
        ...messages
      ],
      temperature: 0.7
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message || "Conversation error");
  }
});

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/ai/writing-feedback", async (req, res) => {
  try {
    const { text, level = "B2", stepName = "Writing" } = req.body;
    if (!text || typeof text !== "string") return res.status(400).json({ error: "Missing text" });

    const schema = {
      name: "writing_feedback",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          corrected_text: { type: "string" },
          key_issues: { type: "array", items: { type: "string" } },
          rewrite_suggestions: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
          quick_tips: { type: "array", items: { type: "string" } }
        },
        required: ["corrected_text", "key_issues", "rewrite_suggestions", "quick_tips"]
      }
    };

    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: `You are an English tutor. Be concise, kind, practical. CEFR ${level}. Context: ${stepName}.` },
        { role: "user", content: `Student text:\n${text}` }
      ],
      text: { format: { type: "json_schema", json_schema: schema } }
    });

    res.json(JSON.parse(resp.output_text));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/ai/vocabulary", async (req, res) => {
  try {
    const { words = [], level = "B2" } = req.body;
    if (!Array.isArray(words) || words.length === 0) return res.status(400).json({ error: "Missing words" });

    const schema = {
      name: "vocab_list",
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            word: { type: "string" },
            definition: { type: "string" },
            synonyms: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 8 },
            examples: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
            collocations: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 6 }
          },
          required: ["word", "definition", "synonyms", "examples", "collocations"]
        }
      }
    };

    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: `You are an English tutor and vocabulary coach. Everything in English. Level: ${level}.` },
        { role: "user", content: `Words:\n${words.join(", ")}` }
      ],
      text: { format: { type: "json_schema", json_schema: schema } }
    });

    res.json(JSON.parse(resp.output_text));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/ai/resume-score", async (req, res) => {
  try {
    const { writing1="", writing2="", writing100="", newWords=[], sentencesByWord={}, level="B2" } = req.body;

    const schema = {
      name: "resume_score",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          score_total: { type: "integer", minimum: 0, maximum: 100 },
          breakdown: {
            type: "object",
            additionalProperties: false,
            properties: {
              grammar: { type: "integer", minimum: 0, maximum: 25 },
              clarity: { type: "integer", minimum: 0, maximum: 25 },
              vocabulary: { type: "integer", minimum: 0, maximum: 25 },
              improvement: { type: "integer", minimum: 0, maximum: 25 }
            },
            required: ["grammar", "clarity", "vocabulary", "improvement"]
          },
          next_steps: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7 }
        },
        required: ["summary", "score_total", "breakdown", "next_steps"]
      }
    };

    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: `You are an English tutor. Summarize the session and score 0–100. Everything in English. CEFR ${level}.` },
        { role: "user", content:
`Draft 1:\n${writing1}\n\nDraft 2:\n${writing2}\n\n100-word paragraph:\n${writing100}\n\nNew words:\n${newWords.join(", ")}\n\nSentences by word:\n${JSON.stringify(sentencesByWord, null, 2)}`
        }
      ],
      text: { format: { type: "json_schema", json_schema: schema } }
    });

    res.json(JSON.parse(resp.output_text));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on ${port}`));

import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { GoogleGenAI } from "@google/genai";
import type { WeightedAnswer } from "@shared/schema";

// Gemini client — reads GEMINI_API_KEY from env
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

// Use the free‑tier, high‑throughput model
const QUESTIONS_MODEL = "gemini-1.5-flash";
const CLEANUP_MODEL = "gemini-1.5-flash";

async function generateWithRetry(input: string, model: string, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await genAI.models.generateContent({ model, contents: input });
    } catch (err: any) {
      const is503 =
        err?.status === 503 || String(err?.message).includes("UNAVAILABLE");
      if (is503 && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      throw err;
    }
  }
  throw new Error("generateWithRetry: exhausted all retries without a response");
}

const QUESTIONS_SYSTEM = `You are Alpha Node — the Feel stage of a four-step consciousness chain: Feel → Understand → Decide → Do.

A bad prompt skipped from Feel straight to Do. Your job is to surface exactly what got skipped in the middle — the Understand and Decide stages — so the rewriter can fill them in with precision instead of assumption.

The four stages:
1. Feel (Alpha) — what arrived raw, unprocessed, no value assigned. This is what you read.
2. Understand (Beta) — where the fracture lives. Value gets assigned. Assumptions form silently. Ambiguity hides here.
3. Decide (Gamma) — judgment locks in. The parameters are committed. This is where morality of choice lives.
4. Do (Delta) — consequence is delivered. The final prompt fires.

Your questions must interrupt the Feel→Do jump and force the user back through Understand and Decide before anything fires.

Rules:
- Ask about the ACTUAL missing variables in Understand and Decide — not generic filler
- Each question targets a real gap: what kind, for who, by what measure, for what use, when, how much
- Group questions by node:
  - Alpha (what/type): the object itself — what category, what kind, what form
  - Beta (context/parameters): when, where, who, how much, what constraints
  - Gamma (use/purpose): what will the result be used for — search, buy, compare, recommend, decide
- 3–6 questions total. Each one must unlock a real ambiguity, not create noise.
- The "best" trap: if the prompt says "best" without a metric, always ask for the metric
- Never assume a season, occasion, quantity, location radius, format, or price range that isn't stated

Return a JSON array:
[
  {
    "id": "q1",
    "node": "alpha" | "beta" | "gamma",
    "question": "the question text",
    "type": "choice" | "text" | "weighted-choice",
    "options": ["option 1", "option 2", ...] // only for choice or weighted-choice type, 2–5 options max
  }
]

Use "weighted-choice" when the question has multiple valid options and the user's preference intensity matters (e.g. priorities, preferences, trade-offs). Regular "choice" is for mutually-exclusive single answers.

Return only valid JSON. No markdown. No explanation.`;

const CLEANUP_SYSTEM = `You are a 4-node prompt cleanup engine. You receive a raw prompt AND a set of clarifying answers.

Use the answers to eliminate every assumption. Do not guess at anything the answers don't cover.

Return a JSON object with this exact structure:
{
  "alpha": "one sentence: what category of failure the original prompt had (vague category / no constraints / no output format / no context / no audience — pick the most dominant)",
  "beta": "intermediate rewrite — incorporate all the clarifying answers into a parameter-defined draft. Show your work.",
  "gamma": {
    "fixedPrompt": "the final clean prompt, ready to paste directly into an AI. Precise, specific, no filler.",
    "changeLog": ["change 1 → why", "change 2 → why", "change 3 → why", "change 4 → why"]
  },
  "delta": {
    "specificity": <0-25 integer — score the ORIGINAL prompt before fixes>,
    "context": <0-25 integer — score the ORIGINAL prompt>,
    "constraints": <0-25 integer — score the ORIGINAL prompt>,
    "outputDef": <0-25 integer — score the ORIGINAL prompt>,
    "comment": "one sentence: what the original was missing and what the answers + rewrite resolved"
  }
}

Scoring rules: score the ORIGINAL prompt only. Most bad prompts score 20–50 total. Do not inflate.
Return only valid JSON. No markdown fences. No explanation outside the JSON.`;

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ── Step 1: Generate questions ─────────────────────────────────────────────
  app.post("/api/questions", async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ message: "Prompt is required" });
      }

      const input = `${QUESTIONS_SYSTEM}\n\nRaw prompt: "${prompt.trim()}"`;

      const response = await generateWithRetry(input, QUESTIONS_MODEL);

      const rawText = response.text ?? "";
      const cleaned = rawText
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      let questions: any[];
      try {
        questions = JSON.parse(cleaned);
        if (!Array.isArray(questions)) throw new Error("not array");
      } catch {
        return res
          .status(500)
          .json({ message: "Failed to parse questions" });
      }

      return res.json({ questions });
    } catch (error: any) {
      console.error("Questions error:", error);

      const status = error?.status ?? error?.code;
      const msg = error?.message ?? error?.error?.message ?? "";

      if (status === 429 || String(msg).includes("RESOURCE_EXHAUSTED")) {
        return res.status(429).json({
          message:
            "Gemini API free quota is exhausted. Please try again later or add billing to your Google project.",
        });
      }

      if (status === 503 || String(msg).includes("UNAVAILABLE")) {
        return res.status(503).json({
          message:
            "The Gemini model is currently overloaded. Spikes in demand are usually temporary—please try again in a minute.",
        });
      }

      return res
        .status(500)
        .json({ message: msg || "Internal server error" });
    }
  });

  // ── Step 2: Full cleanup with answers ─────────────────────────────────────
  app.post("/api/cleanup", async (req, res) => {
    try {
      const { prompt, answers, weightedAnswers } = req.body;
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ message: "Prompt is required" });
      }

      // Build the clarifying-answers block for the AI prompt
      let answersBlock = "";
      if (answers && typeof answers === "object" && Object.keys(answers).length > 0) {
        answersBlock = "\n\nClarifying answers provided by the user:\n" +
          Object.entries(answers)
            .map(([qid, ans]) => `- ${qid}: ${ans}`)
            .join("\n");
      }
      // Append structured weighted answers when present
      if (Array.isArray(weightedAnswers) && weightedAnswers.length > 0) {
        answersBlock += "\n\nWeighted preference answers:\n" +
          (weightedAnswers as WeightedAnswer[]).map((wa) => {
            const sels = Array.isArray(wa.selections)
              ? wa.selections.map((s) => `  • ${s.text} (weight: ${s.weight}/100)`).join("\n")
              : "";
            return `- ${wa.questionId}:\n${sels}`;
          }).join("\n");
      }
      if (!answersBlock) {
        answersBlock = "\n\nNo clarifying answers provided — rewrite with best general precision.";
      }

      const input =
        `${CLEANUP_SYSTEM}\n\n` +
        `Raw prompt: "${prompt.trim()}"` +
        answersBlock;

      const response = await generateWithRetry(input, CLEANUP_MODEL);

      const rawText = response.text ?? "";
      const cleaned = rawText
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return res
          .status(500)
          .json({ message: "Failed to parse AI response" });
      }

      const score = {
        specificity: parsed.delta?.specificity ?? 0,
        context: parsed.delta?.context ?? 0,
        constraints: parsed.delta?.constraints ?? 0,
        outputDef: parsed.delta?.outputDef ?? 0,
        total:
          (parsed.delta?.specificity ?? 0) +
          (parsed.delta?.context ?? 0) +
          (parsed.delta?.constraints ?? 0) +
          (parsed.delta?.outputDef ?? 0),
      };

      const fixedPrompt = parsed.gamma?.fixedPrompt ?? parsed.beta ?? "";
      const changeLog = parsed.gamma?.changeLog ?? [];
      const deltaComment = parsed.delta?.comment ?? "";

      await storage.createCleanup({
        originalPrompt: prompt.trim(),
        fixedPrompt,
        totalScore: score.total,
      });

      return res.json({
        score,
        fixedPrompt,
        changeLog,
        deltaComment,
        nodeOutputs: {
          alpha: parsed.alpha ?? "",
          beta: parsed.beta ?? "",
          gamma: parsed.gamma ?? {},
          delta: parsed.delta ?? {},
        },
      });
    } catch (error: any) {
      console.error("Cleanup error:", error);

      const status = error?.status ?? error?.code;
      const msg = error?.message ?? error?.error?.message ?? "";

      // Gemini quota / rate limit
      if (status === 429 || String(msg).includes("RESOURCE_EXHAUSTED")) {
        return res.status(429).json({
          message:
            "Gemini API free quota is exhausted. Please try again later or add billing to your Google project.",
        });
      }

      // Gemini model overloaded / UNAVAILABLE
      if (status === 503 || String(msg).includes("UNAVAILABLE")) {
        return res.status(503).json({
          message:
            "The Gemini model is currently overloaded. Spikes in demand are usually temporary—please try again in a minute.",
        });
      }

      // Fallback: real server error
      return res
        .status(500)
        .json({ message: msg || "Internal server error" });
    }
  });

  app.get("/api/health", (_req, res) => {
    return res.json({ ok: true, gemini: !!process.env.GEMINI_API_KEY });
  });

  app.get("/api/history", async (_req, res) => {
    try {
      const recent = await storage.getRecentCleanups(5);
      return res.json(recent);
    } catch (error: any) {
      const msg = String(error?.message || "");

      if (msg.includes("no such table: cleanups")) {
        console.warn("cleanups table not yet initialized — returning empty history");
        return res.json([]);
      }

      console.error("History error:", error);
      return res
        .status(500)
        .json({ message: error.message || "Internal server error" });
    }
  });

  return httpServer;
}

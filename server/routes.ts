import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { GoogleGenAI } from "@google/genai";

const QUESTIONS_MODEL = "gemini-3-flash-preview";
const CLEANUP_MODEL = "gemini-3-flash-preview";

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
    "type": "choice" | "text",
    "options": ["option 1", "option 2", ...] // only for choice type, 2–4 options max
  }
]

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
  // Gemini client — initialized here so GEMINI_API_KEY is validated before use
  const genAI = new GoogleGenAI({});

  // ── Step 1: Generate questions ─────────────────────────────────────────────
  app.post("/api/questions", async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ message: "Prompt is required" });
      }

      const input = `${QUESTIONS_SYSTEM}\n\nRaw prompt: "${prompt.trim()}"`;

      const response = await genAI.models.generateContent({
        model: QUESTIONS_MODEL,
        contents: input,
      });

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
      return res
        .status(500)
        .json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/cleanup", async (req, res) => {
    try {
      const { prompt, answers } = req.body;
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ message: "Prompt is required" });
      }

      const answersBlock =
        answers &&
        typeof answers === "object" &&
        Object.keys(answers).length > 0
          ? "\n\nClarifying answers provided by the user:\n" +
            Object.entries(answers)
              .map(([qid, ans]) => `- ${qid}: ${ans}`)
              .join("\n")
          : "\n\nNo clarifying answers provided — rewrite with best general precision.";

      const input =
        `${CLEANUP_SYSTEM}\n\n` +
        `Raw prompt: "${prompt.trim()}"` +
        answersBlock;

      const response = await genAI.models.generateContent({
        model: CLEANUP_MODEL,
        contents: input,
      });

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
      return res
        .status(500)
        .json({ message: error.message || "Internal server error" });
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
      console.error("History error:", error);
      return res
        .status(500)
        .json({ message: error.message || "Internal server error" });
    }
  });

  return httpServer;
}

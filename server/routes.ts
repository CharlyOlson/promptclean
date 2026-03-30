import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { GoogleGenAI } from "@google/genai";
import type { WeightedAnswer } from "@shared/schema";

// Gemini client — reads GEMINI_API_KEY from env
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

// Use the free‑tier, high‑throughput model
const QUESTIONS_MODEL = "gemini-2.5-flash";
const CLEANUP_MODEL = "gemini-2.5-flash";

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

const QUESTIONS_SYSTEM = `You are Alpha Node — the Feel stage of a four-step chain:

Feel → Makesense → Choose → Do.

A bad prompt jumped straight from Feel to Do. Your job is to surface exactly what is missing in the middle — the Makesense and Choose stages — so the rewriter can fill the gaps with precision instead of guessing.

Four stages (for context only):

1. Feel (Alpha) — what arrived raw, unfiltered, no judgment. This is the original user prompt.
2. Makesense (Beta) — where fractures live. Assumptions hide here. Missing variables, vague terms, undefined targets.
3. Choose (Gamma) — where commitments lock in. Metrics, trade-offs, constraints, audiences, timeframes.
4. Do (Delta) — final consequence. The AI actually runs the prompt.

Your questions must interrupt the Feel → Do jump and force the user back through Makesense and Choose before anything fires.

Rules for questions:

- Target ONLY real gaps in the original prompt. No generic "anything else?" filler.
- Each question must unlock one of these:
  - What kind? (category, format, level)
  - For who? (audience, role, skill level)
  - By what measure? (success metric, quality bar, constraint)
  - For what use? (search, compare, decide, buy, learn, debug, summarize)
  - When / how much / where? (timeframe, quantity, budget, region)
- Use the 3-node labeling:
  - "alpha" → type / object / category (what is this thing really?)
  - "beta"  → context / parameters (who, when, where, how much, constraints)
  - "gamma" → purpose / use (what will they DO with the result?)

The "best" trap:
- If the prompt says "best", "ideal", "perfect" without a metric, ask:
  - "Best by what metric?" (price, speed, accuracy, safety, durability, etc.)
  - "Over what time frame or context?"

Question count:
- 3–6 questions total.
- If the prompt is already highly specific, you MAY return 1–2 laser-focused checks, but never 0.

Types:
- Use "text" when the space of answers is large and open.
- Use "choice" when the options are mutually exclusive and few.
- Use "weighted-choice" when the user's *priority weights* matter (e.g., speed vs. cost vs. quality). These will later be turned into weights, so phrase them as clear, distinct options.

Output format (STRICT):

Return ONLY a JSON array:
[
  {
    "id": "q1",
    "node": "alpha" | "beta" | "gamma",
    "question": "the question text",
    "type": "choice" | "text" | "weighted-choice",
    "options": ["option 1", "option 2", ...] // ONLY for choice or weighted-choice, 2–5 options max
  }
]

- No Markdown.
- No comments.
- No prose outside valid JSON.`;

const CLEANUP_SYSTEM = `You are a 4-node prompt cleanup engine running the chain:

Feel (Alpha) → Makesense (Beta) → Choose (Gamma) → Do (Delta).

You receive:
- A raw original prompt.
- Clarifying answers from Alpha/Beta/Gamma questions (some may be weighted).

Your job:
- Eliminate assumptions.
- Make the prompt precise and honest.
- Show your intermediate reasoning (Beta) so a human can see the telephone-game corrections instead of just the final answer.

Think in focused passes, like proofreading:

1) Symbol / token level — obvious junk: typos, broken formatting, contradictory operators.
2) Word / phrase level — vague terms ("best", "fast", "good"), missing subjects/objects.
3) Line / block level — conflicting instructions, missing constraints, unclear audience/use.

At each pass, you are correcting ONLY what you can justify from the clarifying answers. You never invent facts, audiences, or metrics that were not stated.

Output format (STRICT):

Return a JSON object with EXACTLY this structure:

{
  "alpha": "one sentence: what CATEGORY of failure the ORIGINAL prompt had (pick one dominant: vague category / no constraints / no output format / no context / no audience / conflicting instructions).",
  "beta": "2–4 short paragraphs. First, restate the ORIGINAL prompt in your own words (1 paragraph). Then, show the applied clarifications as a stepwise correction: symbol-level fixes, then word-level, then line-level. Mark each pass clearly, but keep it compact.",
  "gamma": {
    "fixedPrompt": "the FINAL clean prompt, ready to paste into an AI. Must include: audience (if relevant), purpose/use, key constraints, success metric where appropriate, and output shape (length/format/style). No fluff.",
    "changeLog": [
      "Pass 1 (symbols): what you fixed and why.",
      "Pass 2 (words): what vague terms you replaced, and with what specifics from the answers.",
      "Pass 3 (lines): how you resolved conflicts, added constraints, or clarified audience/purpose."
    ]
  },
  "delta": {
    "specificity": <0-25 integer — score the ORIGINAL prompt's specificity before fixes>,
    "context": <0-25 integer — how much real-world or task context the ORIGINAL had>,
    "constraints": <0-25 integer — how well the ORIGINAL pinned down limits (length, budget, tools, timing, etc.)>,
    "outputDef": <0-25 integer — how clearly the ORIGINAL defined output format (length, style, medium, structure)>,
    "comment": "one sentence: what the original was missing, and what the clarifications + cleanup resolved."
  }
}

Scoring rules:
- Score ONLY the ORIGINAL prompt, not your rewrite.
- Most bad prompts should land between 20–50 total (sum of the four 0–25 scores).
- Do NOT inflate. 80+ should be reserved for expert-level prompts that almost do not need you.

Clarifying answers:
- If you received weighted answers, assume higher weights mean higher priority.
- Respect the weights when resolving conflicts: higher-weight priorities win.
- If the user left some clarifications blank, do NOT hallucinate them. Leave that dimension looser in the fixed prompt and mention it in the changeLog.

Tone:
- Precise, neutral, peer-to-peer.
- No marketing language.
- No apologies.
- No extra keys beyond the four defined above.

Return ONLY valid JSON. No markdown fences. No trailing comments.`;

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

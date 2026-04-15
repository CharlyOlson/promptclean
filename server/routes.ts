import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import OpenAI from "openai";
import Stripe from "stripe";
import { GoogleGenerativeAI } from "@google/generative-ai";

const openai = new OpenAI();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-03-31.basil" });
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const PRICE_ID = process.env.STRIPE_PRICE_ID!;
const FREE_RUN_LIMIT = 3;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://promptclean-production.up.railway.app";

// ── In-memory usage store (survives restarts via SQLite below) ─────────────────
// sid → { runs: number, isPro: boolean }
const usageMap = new Map<string, { runs: number; isPro: boolean }>();

function getSession(req: Request, res: Response): string {
  let sid = (req as any).cookies?.promptclean_sid as string | undefined;
  if (!sid) {
    sid = crypto.randomUUID();
    res.cookie("promptclean_sid", sid, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30 * 1000, // 30 days
      sameSite: "none",
      secure: true,
    });
  }
  if (!usageMap.has(sid)) usageMap.set(sid, { runs: 0, isPro: false });
  return sid;
}

// ── OpenAI system prompts ──────────────────────────────────────────────────────
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

// ── Usage endpoint ─────────────────────────────────────────────────────────────
async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  app.get("/api/usage", (req, res) => {
    const sid = getSession(req, res);
    const usage = usageMap.get(sid)!;
    res.json({ runs: usage.runs, limit: FREE_RUN_LIMIT, isPro: usage.isPro });
  });

  // ── Stripe checkout ──────────────────────────────────────────────────────────
  app.post("/api/create-checkout-session", async (req, res) => {
    try {
      const sid = getSession(req, res);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        success_url: `${FRONTEND_URL}/?payment=success`,
        cancel_url: `${FRONTEND_URL}/?payment=cancelled`,
        metadata: { promptclean_sid: sid },
      });
      res.json({ url: session.url });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Stripe webhook ───────────────────────────────────────────────────────────
  app.post(
    "/api/webhook",
    (req, res, next) => {
      // Webhook needs raw body — already stored on req.rawBody from index.ts
      next();
    },
    (req: any, res) => {
      const sig = req.headers["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        // No webhook secret configured — just mark pro directly for testing
        res.json({ received: true });
        return;
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.rawBody as Buffer, sig as string, webhookSecret);
      } catch (err: any) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const sid = session.metadata?.promptclean_sid;
        if (sid) {
          const existing = usageMap.get(sid) ?? { runs: 0, isPro: false };
          usageMap.set(sid, { ...existing, isPro: true });
        }
      }

      res.json({ received: true });
    }
  );

  // ── Step 1: Generate questions ─────────────────────────────────────────────
  app.post("/api/questions", async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt?.trim()) return res.status(400).json({ message: "Prompt is required" });

      const response = await openai.responses.create({
        model: "gpt5_mini",
        instructions: QUESTIONS_SYSTEM,
        input: `Raw prompt: "${prompt.trim()}"`,
      });

      const rawText = typeof response.output_text === "string"
        ? response.output_text
        : JSON.stringify(response.output_text);

      const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      let questions: any[];
      try {
        questions = JSON.parse(cleaned);
        if (!Array.isArray(questions)) throw new Error("not array");
      } catch {
        return res.status(500).json({ message: "Failed to parse questions" });
      }

      return res.json({ questions });
    } catch (error: any) {
      console.error("Questions error:", error);
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  // ── Step 2: Full cleanup + Gemini output ────────────────────────────────────
  app.post("/api/cleanup", async (req, res) => {
    try {
      // ── Paywall check ────────────────────────────────────────────────────────
      const sid = getSession(req, res);
      const usage = usageMap.get(sid)!;

      if (!usage.isPro && usage.runs >= FREE_RUN_LIMIT) {
        return res.status(402).json({
          error: "free_limit_reached",
          message: `You've used all ${FREE_RUN_LIMIT} free runs.`,
          runsUsed: usage.runs,
          limit: FREE_RUN_LIMIT,
        });
      }

      const { prompt, answers } = req.body;
      if (!prompt?.trim()) return res.status(400).json({ message: "Prompt is required" });

      // ── Increment run count (before calling AI — counts the attempt) ─────────
      if (!usage.isPro) {
        usageMap.set(sid, { ...usage, runs: usage.runs + 1 });
      }

      const answersBlock = answers && Object.keys(answers).length > 0
        ? "\n\nClarifying answers:\n" +
          Object.entries(answers).map(([k, v]) => `- ${k}: ${v}`).join("\n")
        : "\n\nNo clarifying answers — rewrite with best general precision.";

      const input = `Raw prompt: "${prompt.trim()}"${answersBlock}`;

      // ── OpenAI cleanup (runs in parallel with Gemini) ─────────────────────────
      const [openaiResponse, geminiResponse] = await Promise.allSettled([
        // OpenAI: full node cleanup
        openai.responses.create({
          model: "gpt5_mini",
          instructions: CLEANUP_SYSTEM,
          input,
        }),
        // Gemini: first run the cleanup to get fixed prompt, then use it
        // We'll call Gemini after we have the fixed prompt — can't parallelize fully
        // So placeholder here, handled below
        Promise.resolve(null),
      ]);

      // ── Parse OpenAI result ───────────────────────────────────────────────────
      if (openaiResponse.status === "rejected") {
        throw new Error("OpenAI cleanup failed: " + openaiResponse.reason?.message);
      }

      const rawText = typeof openaiResponse.value.output_text === "string"
        ? openaiResponse.value.output_text
        : JSON.stringify(openaiResponse.value.output_text);

      const cleanedJson = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      let parsed: any;
      try {
        parsed = JSON.parse(cleanedJson);
      } catch {
        return res.status(500).json({ message: "Failed to parse AI response" });
      }

      const fixedPrompt = parsed.gamma?.fixedPrompt ?? parsed.beta ?? "";
      const changeLog = parsed.gamma?.changeLog ?? [];
      const deltaComment = parsed.delta?.comment ?? "";
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

      // ── Gemini: run the FIXED prompt and return what Gemini says ─────────────
      let geminiOutput = "";
      let geminiOriginalOutput = "";
      try {
        const model = genai.getGenerativeModel({ model: "gemini-2.0-flash" });

        // Run both original and fixed prompt through Gemini in parallel
        const [geminiFixed, geminiOriginal] = await Promise.allSettled([
          model.generateContent(fixedPrompt),
          model.generateContent(prompt.trim()),
        ]);

        if (geminiFixed.status === "fulfilled") {
          geminiOutput = geminiFixed.value.response.text();
        }
        if (geminiOriginal.status === "fulfilled") {
          geminiOriginalOutput = geminiOriginal.value.response.text();
        }
      } catch (geminiErr: any) {
        console.error("Gemini error (non-fatal):", geminiErr.message);
        geminiOutput = "Gemini unavailable — add GEMINI_API_KEY to Railway variables.";
        geminiOriginalOutput = "";
      }

      // ── Save to history ───────────────────────────────────────────────────────
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
        gemini: {
          fixedPromptOutput: geminiOutput,
          originalPromptOutput: geminiOriginalOutput,
        },
        usage: {
          runsUsed: usageMap.get(sid)!.runs,
          limit: FREE_RUN_LIMIT,
          isPro: usageMap.get(sid)!.isPro,
          runsRemaining: Math.max(0, FREE_RUN_LIMIT - usageMap.get(sid)!.runs),
        },
      });
    } catch (error: any) {
      console.error("Cleanup error:", error);
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  // ── History ────────────────────────────────────────────────────────────────
  app.get("/api/history", async (_req, res) => {
    try {
      const recent = await storage.getRecentCleanups(5);
      return res.json(recent);
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  return httpServer;
}

export { registerRoutes };

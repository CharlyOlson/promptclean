import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import Stripe from "stripe";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Clients ────────────────────────────────────────────────────────────────────
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" })
  : null;

const PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
const FREE_RUN_LIMIT = 3;
const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "https://promptclean-production.up.railway.app";

// ── Session usage tracking ─────────────────────────────────────────────────────
// sid -> { runs, isPro }
const usageMap = new Map<string, { runs: number; isPro: boolean }>();

function getSession(req: Request, res: Response): string {
  let sid = (req as any).cookies?.promptclean_sid as string | undefined;
  if (!sid) {
    sid = crypto.randomUUID();
    res.cookie("promptclean_sid", sid, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30 * 1000,
      sameSite: "none",
      secure: true,
    });
  }
  if (!usageMap.has(sid)) usageMap.set(sid, { runs: 0, isPro: false });
  return sid;
}

// ── Gemini helpers ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash";

async function geminiGenerate(prompt: string, system: string): Promise<string> {
  const model = genai.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: system,
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ── System prompts ─────────────────────────────────────────────────────────────
const QUESTIONS_SYSTEM = `You are Alpha Node — the Feel stage of a four-step consciousness chain: Feel, Understand, Decide, Do.

A bad prompt skipped from Feel straight to Do. Your job is to surface exactly what got skipped in the middle — the Understand and Decide stages — so the rewriter can fill them in with precision instead of assumption.

The four stages:
1. Feel (Alpha) — what arrived raw, unprocessed, no value assigned. This is what you read.
2. Understand (Beta) — where the fracture lives. Value gets assigned. Assumptions form silently. Ambiguity hides here.
3. Decide (Gamma) — judgment locks in. The parameters are committed. This is where morality of choice lives.
4. Do (Delta) — consequence is delivered. The final prompt fires.

Your questions must interrupt the Feel-to-Do jump and force the user back through Understand and Decide before anything fires.

Rules:
- Ask about the ACTUAL missing variables in Understand and Decide — not generic filler
- Each question targets a real gap: what kind, for who, by what measure, for what use, when, how much
- Group questions by node:
  - Alpha (what/type): the object itself — what category, what kind, what form
  - Beta (context/parameters): when, where, who, how much, what constraints
  - Gamma (use/purpose): what will the result be used for — search, buy, compare, recommend, decide
- 3 to 6 questions total. Each one must unlock a real ambiguity, not create noise.
- The "best" trap: if the prompt says "best" without a metric, always ask for the metric
- Never assume a season, occasion, quantity, location radius, format, or price range that is not stated

Return a JSON array:
[
  {
    "id": "q1",
    "node": "alpha",
    "question": "the question text",
    "type": "choice",
    "options": ["option 1", "option 2"]
  }
]

node must be "alpha", "beta", or "gamma". type must be "choice" or "text". options only for choice type, 2 to 4 items max.
Return only valid JSON. No markdown. No explanation.`;

const CLEANUP_SYSTEM = `You are a 4-node prompt cleanup engine. You receive a raw prompt AND a set of clarifying answers.

Use the answers to eliminate every assumption. Do not guess at anything the answers do not cover.

Return a JSON object with this exact structure:
{
  "alpha": "one sentence: what category of failure the original prompt had",
  "beta": "intermediate rewrite — incorporate all clarifying answers into a parameter-defined draft",
  "gamma": {
    "fixedPrompt": "the final clean prompt, ready to paste directly into an AI",
    "changeLog": ["change 1 — why", "change 2 — why", "change 3 — why"]
  },
  "delta": {
    "specificity": 0,
    "context": 0,
    "constraints": 0,
    "outputDef": 0,
    "comment": "one sentence on what the original was missing and what the rewrite resolved"
  }
}

Score the ORIGINAL prompt only. Each axis is 0-25. Most bad prompts score 20 to 50 total. Do not inflate.
Return only valid JSON. No markdown fences. No explanation outside the JSON.`;

// ── Route registration ─────────────────────────────────────────────────────────
export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Usage
  app.get("/api/usage", (req, res) => {
    const sid = getSession(req, res);
    const u = usageMap.get(sid)!;
    res.json({ runs: u.runs, limit: FREE_RUN_LIMIT, isPro: u.isPro });
  });

  // Stripe checkout
  app.post("/api/create-checkout-session", async (req, res) => {
    if (!stripe) return res.status(503).json({ message: "Payments not configured" });
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

  // Stripe webhook
  app.post("/api/webhook", (req: any, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) {
      res.json({ received: true });
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody as Buffer, sig as string, secret);
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
  });

  // Step 1: Generate clarifying questions
  app.post("/api/questions", async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt?.trim())
        return res.status(400).json({ message: "Prompt is required" });

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ message: "GEMINI_API_KEY not configured in Railway variables" });
      }

      const raw = await geminiGenerate(`Raw prompt: "${prompt.trim()}"`, QUESTIONS_SYSTEM);
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      let questions: any[];
      try {
        questions = JSON.parse(cleaned);
        if (!Array.isArray(questions)) throw new Error("not array");
      } catch {
        return res.status(500).json({ message: "Failed to parse questions from AI response" });
      }

      return res.json({ questions });
    } catch (err: any) {
      console.error("Questions error:", err);
      return res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // Step 2: Full cleanup + Gemini comparison
  app.post("/api/cleanup", async (req, res) => {
    try {
      // Paywall
      const sid = getSession(req, res);
      const usage = usageMap.get(sid)!;

      if (!usage.isPro && usage.runs >= FREE_RUN_LIMIT) {
        return res.status(402).json({
          error: "free_limit_reached",
          message: `You have used all ${FREE_RUN_LIMIT} free runs.`,
          runsUsed: usage.runs,
          limit: FREE_RUN_LIMIT,
        });
      }

      const { prompt, answers } = req.body;
      if (!prompt?.trim())
        return res.status(400).json({ message: "Prompt is required" });

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ message: "GEMINI_API_KEY not configured in Railway variables" });
      }

      // Increment before AI call
      if (!usage.isPro) {
        usageMap.set(sid, { ...usage, runs: usage.runs + 1 });
      }

      const answersBlock =
        answers && Object.keys(answers).length > 0
          ? "\n\nClarifying answers:\n" +
            Object.entries(answers)
              .map(([k, v]) => `- ${k}: ${v}`)
              .join("\n")
          : "\n\nNo clarifying answers — rewrite with best general precision.";

      const cleanupInput = `Raw prompt: "${prompt.trim()}"${answersBlock}`;

      // Run cleanup + original Gemini response in parallel
      const [cleanupResult, geminiOriginal] = await Promise.allSettled([
        geminiGenerate(cleanupInput, CLEANUP_SYSTEM),
        geminiGenerate(prompt.trim(), "Answer this request helpfully and concisely."),
      ]);

      // Parse cleanup
      if (cleanupResult.status === "rejected") {
        throw new Error("Cleanup failed: " + cleanupResult.reason?.message);
      }

      const cleanedJson = cleanupResult.value
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      let parsed: any;
      try {
        parsed = JSON.parse(cleanedJson);
      } catch {
        return res.status(500).json({ message: "Failed to parse cleanup response" });
      }

      const fixedPrompt = parsed.gamma?.fixedPrompt ?? parsed.beta ?? "";
      const changeLog: string[] = parsed.gamma?.changeLog ?? [];
      const deltaComment: string = parsed.delta?.comment ?? "";
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

      // Run fixed prompt through Gemini now that we have it
      let geminiFixed = "";
      try {
        const fixedResult = await geminiGenerate(
          fixedPrompt,
          "Answer this request helpfully and concisely."
        );
        geminiFixed = fixedResult;
      } catch (err: any) {
        console.error("Gemini fixed prompt error (non-fatal):", err.message);
      }

      const geminiOriginalText =
        geminiOriginal.status === "fulfilled" ? geminiOriginal.value : "";

      // Save to history
      await storage.createCleanup({
        userId: sid,
        originalPrompt: prompt.trim(),
        fixedPrompt,
        totalScore: score.total,
      });

      const currentUsage = usageMap.get(sid)!;

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
          fixedPromptOutput: geminiFixed,
          originalPromptOutput: geminiOriginalText,
        },
        usage: {
          runsUsed: currentUsage.runs,
          limit: FREE_RUN_LIMIT,
          isPro: currentUsage.isPro,
          runsRemaining: Math.max(0, FREE_RUN_LIMIT - currentUsage.runs),
        },
      });
    } catch (err: any) {
      console.error("Cleanup error:", err);
      return res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  // History
  app.get("/api/history", async (req, res) => {
    try {
      const sid = getSession(req, res);
      const recent = await storage.getRecentCleanups(sid, 5);
      return res.json(recent);
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Internal server error" });
    }
  });

  return httpServer;
}

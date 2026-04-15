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

// ── Stable session user ID ────────────────────────────────────────────────────
// Returns the authenticated user's ID from the session. Protected routes are
// guarded by requireAuth, which ensures userId is always set.
function getSessionUserId(req: any): string {
  return req.session.userId;
}

// ── Auth guard for API routes ─────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.authUsername || !req.session.userId) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
}

const FREE_RUN_LIMIT = 5;

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

const QUESTIONS_MODEL = "gemini-2.5-flash";
const CLEANUP_MODEL = "gemini-2.5-flash";

// Stripe client — only initialized when the secret key is present
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    })
  : null;

// Shared regex patterns used by the checkout CSRF/origin guard
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCALHOST_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const IS_DEVELOPMENT = process.env.NODE_ENV !== "production";

/**
 * Validates that the request `Origin` header is trusted.
 * Returns `true` when the origin is trusted; on failure, sends a 403/500 JSON
 * response and returns `void`.
 * Intended to be used as a CSRF guard on state-mutating checkout endpoints.
 */
function checkOriginTrust(
  req: import("express").Request,
  res: import("express").Response,
): true | void {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "";
  const configuredBaseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
  let configuredBaseOrigin: string | undefined;

  if (configuredBaseUrl) {
    try {
      configuredBaseOrigin = new URL(configuredBaseUrl).origin;
    } catch {
      res.status(500).json({ message: "Application base URL is invalid" });
      return;
    }
  }

  if (!IS_DEVELOPMENT && !allowedOrigin && !configuredBaseOrigin) {
    res.status(500).json({ message: "Allowed origin is not configured" });
    return;
  }

  const isTrusted =
    (allowedOrigin && requestOrigin === allowedOrigin) ||
    (!allowedOrigin && !!configuredBaseOrigin && requestOrigin === configuredBaseOrigin) ||
    (IS_DEVELOPMENT && LOCALHOST_ORIGIN_RE.test(requestOrigin));

  if (!isTrusted) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  return true;
}

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

Feel → Understand → Decide → Do.

A bad prompt jumped straight from Feel to Do. Your job is to surface exactly what is missing in the middle — the Understand and Decide stages — so the rewriter can fill the gaps with precision instead of guessing.

Four stages (for context only):

1. Feel (Alpha) — what arrived raw, unfiltered, no judgment. This is the original user prompt.
2. Understand (Beta) — where fractures live. Assumptions hide here. Missing variables, vague terms, undefined targets.
3. Decide (Gamma) — where commitments lock in. Metrics, trade-offs, constraints, audiences, timeframes.
4. Do (Delta) — final consequence. The AI actually runs the prompt.

Your questions must interrupt the Feel → Do jump and force the user back through Understand and Decide before anything fires.

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

Return ONLY a valid JSON array. No Markdown, no comments, no prose outside the JSON.

Field rules:
- "id": sequential string ("q1", "q2", …).
- "node": one of "alpha", "beta", or "gamma".
- "type": one of "choice", "text", or "weighted-choice".
- "options": include ONLY for "choice" or "weighted-choice" types; 2–5 string options max. Omit entirely for "text".

Example (valid JSON):
[
  {
    "id": "q1",
    "node": "beta",
    "question": "Who is the target audience?",
    "type": "choice",
    "options": ["beginners", "intermediate developers", "senior engineers"]
  },
  {
    "id": "q2",
    "node": "gamma",
    "question": "What will you do with the output?",
    "type": "text"
  }
]`;

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
    "specificity": 8,
    "context": 5,
    "constraints": 3,
    "outputDef": 4,
    "comment": "one sentence: what the original was missing, and what the clarifications + cleanup resolved."
  }
}

Delta scoring rules:
- Each of the four delta scores (specificity, context, constraints, outputDef) is an integer from 0 to 25.
- Score ONLY the ORIGINAL prompt, not your rewrite.
- Most bad prompts should land between 20–50 total (sum of the four scores).
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
  app.post("/api/questions", requireAuth, async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt?.trim()) return res.status(400).json({ message: "Prompt is required" });

      const isPro = req.session.isPro ?? false;
      if (!isPro) {
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let runs = req.session.runs ?? 0;
        const firstRunAt = req.session.firstRunAt
          ? new Date(req.session.firstRunAt).getTime()
          : null;

        if (firstRunAt && now >= firstRunAt + ONE_WEEK_MS) {
          runs = 0;
          req.session.runs = 0;
          req.session.firstRunAt = undefined;
        }

        if (runs >= FREE_RUN_LIMIT) {
          return res.status(402).json({
            message: "Free quota exhausted. Upgrade to Pro or wait for your weekly reset.",
          });
        }
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
      } catch (parseErr: any) {
        console.error("[questions] JSON parse failed.");
        console.error(`[questions] Raw response preview (first 500 chars, total length ${rawText.length}):`, rawText.slice(0, 500));
        console.error(`[questions] Cleaned text preview (first 500 chars, total length ${cleaned.length}):`, cleaned.slice(0, 500));
        console.error("[questions] Parse error:", parseErr?.message ?? parseErr);
        return res.status(500).json({ message: "Failed to parse questions" });
      }

      const runs = (req.session.runs ?? 0) + 1;
      req.session.runs = runs;
      if (!req.session.firstRunAt) {
        req.session.firstRunAt = new Date().toISOString();
      }

      return res.json({ questions });
    } catch (error: any) {
      console.error("Questions error:", error);
      const status = error?.status ?? error?.code;
      const msg = error?.message ?? error?.error?.message ?? "";

      if (status === 429 || String(msg).includes("RESOURCE_EXHAUSTED")) {
        return res.status(429).json({
          message: "Gemini API free quota is exhausted. Please try again later or add billing to your Google project.",
        });
      }
      if (status === 503 || String(msg).includes("UNAVAILABLE")) {
        return res.status(503).json({
          message: "The Gemini model is currently overloaded. Please try again in a minute.",
        });
      }
      return res.status(500).json({ message: msg || "Internal server error" });
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

      const input =
        `${CLEANUP_SYSTEM}\n\n` +
        `Raw prompt: "${prompt.trim()}"` +
        answersBlock;

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
        userId: getSessionUserId(req),
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
      const status = error?.status ?? error?.code;
      const msg = error?.message ?? error?.error?.message ?? "";

      if (status === 429 || String(msg).includes("RESOURCE_EXHAUSTED")) {
        return res.status(429).json({
          message: "Gemini API free quota is exhausted. Please try again later or add billing to your Google project.",
        });
      }
      if (status === 503 || String(msg).includes("UNAVAILABLE")) {
        return res.status(503).json({
          message: "The Gemini model is currently overloaded. Please try again in a minute.",
        });
      }
      return res.status(500).json({ message: msg || "Internal server error" });
    }
  });

  app.get("/api/health", (_req, res) => {
    return res.json({ ok: true, gemini: !!process.env.GEMINI_API_KEY });
  });

  app.get("/api/usage", requireAuth, (req, res) => {
    let runs = req.session.runs ?? 0;
    const isPro = req.session.isPro ?? false;
    const now = new Date();
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    let firstRunAt: Date | null = req.session.firstRunAt
      ? new Date(req.session.firstRunAt)
      : null;

    if (firstRunAt && now.getTime() >= firstRunAt.getTime() + ONE_WEEK_MS) {
      runs = 0;
      req.session.runs = 0;
      firstRunAt = null;
      delete req.session.firstRunAt;
    }

    if (runs > 0 && !firstRunAt) {
      firstRunAt = now;
      req.session.firstRunAt = now.toISOString();
    }

    const resetAt = firstRunAt
      ? new Date(firstRunAt.getTime() + ONE_WEEK_MS).toISOString()
      : undefined;

    return res.json({
      runs,
      limit: FREE_RUN_LIMIT,
      isPro,
      remaining: isPro ? null : Math.max(0, FREE_RUN_LIMIT - runs),
      resetAt,
      monthlyLimit: 100,
      monthlyRemaining: isPro ? Math.max(0, 100 - runs) : null,
    });
  });

  // ── History: only this session's cleanups ─────────────────────────────────
  app.get("/api/history", requireAuth, async (req, res) => {
    try {
      const recent = await storage.getRecentCleanups(getSessionUserId(req), 5);
      return res.json(recent);
    } catch (error: any) {
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  app.post("/api/create-checkout-session", requireAuth, async (req, res) => {
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!stripe || !priceId) {
      return res.status(503).json({ message: "Payments not configured" });
    }

    if (req.session.isPro) {
      return res.status(400).json({ message: "Already subscribed" });
    }

    // CSRF/origin guard
    if (!checkOriginTrust(req, res)) return;

    const configuredBaseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
    const host = req.get("host");
    const isAllowedDevHost = !!host && LOCALHOST_HOST_RE.test(host);
    const baseUrl =
      configuredBaseUrl ??
      (IS_DEVELOPMENT && isAllowedDevHost ? `${req.protocol}://${host}` : undefined);

    if (!baseUrl) {
      return res.status(500).json({ message: "Application base URL is not configured" });
    }

    try {
      // Use a one-time random token as client_reference_id so the actual
      // session ID is never sent to Stripe (dashboard / logs / webhooks).
      const checkoutToken = crypto.randomUUID();
      req.session.checkoutToken = checkoutToken;
      await new Promise<void>((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: checkoutToken,
        success_url: `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/`,
      });

      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("Stripe checkout error:", err);
      return res.status(500).json({
        message: "Unable to create checkout session",
        code: "STRIPE_CHECKOUT_ERROR",
      });
    }
  });

  app.post("/api/verify-checkout", requireAuth, async (req, res) => {
    const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : null;

    if (!sessionId) {
      return res.status(400).json({ message: "session_id is required" });
    }

    if (!/^cs_[A-Za-z0-9_]{10,255}$/.test(sessionId)) {
      return res.status(400).json({ message: "session_id is malformed" });
    }
    if (!stripe) {
      return res.status(503).json({ message: "Payments not configured" });
    }

    // CSRF/origin guard
    if (!checkOriginTrust(req, res)) return;

    // Validate the one-time checkout token stored in the session.
    const checkoutToken = req.session.checkoutToken;
    if (!checkoutToken) {
      return res.status(403).json({ message: "No pending checkout" });
    }

    try {
      const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

      if (checkoutSession.client_reference_id !== checkoutToken) {
        return res.status(403).json({ message: "Session mismatch" });
      }

      if (checkoutSession.status !== "complete") {
        return res.status(402).json({ message: "Payment not completed" });
      }

      const hasSettledPayment =
        checkoutSession.payment_status === "paid" ||
        checkoutSession.payment_status === "no_payment_required";

      let hasActiveSubscription = false;
      if (!hasSettledPayment && checkoutSession.subscription) {
        const subscriptionId =
          typeof checkoutSession.subscription === "string"
            ? checkoutSession.subscription
            : checkoutSession.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        hasActiveSubscription =
          subscription.status === "active" || subscription.status === "trialing";
      }

      if (!hasSettledPayment && !hasActiveSubscription) {
        return res.status(402).json({ message: "Payment not yet settled" });
      }

      // Clear the one-time token before granting Pro access.
      delete req.session.checkoutToken;
      req.session.isPro = true;
      req.session.runs = 0;
      delete req.session.firstRunAt;

      await new Promise<void>((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );

      return res.json({ isPro: true });
    } catch (err: any) {
      console.error("Stripe verify-checkout error:", err);
      return res.status(500).json({ message: "Unable to verify checkout session" });
    }
  });

  return httpServer;
}

export { registerRoutes };

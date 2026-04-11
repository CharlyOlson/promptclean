import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { GoogleGenAI } from "@google/genai";
import Stripe from "stripe";
import type { WeightedAnswer } from "@shared/schema";
import crypto from "crypto";
import { registerAuthRoutes } from "./auth";

// ── Session type augmentation ─────────────────────────────────────────────────
declare module "express-session" {
  interface SessionData {
    runs?: number;
    isPro?: boolean;
    firstRunAt?: string;
    userId?: string;
    authUsername?: string;
    /** One-time token stored when creating a Stripe Checkout Session.
     *  Passed as `client_reference_id`; validated and cleared on verify. */
    checkoutToken?: string;
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

// ── Cost estimation ───────────────────────────────────────────────────────────
// Gemini 2.5 Flash pricing (as of mid-2025): $0.075 / 1M input tokens,
// $0.30 / 1M output tokens. We use a blended rate of ~$0.15 / 1M tokens
// as a conservative estimate when we only have total token counts.
const COST_PER_TOKEN = 0.00000015; // $0.15 per 1M tokens (blended)

function estimateCost(tokensUsed: number): number {
  return parseFloat((tokensUsed * COST_PER_TOKEN).toFixed(8));
}

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

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ── Auth routes ─────────────────────────────────────────────────────────────
  registerAuthRoutes(app);

  // ── Step 1: Generate questions ─────────────────────────────────────────────
  app.post("/api/questions", requireAuth, async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ message: "Prompt is required" });
      }

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

      // ── Log API usage ─────────────────────────────────────────────────────
      const tokensUsed = (response as any).usageMetadata?.totalTokenCount ?? 0;
      storage.logApiUsage({
        userId: getSessionUserId(req),
        endpoint: "questions",
        model: QUESTIONS_MODEL,
        tokensUsed,
        costEstimate: estimateCost(tokensUsed),
      }).catch((err) => console.error("[usage] Failed to log questions usage:", err));

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

  // ── Step 2: Full cleanup with answers ─────────────────────────────────────
  app.post("/api/cleanup", requireAuth, async (req, res) => {
    try {
      const { prompt, answers, weightedAnswers } = req.body;
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ message: "Prompt is required" });
      }

      let answersBlock = "";
      if (answers && typeof answers === "object" && Object.keys(answers).length > 0) {
        answersBlock = "\n\nClarifying answers provided by the user:\n" +
          Object.entries(answers)
            .map(([qid, ans]) => `- ${qid}: ${ans}`)
            .join("\n");
      }
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
      if (IS_DEVELOPMENT) {
        console.log("[cleanup] Raw Gemini response (first 500 chars):", rawText.slice(0, 500));
      }

      const cleaned = rawText
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr: any) {
        console.error("[cleanup] JSON parse failed.");
        console.error(`[cleanup] Raw response preview (first 500 chars, total length ${rawText.length}):`, rawText.slice(0, 500));
        console.error(`[cleanup] Cleaned text preview (first 500 chars, total length ${cleaned.length}):`, cleaned.slice(0, 500));
        console.error("[cleanup] Parse error:", parseErr?.message ?? parseErr);

        const hint = !rawText
          ? "Response was empty"
          : !cleaned
            ? "Response was empty after stripping markdown fences"
            : "Response was not valid JSON";

        return res.status(500).json({
          message: `Failed to parse AI response: ${hint}`,
          hint,
        });
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

      // ── Save cleanup scoped to this session's userId ──────────────────────
      await storage.createCleanup({
        userId: getSessionUserId(req),
        originalPrompt: prompt.trim(),
        fixedPrompt,
        totalScore: score.total,
      });

      // ── Log API usage ─────────────────────────────────────────────────────
      const cleanupTokens = (response as any).usageMetadata?.totalTokenCount ?? 0;
      storage.logApiUsage({
        userId: getSessionUserId(req),
        endpoint: "cleanup",
        model: CLEANUP_MODEL,
        tokensUsed: cleanupTokens,
        costEstimate: estimateCost(cleanupTokens),
      }).catch((err) => console.error("[usage] Failed to log cleanup usage:", err));

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
      const msg = String(error?.message || "");
      if (msg.includes("no such table: cleanups")) {
        console.warn("cleanups table not yet initialized — returning empty history");
        return res.json([]);
      }
      console.error("History error:", error);
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

  // ── Stripe Webhook Handler ─────────────────────────────────────────────────
  // Receives subscription lifecycle events from Stripe and updates the user's
  // isPro status in the session. Requires STRIPE_WEBHOOK_SECRET to be set.
  // Note: express.json() must NOT run before this route — we need the raw body
  // for signature verification. The rawBody is captured in server/index.ts.
  app.post("/api/webhooks/stripe", async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !webhookSecret) {
      return res.status(503).json({ message: "Stripe webhooks not configured" });
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) {
      return res.status(400).json({ message: "Missing stripe-signature header" });
    }

    let event: Stripe.Event;
    try {
      const rawBody = (req as any).rawBody;
      if (!rawBody) {
        return res.status(400).json({ message: "Raw body unavailable" });
      }
      event = stripe.webhooks.constructEvent(rawBody as Buffer, sig, webhookSecret);
    } catch (err: any) {
      console.error("[webhook] Signature verification failed:", err.message);
      return res.status(400).json({ message: `Webhook error: ${err.message}` });
    }

    try {
      switch (event.type) {
        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const isActive =
            subscription.status === "active" || subscription.status === "trialing";
          console.log(
            `[webhook] subscription.updated — customer: ${subscription.customer}, active: ${isActive}`,
          );
          // Session-based isPro is updated at verify-checkout time.
          // Webhook events are logged here for observability; a persistent
          // user store would update the DB record here.
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(
            `[webhook] subscription.deleted — customer: ${subscription.customer}`,
          );
          // When a subscription is cancelled, the user's Pro access should be
          // revoked. With a persistent user store, update isPro = false here.
          break;
        }
        default:
          // Acknowledge unhandled event types without error
          break;
      }

      return res.json({ received: true });
    } catch (err: any) {
      console.error("[webhook] Handler error:", err);
      return res.status(500).json({ message: "Webhook handler failed" });
    }
  });

  // ── API Usage History Dashboard ────────────────────────────────────────────
  // Returns the authenticated user's per-call API usage history so they can
  // see exactly how many tokens each request consumed and what it cost.
  app.get("/api/usage/history", requireAuth, async (req, res) => {
    try {
      const limitParam = req.query.limit;
      const limit = typeof limitParam === "string"
        ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200)
        : 50;

      const history = await storage.getApiUsageHistory(getSessionUserId(req), limit);

      const totalTokens = history.reduce((sum, r) => sum + r.tokensUsed, 0);
      const totalCost = history.reduce((sum, r) => sum + r.costEstimate, 0);

      return res.json({
        records: history,
        summary: {
          totalCalls: history.length,
          totalTokens,
          totalCostUsd: parseFloat(totalCost.toFixed(6)),
        },
      });
    } catch (error: any) {
      console.error("Usage history error:", error);
      return res.status(500).json({ message: error.message || "Internal server error" });
    }
  });

  return httpServer;
}

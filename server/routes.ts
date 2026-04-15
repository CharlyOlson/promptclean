import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import Stripe from "stripe";
import { GoogleGenerativeAI } from "@google/generative-ai";
import multer from "multer";

// ── Clients ────────────────────────────────────────────────────────────────────
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" })
  : null;

const PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
const FREE_RUN_LIMIT = 3;
const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "https://promptclean-production.up.railway.app";

// ── Multer for image uploads ───────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are accepted"));
  },
});

// Middleware that applies multer only when the request is multipart/form-data,
// otherwise passes through so express.json() body is preserved.
function optionalUpload(req: Request, res: Response, next: NextFunction) {
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("multipart/form-data")) {
    return upload.single("image")(req, res, next);
  }
  next();
}

// ── Session usage tracking ─────────────────────────────────────────────────────
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
const GEMINI_MODEL = "gemini-2.5-flash";
const IMAGEN_MODEL = "imagen-3.0-generate-002";

async function geminiText(prompt: string, system: string): Promise<string> {
  const model = genai.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function geminiVision(
  text: string,
  system: string,
  imageBase64?: string,
  imageMime?: string,
  videoUrl?: string
): Promise<string> {
  const model = genai.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
  const parts: any[] = [{ text }];

  if (imageBase64 && imageMime) {
    parts.push({ inlineData: { mimeType: imageMime, data: imageBase64 } });
  }
  if (videoUrl) {
    parts.push({ text: `\n\nVideo URL to analyze: ${videoUrl}` });
  }

  const result = await model.generateContent({ contents: [{ role: "user", parts }] });
  return result.response.text();
}

async function geminiGenerateImage(prompt: string): Promise<string | null> {
  try {
    const model = (genai as any).getGenerativeModel({ model: IMAGEN_MODEL });
    const result = await model.generateImages({
      prompt,
      number_of_images: 1,
      aspect_ratio: "16:9",
    });
    const img = result?.generatedImages?.[0]?.image?.imageBytes;
    if (img) return `data:image/png;base64,${img}`;
    return null;
  } catch (err: any) {
    console.error("Image generation failed (non-fatal):", err.message);
    return null;
  }
}

// ── Build nuance context block for a session ───────────────────────────────────
async function buildNuanceContext(userId: string): Promise<string> {
  const [profile, baseline] = await Promise.all([
    storage.getNuanceProfile(userId),
    storage.getCommunityBaseline(),
  ]);

  const parts: string[] = [];

  if (baseline && baseline.totalCleanups > 0) {
    const top = JSON.parse(baseline.topPatternsJson || "[]")
      .slice(0, 3)
      .map((p: any) => `"${p.tag}" (${p.pct}% of users)`)
      .join(", ");
    if (top) parts.push(`Community baseline — most common failure patterns globally: ${top}.`);
  }

  if (profile && profile.totalRuns >= 3) {
    const personal = JSON.parse(profile.personalPatternsJson || "[]")
      .slice(0, 3)
      .map((p: any) => `"${p.tag}" (${p.count}x)`)
      .join(", ");
    if (personal) {
      parts.push(
        `This specific user's recurring blind spots across ${profile.totalRuns} past cleanups: ${personal}. ` +
        `Their average original score is ${profile.avgScore}/100. ` +
        `Weight your questions and rewrite to address THEIR specific patterns first.`
      );
    }
  }

  return parts.length > 0
    ? "\n\nNUANCE CONTEXT (apply this to personalize your response):\n" + parts.join(" ")
    : "";
}

// ── System prompts ─────────────────────────────────────────────────────────────
const QUESTIONS_SYSTEM = `You are Alpha Node — the Feel stage of a four-step consciousness chain: Feel, Understand, Decide, Do.

A bad prompt skipped from Feel straight to Do. Your job is to surface exactly what got skipped in the middle — the Understand and Decide stages — so the rewriter can fill them in with precision instead of assumption.

The four stages:
1. Feel (Alpha) — what arrived raw, unprocessed, no value assigned. This is what you read.
2. Understand (Beta) — where the fracture lives. Value gets assigned. Assumptions form silently. Ambiguity hides here.
3. Decide (Gamma) — judgment locks in. The parameters are committed.
4. Do (Delta) — consequence is delivered. The final prompt fires.

If an image or video was provided, analyze it and incorporate what you see into your questions.

Rules:
- Ask about the ACTUAL missing variables — not generic filler
- Each question targets a real gap: what kind, for who, by what measure, for what use, when, how much
- Groups: Alpha (what/type), Beta (context/parameters), Gamma (use/purpose)
- 3 to 6 questions total
- The "best" trap: never assume a metric when "best" is stated without one
- Never assume season, occasion, quantity, radius, format, or price range

Return a JSON array:
[{ "id": "q1", "node": "alpha", "question": "text", "type": "choice", "options": ["a","b"] }]

node: "alpha" | "beta" | "gamma". type: "choice" | "text". options: 2-4 items, choice only.
Return only valid JSON. No markdown. No explanation.`;

const CLEANUP_SYSTEM = `You are a 4-node prompt cleanup engine. You receive a raw prompt, clarifying answers, and optionally media context.

Use ALL inputs to eliminate every assumption. Do not guess at anything the answers do not cover.

Also extract a SHORT pattern tag (2-3 words, lowercase, e.g. "missing audience", "no output format", "vague category") describing the single biggest failure in the original prompt.

Return this exact JSON:
{
  "alpha": "one sentence: dominant failure category",
  "beta": "intermediate rewrite incorporating all answers",
  "gamma": {
    "fixedPrompt": "final clean prompt, ready to use",
    "changeLog": ["change 1 — why", "change 2 — why", "change 3 — why"]
  },
  "delta": {
    "specificity": 0,
    "context": 0,
    "constraints": 0,
    "outputDef": 0,
    "comment": "one sentence on transformation"
  },
  "patternTag": "missing audience"
}

Score the ORIGINAL prompt only. 0-25 per axis. Most bad prompts: 20-50 total.
Return only valid JSON. No markdown.`;

// ── Route registration ─────────────────────────────────────────────────────────
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ── Usage ──────────────────────────────────────────────────────────────────
  app.get("/api/usage", (req, res) => {
    const sid = getSession(req, res);
    const u = usageMap.get(sid)!;
    res.json({ runs: u.runs, limit: FREE_RUN_LIMIT, isPro: u.isPro });
  });

  // ── Nuance profile ──────────────────────────────────────────────────────────
  app.get("/api/profile", async (req, res) => {
    try {
      const sid = getSession(req, res);
      const [profile, baseline] = await Promise.all([
        storage.getNuanceProfile(sid),
        storage.getCommunityBaseline(),
      ]);
      res.json({ profile, baseline });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Stripe checkout ─────────────────────────────────────────────────────────
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

  // ── Stripe webhook ──────────────────────────────────────────────────────────
  app.post("/api/webhook", (req: any, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) { res.json({ received: true }); return; }
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
        const ex = usageMap.get(sid) ?? { runs: 0, isPro: false };
        usageMap.set(sid, { ...ex, isPro: true });
      }
    }
    res.json({ received: true });
  });

  // ── Step 1: Questions (supports image upload) ───────────────────────────────
  app.post("/api/questions", optionalUpload, async (req, res) => {
    try {
      const prompt = req.body?.prompt;
      const videoUrl = req.body?.videoUrl;
      if (!prompt?.trim()) return res.status(400).json({ message: "Prompt is required" });
      if (!process.env.GEMINI_API_KEY)
        return res.status(503).json({ message: "GEMINI_API_KEY not configured" });

      const sid = getSession(req, res);
      const nuanceCtx = await buildNuanceContext(sid);

      let imageBase64: string | undefined;
      let imageMime: string | undefined;

      if (req.file) {
        imageBase64 = req.file.buffer.toString("base64");
        imageMime = req.file.mimetype;
      } else if (req.body?.imageBase64 && req.body?.imageMime) {
        imageBase64 = req.body.imageBase64;
        imageMime = req.body.imageMime;
      }

      const hasMedia = !!(imageBase64 || videoUrl);
      const mediaNote = hasMedia
        ? "\n\nMedia was provided alongside this prompt. Analyze it as additional context."
        : "";

      const systemWithNuance = QUESTIONS_SYSTEM + nuanceCtx;
      const input = `Raw prompt: "${prompt.trim()}"${mediaNote}`;

      const raw = await geminiVision(input, systemWithNuance, imageBase64, imageMime, videoUrl);
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      let questions: any[];
      try {
        questions = JSON.parse(cleaned);
        if (!Array.isArray(questions)) throw new Error("not array");
      } catch {
        return res.status(500).json({ message: "Failed to parse questions" });
      }

      return res.json({ questions, hasMedia });
    } catch (err: any) {
      console.error("Questions error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // ── Step 2: Full cleanup + Gemini comparison + image generation ─────────────
  app.post("/api/cleanup", optionalUpload, async (req, res) => {
    try {
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

      const prompt = req.body?.prompt;
      const answers = req.body?.answers ? JSON.parse(req.body.answers) : {};
      const videoUrl = req.body?.videoUrl;
      const generateImage = req.body?.generateImage === "true";

      if (!prompt?.trim()) return res.status(400).json({ message: "Prompt is required" });
      if (!process.env.GEMINI_API_KEY)
        return res.status(503).json({ message: "GEMINI_API_KEY not configured" });

      // Increment usage
      if (!usage.isPro) usageMap.set(sid, { ...usage, runs: usage.runs + 1 });

      let imageBase64: string | undefined;
      let imageMime: string | undefined;
      if (req.file) {
        imageBase64 = req.file.buffer.toString("base64");
        imageMime = req.file.mimetype;
      } else if (req.body?.imageBase64 && req.body?.imageMime) {
        imageBase64 = req.body.imageBase64;
        imageMime = req.body.imageMime;
      }

      const hasImageInput = !!imageBase64;
      const hasVideoInput = !!videoUrl;

      const nuanceCtx = await buildNuanceContext(sid);
      const systemWithNuance = CLEANUP_SYSTEM + nuanceCtx;

      const answersBlock =
        Object.keys(answers).length > 0
          ? "\n\nClarifying answers:\n" +
            Object.entries(answers).map(([k, v]) => `- ${k}: ${v}`).join("\n")
          : "\n\nNo clarifying answers.";

      const mediaNote =
        hasImageInput || hasVideoInput
          ? "\n\nMedia was provided. Incorporate what you observe in it into the rewrite."
          : "";

      const cleanupInput = `Raw prompt: "${prompt.trim()}"${answersBlock}${mediaNote}`;

      // Run cleanup + original Gemini response in parallel
      const [cleanupResult, geminiOriginalResult] = await Promise.allSettled([
        geminiVision(cleanupInput, systemWithNuance, imageBase64, imageMime, videoUrl),
        geminiText(prompt.trim(), "Answer this request helpfully and concisely."),
      ]);

      if (cleanupResult.status === "rejected")
        throw new Error("Cleanup failed: " + cleanupResult.reason?.message);

      const cleanedJson = cleanupResult.value.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      let parsed: any;
      try { parsed = JSON.parse(cleanedJson); }
      catch { return res.status(500).json({ message: "Failed to parse cleanup response" }); }

      const fixedPrompt: string = parsed.gamma?.fixedPrompt ?? parsed.beta ?? "";
      const changeLog: string[] = parsed.gamma?.changeLog ?? [];
      const deltaComment: string = parsed.delta?.comment ?? "";
      const patternTag: string = parsed.patternTag ?? "";
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

      // Run fixed prompt Gemini response + optional image generation in parallel
      const [geminiFixedResult, generatedImageResult] = await Promise.allSettled([
        geminiText(fixedPrompt, "Answer this request helpfully and concisely."),
        generateImage ? geminiGenerateImage(fixedPrompt) : Promise.resolve(null),
      ]);

      const geminiFixed = geminiFixedResult.status === "fulfilled" ? geminiFixedResult.value : "";
      const geminiOriginal = geminiOriginalResult.status === "fulfilled" ? geminiOriginalResult.value : "";
      const generatedImageUrl = generatedImageResult.status === "fulfilled" ? generatedImageResult.value : null;

      // Save cleanup + update nuance profile + refresh community baseline
      await Promise.all([
        storage.createCleanup({
          userId: sid,
          originalPrompt: prompt.trim(),
          fixedPrompt,
          totalScore: score.total,
          failureCategory: parsed.alpha ?? "",
          patternTag,
          scoreJson: JSON.stringify(score),
          hasImageInput,
          hasVideoInput,
          generatedImageUrl: generatedImageUrl ?? undefined,
        }),
        storage.upsertNuanceProfile(sid, patternTag, score.total),
      ]);

      // Refresh community baseline async (fire and forget)
      storage.refreshCommunityBaseline().catch((e) =>
        console.error("Baseline refresh failed:", e.message)
      );

      const currentUsage = usageMap.get(sid)!;

      return res.json({
        score,
        fixedPrompt,
        changeLog,
        deltaComment,
        patternTag,
        nodeOutputs: {
          alpha: parsed.alpha ?? "",
          beta: parsed.beta ?? "",
          gamma: parsed.gamma ?? {},
          delta: parsed.delta ?? {},
        },
        gemini: {
          fixedPromptOutput: geminiFixed,
          originalPromptOutput: geminiOriginal,
        },
        media: {
          generatedImageUrl,
          hasImageInput,
          hasVideoInput,
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
      return res.status(500).json({ message: err.message });
    }
  });

  // ── History ─────────────────────────────────────────────────────────────────
  app.get("/api/history", async (req, res) => {
    try {
      const sid = getSession(req, res);
      const recent = await storage.getRecentCleanups(sid, 5);
      return res.json(recent);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}

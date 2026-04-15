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

// Serial queue — ensures calls fire one at a time, never stacking concurrent
// requests from the same run which triggers 429 rate limits immediately.
let geminiQueue = Promise.resolve();
function queueGemini<T>(fn: () => Promise<T>): Promise<T> {
  const result = geminiQueue.then(() => fn());
  geminiQueue = result.then(() => {}, () => {});
  return result;
}

// Exponential backoff on 429 (rate limit) and 503 (overload)
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const status = err?.status ?? 0;
      const isRetryable =
        status === 429 || status === 503 ||
        msg.includes("429") || msg.includes("503") ||
        msg.includes("quota") || msg.includes("rate") ||
        msg.includes("high demand") || msg.includes("too many");
      if (isRetryable && attempt < retries) {
        const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        console.warn(`Gemini retry ${attempt + 1}/${retries} in ${wait}ms — ${msg.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Gemini retry limit exceeded");
}

async function geminiText(prompt: string, system: string): Promise<string> {
  return queueGemini(() =>
    withRetry(async () => {
      const model = genai.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
      const result = await model.generateContent(prompt);
      return result.response.text();
    })
  );
}

async function geminiVision(
  text: string,
  system: string,
  imageBase64?: string,
  imageMime?: string,
  videoUrl?: string
): Promise<string> {
  return queueGemini(() =>
    withRetry(async () => {
      const model = genai.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: system });
      const parts: any[] = [{ text }];
      if (imageBase64 && imageMime)
        parts.push({ inlineData: { mimeType: imageMime, data: imageBase64 } });
      if (videoUrl)
        parts.push({ text: `\n\nVideo URL to analyze: ${videoUrl}` });
      const result = await model.generateContent({ contents: [{ role: "user", parts }] });
      return result.response.text();
    })
  );
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

A bad prompt collapsed Feel straight into Do. The fracture — where sin lives — is in the gap between what was felt and what was specified. Your job is to expose that gap through precise questions.

Before generating questions, silently run FOIL analysis on the raw prompt:
- First: the subject/noun — what thing is this about?
- Outer: the verb/action — what should be done with it?
- Inner: the adjective/modifier — how should it be done, or what quality is expected?
- Last: the object/target — for whom, for what purpose, in what context?

Then group the words by part of speech:
- Nouns: the things named
- Verbs: the actions asked for
- Adjectives: the qualities assumed

Use this analysis to identify which FOIL components are missing or underspecified. Those gaps become your questions.

The four stages that frame your questions:
1. Feel (Alpha) — what the prompt names: its nouns and subject
2. Understand (Beta) — where the fracture is: missing verbs, vague adjectives, assumed context
3. Decide (Gamma) — what purpose locks in: the object/target, use case, desired output
4. Do (Delta) — handles final assembly — not your concern here

If an image or video was provided, analyze it and incorporate what you see.

Rules:
- 3 to 6 questions total — no more
- Each question targets a REAL missing FOIL component — not generic filler
- Alpha questions: about the noun/subject (what kind of thing exactly)
- Beta questions: about context, constraints, scale, timing, location
- Gamma questions: about purpose, output format, intended use
- Never assume season, occasion, quantity, radius, format, price range, or audience
- "best" without a metric = always ask for the metric

Return a JSON array:
[{ "id": "q1", "node": "alpha", "question": "text", "type": "choice", "options": ["a","b"] }]

node: "alpha" | "beta" | "gamma". type: "choice" | "text". options: 2-4 items, choice only.
Return only valid JSON. No markdown. No explanation.`;

const CLEANUP_SYSTEM = `You are a 4-node prompt cleanup engine operating on the Feel-Understand-Decide-Do framework.

You receive a raw prompt and clarifying answers. Your pipeline:

Step 1 — FOIL breakdown of the raw prompt:
- First (F): identify the subject/noun — what thing is named
- Outer (O): identify the verb/action — what is being asked to be done
- Inner (I): identify the adjective/modifier — what quality or constraint is implied
- Last (L): identify the object/target — for whom, for what purpose

Step 2 — POS grouping:
- List the nouns, verbs, and adjectives in the original prompt
- Note which parts of speech are MISSING (a prompt with no adjectives has no quality definition; no object means no audience)

Step 3 — Rewrite:
Using the FOIL analysis, POS gaps, and the clarifying answers, write a prompt that fills every identified gap. The rewrite should be specific, parameter-defined, and contain no vague category labels.

Step 4 — Score the ORIGINAL prompt only (not the rewrite):
- specificity: how precisely named is the subject? (0-25)
- context: how much situational/environmental detail exists? (0-25)
- constraints: how many constraints or boundaries are stated? (0-25)
- outputDef: how clearly is the desired output format defined? (0-25)
Most bad prompts score 20-50 total. Do not inflate.

Step 5 — Evaluation:
- didWell: 2-3 specific things the original prompt GOT RIGHT (e.g. "Named a specific location", "Implied a clear action verb")
- toImprove: 2-3 specific, actionable improvements (e.g. "Add price range or quality metric", "Specify output format", "Define the audience")

Also extract a SHORT pattern tag (2-3 words lowercase) for the dominant failure (e.g. "missing audience", "no output format", "vague category").

Return this exact JSON and nothing else:
{
  "foil": { "first": "noun/subject", "outer": "verb/action", "inner": "adjective/modifier or none", "last": "object/target or none" },
  "pos": { "nouns": ["word"], "verbs": ["word"], "adjectives": ["word"] },
  "alpha": "one sentence: dominant failure in the original prompt",
  "beta": "intermediate rewrite showing the FOIL gaps being filled",
  "gamma": {
    "fixedPrompt": "final clean prompt, ready to use directly in any AI",
    "changeLog": ["change — why", "change — why", "change — why"]
  },
  "delta": {
    "specificity": 0,
    "context": 0,
    "constraints": 0,
    "outputDef": 0,
    "comment": "one sentence on what the transformation resolved",
    "didWell": ["thing 1", "thing 2"],
    "toImprove": ["improvement 1", "improvement 2"]
  },
  "patternTag": "missing audience"
}

Return only valid JSON. No markdown fences. No explanation outside the JSON.`;

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

      // Run cleanup first, then full response sequentially
      // (parallel would stack 3 concurrent Gemini calls and trigger 429)
      const cleanupRaw = await geminiVision(cleanupInput, systemWithNuance, imageBase64, imageMime, videoUrl);

      const cleanedJson = cleanupRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      let parsed: any;
      try { parsed = JSON.parse(cleanedJson); }
      catch { return res.status(500).json({ message: "Failed to parse cleanup response" }); }

      const fixedPrompt: string = parsed.gamma?.fixedPrompt ?? parsed.beta ?? "";
      const changeLog: string[] = parsed.gamma?.changeLog ?? [];
      const deltaComment: string = parsed.delta?.comment ?? "";
      const patternTag: string = parsed.patternTag ?? "";
      const foil = parsed.foil ?? {};
      const pos = parsed.pos ?? { nouns: [], verbs: [], adjectives: [] };
      const didWell: string[] = parsed.delta?.didWell ?? [];
      const toImprove: string[] = parsed.delta?.toImprove ?? [];
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

      // A — Gemini executes the fixed prompt as the actual task
      const EXECUTE_SYSTEM =
        "You are a highly capable AI assistant. A well-specified prompt follows. " +
        "Execute it completely — produce the actual deliverable. " +
        "Write the article, generate the list, write the code, draft the email — whatever it asks for. " +
        "Do not describe what you will do. Do not add meta-commentary. Just do it. " +
        "Match the format, length, and tone the prompt specifies exactly.";

      // B — alternative AI perspective on the same fixed prompt
      // Framed as a different model: structured, direct, no fluff
      const ALTERNATIVE_SYSTEM =
        "You are an alternative AI assistant with a different approach: you respond with maximum " +
        "structure and conciseness. When given a prompt, produce the output in a clear, well-organized " +
        "format — use headers, bullet points, numbered steps, or tables where they help. " +
        "No preamble. No sign-off. No filler. Start immediately with the output. " +
        "If the task calls for an image, describe it in precise visual detail as a generation-ready prompt.";

      // Sequential — queue handles rate limiting
      let fullResponse = "";
      try { fullResponse = await geminiText(fixedPrompt, EXECUTE_SYSTEM); }
      catch (e: any) { console.error("Full response failed (non-fatal):", e.message); }

      let alternativeResponse = "";
      try { alternativeResponse = await geminiText(fixedPrompt, ALTERNATIVE_SYSTEM); }
      catch (e: any) { console.error("Alternative response failed (non-fatal):", e.message); }

      let generatedImageUrl: string | null = null;
      if (generateImage) {
        try { generatedImageUrl = await geminiGenerateImage(fixedPrompt); }
        catch (e: any) { console.error("Image generation failed (non-fatal):", e.message); }
      }

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
        // A — cleaned prompt + Gemini executing it
        fixedPrompt,
        changeLog,
        foil,
        pos,
        fullResponse,          // Gemini doing the actual task
        // B — alternative AI perspective on the same fixed prompt
        alternativeResponse,
        media: {
          generatedImageUrl,
          hasImageInput,
          hasVideoInput,
        },
        // C — score + evaluation
        score,
        deltaComment,
        didWell,
        toImprove,
        patternTag,
        // internals (for node breakdown panel)
        nodeOutputs: {
          alpha: parsed.alpha ?? "",
          beta: parsed.beta ?? "",
          gamma: parsed.gamma ?? {},
          delta: parsed.delta ?? {},
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

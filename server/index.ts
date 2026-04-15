import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
// Optional safety check for Google Gemini
if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "WARNING: GEMINI_API_KEY is not set. Gemini calls will fail until you add it to your .env (local) or Railway Variables (production).",
  );
  // Do NOT process.exit(1); we still want the server to start.
}

// Resolve the session secret.  In production a missing secret generates a
// random one (sessions are invalidated on restart) and logs a loud warning.
// This is still far safer than a well-known hard-coded fallback string.
const SESSION_SECRET: string = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    const randomSecret = randomBytes(32).toString("hex");
    console.warn(
      "WARNING: SESSION_SECRET is not set in production. A random secret has been generated for this startup — all sessions will be invalidated on every restart. Set SESSION_SECRET in Railway Variables to fix this.",
    );
    return randomSecret;
  }
  return "promptclean-dev-secret";
})();

const app = express();
const httpServer = createServer(app);

// Trust Railway's TLS-terminating proxy so req.secure is correct and
// cookie.secure works properly in production.
app.set("trust proxy", 1);

// CORS — restrict to the configured allowed origin (or same-origin in production).
// When credentials are used, Allow-Origin must be a specific origin, not "*".
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "";

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  const isDev = process.env.NODE_ENV !== "production";

  // Allow the request if:
  //  • an explicit ALLOWED_ORIGIN is configured and matches, OR
  //  • we're in development (any localhost/127 origin is fine)
  const isAllowed =
    (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) ||
    (isDev && (origin === "" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));

  if (isAllowed || origin === "") {
    // Echo the request origin back — required when credentials are involved
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.append("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const SessionStore = MemoryStore(session);

// Warn in production: the in-memory store does not survive restarts or scale-out.
// For reliable quota enforcement across restarts/instances, migrate to a shared
// store such as Redis (connect-redis).
if (process.env.NODE_ENV === "production") {
  console.warn(
    "WARNING: Session store is in-memory. Run metering will reset on server restart and will be inconsistent across multiple instances. Configure a shared store (e.g. Redis) for reliable quota enforcement.",
  );
}

// Use sameSite:"none" (requires secure) when ALLOWED_ORIGIN points to a
// different domain so the session cookie is sent on cross-site fetch requests.
// Fall back to "lax" for same-origin setups (no ALLOWED_ORIGIN configured).
const isCrossOrigin = Boolean(ALLOWED_ORIGIN);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: isCrossOrigin ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    store: new SessionStore({ checkPeriod: 86_400_000 }),
  }),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // Only setup Vite in development, after other routes
  if (process.env.NODE_ENV !== "development") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Serve on PORT (or 5000) for both API and client
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

# PromptClean

A prompt cleanup engine built on a four-step consciousness framework: **Feel → Understand → Decide → Do**.

Most AI prompts fail because the user jumped from Feel straight to Do — skipping the two middle steps where value gets assigned and judgment locks in. PromptClean surfaces exactly what got skipped, asks the right questions, then rewrites with precision.

## The Framework

Sin — in the philosophical sense from the source doc — lives in stages 2 and 3. A bad prompt has the same structure: the fracture is in the parsing, not the asking or the doing.

| Node | Stage | What happens |
|------|-------|--------------|
| Alpha | Feel | Signal read as-is, no value assigned |
| Beta | Understand | Fracture identified, assumptions surfaced |
| Gamma | Decide | Judgment locks in, rewrite committed |
| Delta | Do | Consequence delivered, original scored |

## Stack

- **Frontend**: React + Vite + Tailwind + shadcn/ui
- **Backend**: Express + Node.js
- **Database**: SQLite via Drizzle ORM
- **AI**: Google Gemini 2.5 Flash

## Setup

```bash
npm install
```

Copy the example env file and add your key:
```bash
cp .env.example .env
# then open .env and replace sk-... with your real key
```

Run dev:
```bash
npm run dev
```

Build:
```bash
npm run build
```

## Deploy to Railway

1. Push this repo to GitHub
2. Connect to [railway.app](https://railway.app)
3. Add `GEMINI_API_KEY` as an environment variable
4. Deploy — Railway auto-detects Node.js

> **Note on routing:** The client uses hash-based routing (`/#/path`) via wouter's `useHashLocation`. This is intentional — Railway doesn't guarantee a server-side SPA fallback for deep links, so browser routing would cause 404s on refresh or direct navigation.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Your Google Gemini API key |
| `NODE_ENV` | No | Set to `production` for prod builds |

## Rotating your API key

If your key was exposed or you need to replace it:

**Locally**
1. Open (or create) `.env` in the project root — it is gitignored, so safe to edit.
2. Replace the value of `GEMINI_API_KEY` with a new key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
3. Restart `npm run dev` — the server picks up the new value on boot.

**Railway (production)**
1. Open your project in the [Railway dashboard](https://railway.app).
2. Go to **Variables** (left sidebar).
3. Find `GEMINI_API_KEY`, click the pencil icon, paste the new key, and save.
4. Railway will trigger a redeploy automatically.

---

Built by Scott Olson. Framework from "What is sin?" — *the cost of consciousness*.

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
- **AI**: OpenAI gpt-4o-mini

## Setup

```bash
npm install
```

Create a `.env` file:
```
OPENAI_API_KEY=your_key_here
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
3. Add `OPENAI_API_KEY` as an environment variable
4. Deploy — Railway auto-detects Node.js

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `NODE_ENV` | No | Set to `production` for prod builds |

---

Built by Scott Olson. Framework from "What is sin?" — *the cost of consciousness*.

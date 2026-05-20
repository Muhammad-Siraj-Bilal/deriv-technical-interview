# Customer Support Evaluation Pipeline

This project is a Vercel-deployable Next.js app that runs a replayable customer-support evaluation pipeline with Groq for generation and review, deterministic policy checks in code, a browser-based human override checkpoint, and downloadable JSON/Markdown artifacts.

Live deployment:

- [deriv-technical-interview-p4fn-klbk4wpv4.vercel.app](https://deriv-technical-interview-p4fn-klbk4wpv4.vercel.app/)

## What it does

The app keeps the required pipeline stages in order:

`INIT -> INPUTS_LOADED -> DRAFT_REPLIES_GENERATED -> DETERMINISTIC_CHECKS_COMPLETE -> LLM_REVIEW_COMPLETE -> HUMAN_OVERRIDE_COMPLETE -> FINAL_ROUTING_DECIDED -> REPORT_GENERATED -> VALIDATION_COMPLETE -> RESULTS_FINALISED`

It supports:

- upload or disk-loading of `tickets.json` and `policy.json`
- one Groq generation call per ticket
- deterministic policy checks before final routing
- an optional one-shot repair pass for failed drafts
- one separate Groq review call per ticket
- human overrides in the browser with dropdowns
- final routing decisions and a markdown evaluation report
- artifact downloads for all required JSON/Markdown outputs
- a validation command that regenerates artifacts from disk

## Environment variables

Create a local `.env.local` file from `.env.example` and set:

```bash
GROQ_API_KEY=your_groq_key
LANGCHAIN_API_KEY=
LANGCHAIN_TRACING_V2=false
LANGCHAIN_PROJECT=support-eval-pipeline
```

Notes:

- `GROQ_API_KEY` is required. Generation, repair, and review all use Groq.
- `LANGCHAIN_API_KEY`, `LANGCHAIN_TRACING_V2`, and `LANGCHAIN_PROJECT` are optional and reserved for tracing setups. The app does not require them to run.
- API keys are never hardcoded and are only read from environment variables on the server.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Add your environment variables in `.env.local`.

3. Start the app:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000).

5. Either:

- click `Load sample files from disk` to read the repository `tickets.json` and `policy.json`
- or upload your own equivalent fixtures in the browser

6. Click `Run pipeline`, review the draft/check/review results, adjust any override dropdowns, then click `Apply overrides and finalize`.

7. Download the generated artifacts from the page.

## Validation command

This repo includes a validation command:

```bash
npm run validate
```

It:

- reads `tickets.json` and `policy.json` from disk
- runs the full staged pipeline
- verifies generation and review are separate Groq stages
- checks the deterministic routing logic and report sections
- rewrites the generated artifacts into the project root

`GROQ_API_KEY` must be set before running validation.

## Deploy on Vercel

1. Push the repository to GitHub, GitLab, or Bitbucket.
2. Import the project into Vercel.
3. In Vercel project settings, add these environment variables:

- `GROQ_API_KEY`
- `LANGCHAIN_API_KEY`
- `LANGCHAIN_TRACING_V2`
- `LANGCHAIN_PROJECT`

4. Deploy.

The app uses standard Next.js App Router API routes and does not rely on interactive terminal prompts or persistent local storage, which makes it suitable for Vercel serverless deployment.

## Why Tavily is not needed

Tavily is unnecessary here because the pipeline evaluates replies against the uploaded ticket data and policy file only. No web search or external retrieval step is required to generate, score, route, or report on the support tickets.

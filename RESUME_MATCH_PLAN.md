# Plan: Resume match loop (TaskTide)

Status: plan only, nothing built. 2026-11-18.

## Goal

In TaskTide, score your resume against a job description, list the missing skills, update the resume with the ones you confirm (you approve every change), score again, and repeat until the match is 90% or more.

Decisions made:
- Resume input: you upload a PDF and the service extracts its text. Each new version comes back as text.
- Job input: paste the text, or give a URL. Pasting is the fallback when a site blocks fetching (LinkedIn and most job boards do).
- Standalone for now, with no link to the job applications tracker.
- The work runs in `assistant-node` (Fly) and the screen is in digital-garden. Model: `gemini-2.5-flash`.

## One rule that shapes the design

The loop must never add a skill you don't have. A resume that claims skills you lack hurts you in interviews and background checks, and an AI could reach 90% easily by stuffing keywords. So:
- A missing skill goes into the resume only after you mark it **"I have this"** and add a short detail (where or how you used it).
- The rewrite may only rephrase what is already there and add confirmed items. No new employers, titles, dates, degrees or numbers.
- If the gaps left are skills you don't have, the loop stops and says so ("the best honest match is 78%; missing: Kubernetes, Go") instead of chasing 90%.

## How scoring works (stable and explainable)

A bare "rate this 0–100" from a model jumps around between runs, and you couldn't trust the climb toward 90. Instead:
1. **Requirements, once per job:** the model turns the job description into a fixed list of requirements, each marked must-have or nice-to-have (e.g. "5+ years C#", "AWS", "CI/CD"). The list is saved and reused for every round, so the target never moves.
2. **Check each round:** for each requirement the model answers met, partial or missing, and for met or partial it must quote the resume line that shows it. Code checks that the quote really appears in the resume, and downgrades the item to missing if it doesn't. That catches the model imagining a skill.
3. **Score, calculated in code:** must-have counts 2 and nice-to-have counts 1; met is full credit, partial half, missing zero. Score = earned / possible × 100. Temperature 0.

## The loop

1. Upload the PDF; the extracted text is shown so you can fix extraction mistakes. Paste the job text or a URL.
2. Score version 1. You see the score, each requirement with met, partial or missing, and the evidence.
3. For each missing or partial requirement, choose **"I have this"** (plus a detail) or **"Not me"**.
4. The model proposes a rewritten resume using only the confirmed items. You see the changes side by side and choose **Accept**, **Edit** or **Discard**. Nothing is saved until you accept.
5. The accepted text becomes the next version and is scored again.
6. It stops when the score is ≥ 90, when no confirmable gaps are left (with the honest best score), or after 5 rounds.
7. Copy or download the final text. Every version and its score stay in a history.

## Data (Supabase, row-level security: own rows only)

`resume_matches`: `id`, `user_id`, `title` (guessed role and company), `job_url` (nullable), `job_text`, `requirements` jsonb (`[{id, text, kind: must|nice}]`), `target_score` (default 90), `created_at`, `updated_at`.

`resume_versions`: `id`, `match_id`, `user_id`, `version` (unique per match), `resume_text`, `score`, `results` jsonb (`[{requirementId, status, evidence}]`), `confirmed` jsonb (the items you confirmed for the rewrite that produced this version), `created_at`.

Accessed as the signed-in user with supabase-js, the same way chat saves conversations. The PDF itself is not stored, only its text.

## API (assistant-node, login token required)

| Endpoint | Does |
|---|---|
| `POST /resume/extract` | PDF upload (≤ 5 MB, ≤ 10 pages, must start with `%PDF`) → `{ text }`. Readable error for scanned PDFs with no text layer. |
| `POST /resume/job-text` | `{ url }` → `{ text }`, or `422` "this site blocks automatic reading, paste the text instead". |
| `POST /resume/matches` | `{ resumeText, jobText, jobUrl? }` → builds the requirements, scores version 1 → `{ matchId, version, score, results, missing }`. |
| `POST /resume/matches/:id/rewrite` | `{ confirmed: [{ requirementId, detail }] }` → `{ proposedText }`. Saves nothing. |
| `POST /resume/matches/:id/versions` | `{ resumeText, confirmed }` (the text you accepted, maybe edited) → saves, scores → `{ version, score, results, missing, done, reason }`. |
| `GET /resume/matches`, `GET /resume/matches/:id` | History. |

About 2–3 model calls per round. Limit: 10 model requests per minute per user, with timeouts on every call.

URL fetching safety: http and https only, refuse private and internal addresses (otherwise the service could be pointed at Fly-internal URLs), 10 s timeout, 2 MB cap, HTML reduced to plain text. Job page and resume text are treated as data, not instructions (prompt injection), the same rule as the email text in the daily summary.

## Screen (digital-garden)

A new page `/app/resume-match` with the upload and job input, a score card, the requirements table, the "I have this / Not me" list, a side-by-side change view with Accept, Edit and Discard, a copy or download (`.txt`) button, and the history. The page uses the Node service address from a Vite variable, like the summary does.

## Phases (each ends usable)

1. **Score only:** PDF text extraction (a small library such as `unpdf`, also reusable for the PDF Q&A port), URL fetch, requirements and scoring, the two tables (migration), unit tests with a fake model.
2. **Rewrite loop:** rewrite, versions and the stop rules, plus tests that confirm no unconfirmed skill or new employer appears.
3. **Screen** in digital-garden.
4. **Live run:** your resume against 2–3 real postings; tune the prompts; check that the score is stable when the same version is scored twice.

Later, if wanted: PDF or Word download, a link to the job tracker, a cover letter from the final version.

## Not decided yet

- The 5-round cap and the 2:1 must/nice weights are starting values, to tune after the live run.
- Whether you can remove a requirement you think is irrelevant (it changes the score). Suggested: yes, in phase 3.

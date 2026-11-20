# Plan: Resume match loop (TaskTide)

Status: phases 1 to 3 built and pushed (PR llm-gateway#16, digital-garden#12); roadmap items 1 to 3 merged; items 4 to 8 planned below (8a and 8b built). 2026-11-19.

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

## Roadmap after the first build (market comparison, 2026-11-19)

Compared with Simplify and Jobscan (public help pages; Wonsulting could not be confirmed). What we have that they don't: a quoted piece of evidence for every verdict, a score computed in code, and an honesty guard (only skills the user confirms, no invented numbers or names). Where they are ahead: ATS and formatting checks, rewriting existing bullets, export, tracking jobs, an extension. The seven items below close the gaps that matter, in this order. Each ends usable and keeps the rules above: never add a skill the user did not confirm, the user approves every change, resume text is data and never logged.

| # | Item | Size | Model calls | Status |
|---|---|---|---|---|
| 1 | Realistic, editable target | small | none | merged (#17, digital-garden#13) |
| 2 | Readability (ATS) checks | small | none | merged (#17, digital-garden#13) |
| 3 | Reword existing bullets, with approval | medium | 1 per proposal | merged (#17, digital-garden#13) |
| 4 | Formatted preview and PDF download (old phase 3) | medium | none | planned |
| 5 | Saved matches, history list, "Not me" remembered, link to the job tracker | medium | none | planned |
| 6 | Skill gaps across all saved jobs | small | none | planned |
| 7 | Tailored summary or cover letter | small | 1 per draft | planned |
| 8 | Clean AI traces from the final resume | small to medium | none | 8a to 8c built; 8d and 8e planned (plan below) |

### 1. Realistic, editable target
Why: Simplify suggests about 70% and Jobscan 75%, and both call it their own advice. A fixed 90% pushes people to add things they do not have, which is exactly what the honesty rule is against.
Design: default target 80 (`config/default.json`); `POST /resume/matches` accepts `targetScore` (50 to 100); the screen has a target choice (70, 75, 80, 85, 90) next to the Score button and a line saying the score is feedback, not a prediction of an employer's system. Existing matches keep the target stored on them.

### 2. Readability (ATS) checks
Why: every competitor has some form of "can a machine read this". It costs no model calls.
Design: `formatChecks.ts` runs seven checks on the text of the latest version (email, phone, standard headings, dates, bullet points, length 200 to 1000 words, no column or table look) and returns `{ id, ok, message }`. The view carries `formatChecks`; the screen shows the failing ones with the fix, or "all passed". Separate from the score. Limit to know: it checks the extracted text, not the PDF layout, so a two-column PDF shows up as odd spacing, not as "two columns".

### 3. Reword existing bullets, with approval (built)
Why: the most common gap is "I have it, but not in their words" (a Partial). Simplify+ rewrites bullets to include keywords; we do it with guards.
Built differently from the first sketch: no new endpoint. A Partial requirement the user marks "I have this" (with a note, as before) goes through the same `/rewrite` call. For those items the model is also given the existing line that partly shows the requirement, and may answer with a reworded version of that one line instead of a new bullet. Code (`rewrite.ts`) replaces only the line the evidence came from, keeps its bullet mark, and refuses the reword when it drops a number or name the line had, adds a number or name that is not in the user's own note or the original line (so a requirement's wording cannot smuggle in "AWS" over "Azure"), grows the line by more than half, or is the same line. A refused reword is listed under `skipped` and a new bullet is still used if the model gave one. The screen needed no change: the proposal view already highlights changed lines; accepting goes through the existing versions call.

### 4. Formatted preview and PDF download
Design: a clean, single-column preview rendered from the text (headings, bullets), a "Save as PDF" button using the browser's print dialog with a print stylesheet, so no PDF library and no server work. Later, optional `.docx` through a small library if people ask. Needs a rule for turning plain text into sections; reuse the heading detection from item 2.

### 5. Saved matches and history
Design: the tables already hold everything. Add a list screen (`GET /resume/matches` exists) with title, latest score and date, and reopen a match with its versions (`GET /resume/matches/:id`). Store "Not me" choices on the version (`confirmed` already exists; add a `declined` list). Optional link from a match to a `job_applications` row, which reverses the standalone decision; ask before doing it.

### 6. Skill gaps across jobs
Design: over the user's saved matches, count how often each missing requirement text appears (normalized), and show the top ones ("Kubernetes: missing in 6 of 8 jobs"). Computed from stored `results`, no model calls. Depends on 5.

### 7. Tailored summary or cover letter
Design: one model call that writes a short summary or letter from the final version's text, the job's requirements, and only the skills the user confirmed; the same guards as item 3 (no new numbers or names); shown for review and copied by the user, never sent or saved without a click.

### Not planned
A browser extension (Simplify's main strength) is a separate product with its own review and upkeep. Revisit only if the web page proves too slow a path.

### 8. Clean AI traces from the final resume (plan)
Goal: the resume the user copies or saves should read as their own document: no hidden characters, no typography that only machines produce, no visible marks that show where a line was machine-added. What this is not: an attempt to disguise AI authorship from detectors (no restyling or "humanizing" of the wording). The wording of every added line already comes from the user's own note, and the user approves each line; this item only removes artifacts. An employer that asks whether AI was used should still get an honest answer from the user.

**Where traces come from today**
1. **Hidden or odd characters** in text the model writes (the new bullet, the reworded line, the skill name): zero-width characters, soft hyphens, direction marks, non-breaking and narrow spaces, curly quotes, em and en dashes, the single ellipsis character. They survive copy and paste, break exact matching in applicant systems, and look odd in a plain-text box. PDF text extraction can also bring in soft hyphens and ligature characters from the user's own resume. Today only `tidyText` (spaces and blank lines) and `normalizeForMatch` (only for comparing) touch them.
2. **The fallback heading** "ADDITIONAL EXPERIENCE" (`rewrite.ts`): added when the model's suggested spot is not found. It is the one visibly machine-made structure in the output.
3. **Highlighting** of new lines in the proposal view. UI only, so it is not in the copied text; to be confirmed by a test, and relevant again for item 4.
4. **Export metadata** (item 4): a PDF made through the browser carries the page title and, in the print dialog, a header and footer with the web address and date. Nothing yet because item 4 is not built.

**Design**
- **8a. One cleaning function** (`cleanText.ts`, pure code, no model): removes zero-width characters (U+200B to U+200D, U+2060, U+FEFF), soft hyphen, direction marks, and turns non-breaking and other odd spaces into a plain space. Applied to the PDF text on extraction, to the resume text on start, and to the text the user accepts. Safe on the user's own text because these characters are invisible junk.
- **8b. Plain typography for model-written lines only** (bullets, rewords, skill names): straight quotes, "..." for the ellipsis, and a plain hyphen for em and en dashes. The user's own lines are not restyled. The prompt also tells the model to write plain text; code does not rely on that.
- **8c. No fallback heading (built).** When the suggested spot is not found, the proposal view asks where the line goes: a "Put it under" choice listing the role lines of the resume, with the most recent role first. Code never guesses the employer, because putting a line under the wrong employer would be a false claim (the reason the heading exists today). If the user does not choose, the line is not added. Built as: the rewrite response carries `unplaced` (bullet and requirement) and `roles` (lines that have bullets under them or a date, in resume order); `POST /resume/place-bullet` `{ resumeText, under, bullet }` puts the line at the end of that role's bullets (pure code, no model, nothing saved) and the proposal view then shows the new text.
- **8d. Output check:** a test that the final text (after accept) has none of the characters in 8a and no marker text, and that nothing but the resume text reaches Copy.
- **8e. With item 4:** the print view sets the document title to the person's name and shows a short tip to turn off the browser's header and footer; no "generated by" text anywhere in the page.

**Order and size:** 8a and 8b first (small, pure code with tests, no screen change), then 8c (needs a choice in the proposal view and a small API change: the proposal returns the role lines and the accept call carries the chosen line), then 8d, with 8e when item 4 is built.

**Open questions:** whether to keep curly quotes in the user's own lines (planned: yes, leave them); whether 8c should also let the user move a bullet after the proposal (planned: no, they can edit the text before accepting).

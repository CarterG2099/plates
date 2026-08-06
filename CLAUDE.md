# Plates

Nutrition and workout tracker PWA for two people. Replaces Hevy, and the
food/weight half of Samsung Health.

**Read `DESIGN.md` before making changes.** It holds the schema, the decisions,
and the reasoning behind them. This file covers only how to work in the repo.

## Status

Design approved. **Nothing implemented yet.** No migrations applied, no Edge
Functions deployed, no frontend code.

## Stack

- Vanilla HTML + Alpine.js + JS modules from `docs/`. **No build step.**
- GitHub Pages, public repo, served at `plates.cartergividen.com`.
- supabase-js loaded from jsdelivr, SRI-pinned.
- CSP declared per HTML file via `<meta http-equiv>`.
- CSS layered `tokens → base → components → pages`. Plates has its **own** tokens
  file — it does not share the one recipes and budget use.

Modelled on `~/dev/recipes`, which is the reference implementation for every
pattern here. When unsure how to do something, look at how recipes does it.

## Backend — important

Plates has **no Supabase project of its own.** It lives in the **recipes**
project, under a separate `plates` schema.

Supabase's free plan allows two projects total across all orgs where the user is
Owner or Admin; recipes and budget already use both. This is deliberate, not a
temporary workaround.

Consequences to respect:

- **Never modify `public.*` tables or policies when doing Plates work.** That is
  the recipes app, used by a third person (Carter's mom). Changes there are a
  separate, explicit task.
- Plates policies must **never** reference `public.allowed_emails`. Gate on
  `plates.is_member()`.
- `public.recipes` has `recipes_public_read` set to `qual: true` — world-readable
  with the anon key. **Do not copy that pattern into `plates`.** Food logs and
  body weight are a different sensitivity class.
- The `plates` schema must be in the exposed-schemas list in the Supabase API
  settings for PostgREST to serve it.

The anon key ships in client-side JS. **RLS is the only real security boundary.**
The repo being public is fine and expected; a missing RLS policy is not.

## Non-negotiables

- **Speed is the primary product requirement**, especially the food logger.
  Nothing in the logging path may touch the network. Write to IndexedDB, render
  optimistically, sync in the background.
- **No web fonts from a CDN.** Render-blocking on cold start. System font stack,
  or one self-hosted subset variable font with a preload.
- **No build step.** Do not introduce bundlers, npm scripts, or a framework.
- **Local-first is not optional** and is not a later phase. Writes go to
  IndexedDB first because gyms have bad signal.
- Row ids are **generated on the client** (`uuid`), never server-assigned.
  Deletes are **soft** (`deleted_at`).
- Logged data stores **snapshots** of macros and exercise names, never live
  references. Editing a recipe must not rewrite food-log history.

## Conventions

- SQL functions are `security definer` with `set search_path = ''`, matching the
  existing `is_editor()` / `is_admin()`.
- Anything requiring a secret goes in an Edge Function, never the client.
- Gemini calls use a JSON response schema and return an **unsaved draft for human
  review** — see the existing `import-photo` function.

## Commands

No build, test, or lint tooling yet. Static files are served directly; deploys
are a push to the GitHub Pages branch.

## Related

- `~/dev/recipes` — reference implementation, and the Supabase project host.
- `~/dev/budget` — shares the CSS token architecture.

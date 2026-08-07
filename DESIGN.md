# Plates — Design

Nutrition and workout tracker PWA for two people (Carter + girlfriend). Replaces
Hevy entirely, and the food/weight logging half of Samsung Health.

Status: **design approved, nothing implemented.**

---

## Product constraints

- **Must be free.** No recurring cost, ever.
- **Speed is the primary product requirement**, especially food logging. Friction
  per log entry is the thing that historically breaks consistency. This outranks
  feature completeness.
- **Local-first.** Gyms have bad signal. Writes hit IndexedDB and sync in the
  background. No spinner in the logging path.
- Two users, separate accounts, opt-in mutual visibility.
- Samsung Health scope is **food and weight only**. Explicitly not steps, sleep,
  or heart rate. No Health Connect, no sensor pipeline.

## Decisions

| Decision | Choice |
|---|---|
| App type | PWA (avoids $99/yr Apple + $25 Google fees) |
| Stack | Vanilla HTML + Alpine.js + JS modules, no build step |
| Backend | Existing **recipes** Supabase project, `plates` schema |
| Hosting | GitHub Pages, public repo |
| Domain | `plates.cartergividen.com` (DNS at Porkbun) |
| Auth | Google OAuth, `plates.members` allowlist |
| Sessions | Separate login from recipes (different origin) — accepted |

### Why the recipes Supabase project

Supabase's free plan grants **two projects total**, counted across every
organization where you are Owner or Admin — a second free org does not help.
recipes and budget already use both slots.

But nothing forces one app per project. The recipes database holds 16 rows
against a 500 MB limit. Plates lives there as its own `plates` schema and reuses
infrastructure that already exists: Google OAuth, Edge Functions with the Gemini
key as a secret, and the `keepalive` function that defeats the 7-day free-tier
pause.

Cost of this choice: shared blast radius. A bad migration or a project pause
takes out both apps.

### Access separation

`auth.users` is project-wide and cannot be split, but the boundary needed is
authorization, not authentication:

- **recipes** — Carter, mom, girlfriend. All three author their own recipes.
- **plates** — Carter, girlfriend only. Mom is not in `plates.members`, so every
  Plates query returns zero rows for her.

Plates policies must **never** reference `public.allowed_emails`, and recipes
policies must never reference `plates.members`.

> **Note on existing state:** `recipes_public_read` is `qual: true` — recipes are
> readable by anyone holding the anon key, without logging in. That is acceptable
> for recipes. **Plates tables must not copy this pattern.**

---

## Recipe integration

### Existing recipes model (already implemented, no changes needed)

The desired sharing model already exists in `public.recipes`:

| Policy | Rule |
|---|---|
| `recipes_public_read` | `true` |
| `recipes_editor_insert` | `created_by` must equal own email, or admin |
| `recipes_editor_update` | own rows only, or admin |
| `recipes_editor_delete` | own rows only, or admin |

`is_editor()` is simply "email is in `allowed_emails`". Ownership is by email in
`created_by`.

Consequences:
- Adding the girlfriend to recipes = **one row in `allowed_emails`**, `is_admin`
  false. Write-own is then automatic.
- **Copy-to-fork needs no policy change** — read anyone's row, insert a clone
  stamped with your own email. Pure client-side feature.
- **Filter by author already works**; `created_by` is the email. With three
  people, a hardcoded display-name map beats a profiles table.

### Nutrition on recipes

Nutrition lives on `public.recipes`, not in a Plates table, so mom benefits too
and Plates needs no nutrition table of its own.

```sql
alter table public.recipes
  add column servings_count       numeric,
  add column calories             numeric,
  add column protein_g            numeric,
  add column carbs_g              numeric,
  add column fat_g                numeric,
  add column fiber_g              numeric,
  add column sodium_mg            numeric,
  add column nutrition_source     text check (nutrition_source in ('gemini','manual')),
  add column nutrition_updated_at timestamptz;
```

All values **per serving**. `servings_count` is separate from the existing
`servings` column because that one is free text — it holds `"18"` and `"4"`
today, but nothing prevents `"4-6 servings"`.

No new RLS policies. These are columns on an existing table, so
`recipes_editor_update` already governs them.

### `estimate-nutrition` Edge Function

Mirrors the existing `import-photo` function: `verify_jwt: true`, Gemini key
already a function secret, JSON response schema, and **returns an unsaved draft
rather than writing**.

That review step is the override mechanism. The draft populates editable fields,
you correct anything wrong, saving writes it and sets `nutrition_source`.
Editing a value flips the source to `manual`; re-running the estimator on a
manual row should warn before clobbering it.

The response should include a **per-ingredient breakdown** alongside the totals,
so a wrong number can be traced to the ingredient that caused it.

**Known limitation:** the update policy is owner-scoped, so you cannot fix macros
on mom's 11 recipes. The escape hatch is copy-to-fork. If that becomes annoying,
add a `recipe_nutrition_overrides` table keyed by recipe plus user email — but
not before it actually annoys someone.

---

## Plates schema

The `plates` schema must be added to the exposed-schemas list in the Supabase API
settings, or PostgREST will not serve it.

### Membership

```sql
create schema plates;

create table plates.members (
  email        text primary key,
  display_name text,
  weight_unit  text not null default 'lb' check (weight_unit in ('lb','kg')),
  is_admin     boolean not null default false
);

create function plates.is_member() returns boolean
  language sql security definer set search_path = ''
as $$
  select exists (
    select 1 from plates.members
    where lower(email) = lower(coalesce(auth.email(), ''))
  );
$$;
```

Deliberately identical in shape to the existing `is_editor()`.

### Sync columns on every user-data table

```
id           uuid primary key default gen_random_uuid()
owner_email  text not null default auth.email()
updated_at   timestamptz not null default now()
deleted_at   timestamptz
```

Two of these carry real weight:

- **`id` is generated on the client**, not the server. A row created offline gets
  its permanent id immediately, so there is no temp-id reconciliation on sync.
- **Deletes are soft.** A hard delete cannot propagate to a device that was
  offline when it happened.

Conflict resolution is **last-write-wins on `updated_at`**. Each row has exactly
one owner, almost always edited on one device. Anything more sophisticated is
wasted effort here.

### Food tables

```sql
plates.foods
  id, owner_email (null = shared barcode cache), barcode, name, brand,
  serving_qty, serving_unit,
  calories, protein_g, carbs_g, fat_g, fiber_g, sodium_mg,   -- per serving
  source text  -- 'off' | 'usda' | 'manual' | 'label_photo'

plates.food_log
  id, owner_email, logged_at, meal_slot,
  food_id    uuid   null,   -- provenance only
  recipe_id  bigint null,   -- provenance only
  description text not null,
  quantity, unit,
  calories, protein_g, carbs_g, fat_g, fiber_g, sodium_mg    -- SNAPSHOT

plates.weight_log
  id, owner_email, measured_at, weight_lb, note

plates.meal_combos
  id, owner_email, name, items jsonb   -- one-tap "my usual breakfast"

plates.share_grants
  grantor_email, grantee_email          -- opt-in mutual visibility
```

Barcode cache rows have `owner_email` null, so a product one person scans becomes
available to the other.

The macro columns on `food_log` are a **snapshot written at log time**. This is
what makes keeping `recipe_id` safe — mom editing a recipe next month cannot
retroactively change what you ate today.

### Workout tables

```sql
plates.exercises
  id, owner_email (null = Free Exercise DB shared library),
  name, primary_muscle, secondary_muscles text[],
  equipment, category, instructions jsonb, image_urls text[],
  external_id text   -- id from free-exercise-db, for re-import

plates.routines
  id, owner_email, name, notes

plates.routine_exercises
  id, owner_email, routine_id, exercise_id, position,
  target_sets, target_reps, target_weight_lb, rest_seconds, notes

plates.sessions
  id, owner_email, routine_id null, name, started_at, ended_at, notes

plates.session_sets
  id, owner_email, session_id, exercise_id,
  exercise_name text not null,   -- SNAPSHOT, same reasoning as food_log
  set_index, weight_lb, reps, rpe null, is_warmup bool, completed_at
```

`exercise_name` is snapshotted for the same reason food macros are: renaming or
deleting a custom exercise must not corrupt workout history.

**Weight units.** Stored canonically in **lb** (Postgres `numeric`, exact
decimal). kg is a display-time conversion, selected via
`plates.members.weight_unit`.

A single canonical unit keeps aggregate queries in the stats phase free of
conversion logic. lb is the canonical one because it is what actually gets
entered, so stored values stay exact — 45 lb is 45, not a round-tripped
20.4117 kg. The kg view rounds instead, which is the right place for the loss.

Rest timers, PRs, 1RM estimates and volume are **computed client-side** from
`session_sets`. No tables.

### Indexes

```
food_log     (owner_email, logged_at desc)
foods        (barcode)
session_sets (session_id)
sessions     (owner_email, started_at desc)
```

---

## Making the food logger fast

Barcode scanning is **not** the fast path. You eat the same ~30 foods. Optimizing
for the common case:

- **Nothing in the logging path touches the network.** Write to IndexedDB, render
  optimistically, sync in the background.
- **Sync the whole personal food catalog to IndexedDB at login.** A few hundred
  rows. Search is local and instant, works with no signal. Remote lookup is only
  for foods never eaten before.
- **Recents and frequents** ranked from your own history, rendered on open.
  Target is two taps: tap food, tap log.
- **Quantity defaults to your last-used amount for that food**, not 100 g.
- **Meal slot inferred from the clock**, never picked.
- **Saved combos and copy-yesterday** — one tap logs a whole breakfast.

Because the full log lives in IndexedDB, recents, frequents and last-used
quantity are all computed client-side. Only `meal_combos` needs a table.

This also demotes the biggest technical risk: barcode scanning becomes the cold
path for new foods only, so the `BarcodeDetector` / ZXing split is no longer on
the critical path.

---

## Food data sources

- **Open Food Facts** — primary barcode lookup. Open database, no key, no quota,
  callable directly from the browser.
- **USDA FoodData Central** — fallback. Free key, better US branded coverage.
- ~~FatSecret Platform API~~ — **rejected**, see below. Its terms forbid storing
  nutrition data, which local-first depends on.

> **Unverified:** endpoint shapes, rate limits and terms for all three were not
> reachable for testing during design. Confirm empirically before relying on them.

### FatSecret — evaluated and rejected (2026-08-06)

**Do not revisit without re-reading their terms.** Coverage is genuinely better
than Open Food Facts for US foods, and it still does not matter.

Their [Storable Data](https://platform.fatsecret.com/docs/guides/storable-data)
terms permit caching **identifiers only** — `food_id`, `serving_id`, `recipe_id`.
No nutrition value may be retained beyond 24 hours; everything else "must be
requested from fatsecret each time".

That is incompatible with this app in three places at once:

- `plates.foods` cannot store macros, so there is no local catalogue.
- IndexedDB cannot mirror them, so search cannot be local or offline.
- `food_log` cannot snapshot them — and that snapshot is not an optimisation,
  it is what stops logged history being rewritten when upstream data changes.

Complying means storing `food_id` and re-fetching on render, so the Today screen
would make a network call per logged item. That inverts the entire design.

Second blocker, **confirmed against the OAuth 2.0 guide (2026-08-07)**: fatsecret
"requires that OAuth 2.0 tokens be requested through a proxy server", so "tokens
can only be requested from a finite number of IP addresses". Supabase Edge
Functions provide no stable egress IP to allowlist.

Two qualifications found on re-reading, both narrowing it:

- The restriction covers the **token request only**, not calls made with the
  token. Tokens last 24 hours (`expires_in: 86400`).
- It is specific to OAuth 2.0. fatsecret still documents **OAuth 1.0**, whose
  signed (2-legged) requests are HMAC-signed per call with the shared secret and
  never hit a token endpoint — so there is nothing for the IP rule to apply to.
  The docs do not state an exemption; this is inference from there being no token
  request to restrict. Verify before relying on it.

So the IP rule is avoidable. The Storable Data terms are the blocker that
actually decides this, and they are still the reason to say no.

The original notes below are kept for context.

### FatSecret — original evaluation notes

Coverage is genuinely better than Open Food Facts for US foods, including
restaurant items and generic entries, which is exactly where OFF is weakest. Two
things must be checked first, because either could disqualify it:

1. **It cannot be called from the browser.** It uses OAuth client credentials,
   and credentials cannot ship in client-side JS. It would need an
   `estimate`-style Edge Function proxy. That is acceptable in itself — food
   lookup is the cold path, not the logging path — but it is strictly more work
   than OFF's keyless GET. If the free tier also requires **IP allowlisting**,
   confirm that Supabase Edge Function egress IPs are stable enough to allowlist;
   if they are not, this is a hard blocker.
2. **Check whether the terms permit caching or storing results.** The entire
   speed design depends on persisting foods into `plates.foods` and mirroring
   them into IndexedDB. An API that forbids retaining its data is incompatible
   with local-first, regardless of how good its coverage is.

There is also likely an attribution requirement to display.

Plan: keep OFF as primary since it is keyless and cacheable, and treat FatSecret
as a fallback ahead of USDA **if** point 2 clears.

**Coverage risk:** Open Food Facts is crowd-sourced and patchy on US store brands.
Manual entry and "save as my food" are **core, not polish**. The mitigation is
porting the `import-photo` Gemini pattern — photograph a nutrition label, get a
reviewable draft.

**Exercise data:** Free Exercise DB (`yuhonas/free-exercise-db`), ~800 exercises
with images, public domain.

---

## Barcode scanning — main technical risk

- `BarcodeDetector` is Chromium-only. Android Chrome yes; Safari and Firefox no.
- iOS needs a ZXing fallback via jsdelivr. **Use `@zxing/library`, which is a pure
  JS port, not `zxing-wasm`.** The WASM build would force `'wasm-unsafe-eval'`
  into the CSP; the JS port avoids relaxing the policy at all. Confirm the decode
  rate is acceptable before accepting this tradeoff.
- CSP needs `world.openfoodfacts.org` and `api.nal.usda.gov` in `connect-src`,
  plus `cdn.jsdelivr.net` in `script-src`.
- HTTPS is required for camera. GitHub Pages provides it.

**Camera access itself is considered low risk** — it already works in
`thedomebros` messaging and in recipes' photo import. The remaining unknown is
narrower: those use a still capture, whereas barcode scanning needs a **live
`getUserMedia` video stream with a continuous decode loop**, which is a different
workload for battery, focus and frame throughput in an installed iOS PWA. Worth
one short spike, not a full de-risking phase.

---

## Visual design

Plates gets its **own** tokens file rather than sharing the one recipes and budget
use. New palette, type scale, spacing and radius feel; same
`tokens → base → components → pages` structure underneath.

**Do not load a web font from a CDN.** That is a render-blocking round trip on
every cold start and would add a font host to the CSP `<meta>` in every HTML file.
Use a system font stack, or self-host one subset variable font with a preload.
This is the highest-impact choice for perceived speed.

---

## Phases

0. **Short spike.** Throwaway page: live camera stream, decode a real barcode, hit
   Open Food Facts, print JSON. Camera permission is known to work in an
   installed PWA already; what is being tested is the continuous decode loop and
   the Safari/ZXing fallback path.
1. **Schema + auth** — `plates` schema, OAuth allowlist, share grants, and the
   **local-first sync layer designed here, not deferred**.
2. **Food** — foods, food_log, daily totals. Lookup chain: barcode → OFF → USDA →
   label photo → manual.
3. **Workouts** — exercise library, routines, live session with set logging, rest
   timer, elapsed time.
4. **Stats** — volume, 1RM trend, PRs, weight trend, macro adherence.
5. **PWA shell** — manifest, service worker, install prompt.

The recipes-side change (nutrition columns, `estimate-nutrition`, adding the
girlfriend to `allowed_emails`, copy-to-fork button) is batched to land alongside
phase 2, since that is when Plates starts consuming it.

---

## DNS

GitHub account is `CarterG2099`. At Porkbun, add a CNAME record:

```
host:   plates
answer: carterg2099.github.io
```

Plus a `CNAME` file in the repo containing `plates.cartergividen.com`, and
"Enforce HTTPS" enabled in the repo's Pages settings once the cert issues.

## Supabase configuration

Not derivable from the code, and easy to lose:

- **Exposed schemas** (Settings → API) must include `plates` alongside `public`
  and `graphql_public`. Removing `public` would take recipes down.
- **Redirect URLs** (Authentication → URL Configuration) must include
  `https://plates.cartergividen.com/**` and `http://localhost:8080/**`. The
  `/**` matters: without it the trailing slash fails to match, and Supabase
  silently falls back to **Site URL** — which points at recipes — rather than
  erroring. That failure looks like "sign-in sends me to the wrong app".
- **Site URL** stays pointed at recipes. Plates never depends on it.
- Google Cloud Console needs **nothing** app-specific. Google redirects to
  Supabase's `/auth/v1/callback`, which is per-project and already registered by
  recipes.

## Local development

```bash
python3 -m http.server 8080 --bind 127.0.0.1   # from docs/
```

`localhost` is a secure context, so camera and OAuth both work on the machine
itself. Phone testing still needs HTTPS via Pages.

## Open items

- Continuous barcode decode loop still untested in an installed iOS PWA — and
  deliberately not on the critical path. The scanner captures a single frame on
  a tap instead, which sidesteps it entirely. Revisit only if tapping feels slow.
- USDA barcode lookup is implemented but unexercised: OFF answered every barcode
  tried so far, so the fallback has not actually been needed yet.

## Measured

- **2026-08-06 — Open Food Facts covers US snack brands.** PopCorners Sweet &
  Salty Kettle Corn (`893594002075`) resolved by barcode with complete macros:
  459 kcal, 7.05 P, 74.07 C, 15.87 F, 110 mg sodium per 100 g. This was the
  open coverage risk from the very first design conversation; OFF by barcode is
  the primary path.
- **USDA cannot find store brands by name.** "great value peanut butter" across
  200 results never scored above 3 of 4 terms; the product is not findable. USDA
  is strong for *generic* foods ("Peanut butter, reduced sodium", complete) and
  that is what it is used for. Barcodes are an identity lookup, not a search.
- **Both sources return partial entries routinely.** Nutella has no fiber. Every
  lookup therefore surfaces a "N missing" count and lands in a review form
  before it is saved.
- Shell has no max-width, so it stretches on desktop. Fine on a phone; worth a
  container once there is a real screen to look at.

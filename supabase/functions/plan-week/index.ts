// plan-week — a draft week of meals from the household's recipes, and each
// recipe's ingredients as shopping-list entries.
//
// Two modes, one function because they share the plumbing:
//
//   plan         — picks recipes for the requested slots (5 dinners, say) from
//                  public.recipes, leaning on the household's own recipes, the
//                  main eater's goal and what was eaten lately. Ids only.
//   ingredients  — the free-text ingredient lines of the given recipes, as
//                  {name, qty, unit, staple}, for the client to add up.
//
// The client asks for ingredients separately, after the draft is settled, so
// swapping a meal only asks about the one new recipe.
//
// Like read-food-photo, it never writes: the plan is a draft until accepted in
// the app. Members only, checked with the caller's JWT, which also scopes the
// food_log and goals reads to what that member can see. The Gemini key lives in
// the GEMINI_API_KEY secret.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy of read-food-photo's, not an import: Edge Functions deploy as
// independent bundles, so a path out of this directory does not resolve.
import { askGemini } from "./gemini.ts";
import {
  cleanCounts, cleanIngredients, cleanPlan, cleanRecipeIds, INGREDIENTS_SCHEMA,
  ingredientsPrompt, PLAN_SCHEMA, planPrompt,
} from "./plan-prompt.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 200 with an `error` field for anything the person should read: supabase-js
// hides the body of a non-2xx.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const stripFences = (s: string) =>
  s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

/** An ingredient line as text, whether the jsonb holds strings or objects. */
const lineText = (v: unknown) =>
  typeof v === "string" ? v : String((v as { text?: string; name?: string })?.text ?? (v as { name?: string })?.name ?? "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );

  const { data: isMember } = await supabase.schema("plates").rpc("is_member");
  if (!isMember) return json({ error: "Not a Plates member." }, 403);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "Planning isn't configured yet (missing GEMINI_API_KEY)." }, 503);
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* empty body: caught below */ }

  if (body?.mode === "ingredients") {
    const ids = cleanRecipeIds(body.recipe_ids);
    if (!ids.length) return json({ error: "No recipes to read." }, 400);

    const { data: rows, error } = await supabase
      .from("recipes").select("id, title, ingredients").in("id", ids);
    if (error) return json({ error: error.message });

    const recipes = (rows ?? []).map((r: { id: number; title: string; ingredients: unknown }) => ({
      id: r.id,
      title: r.title,
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map(lineText).filter(Boolean),
    })).filter((r: { ingredients: string[] }) => r.ingredients.length);

    // Recipes with no ingredient lines simply have none to buy.
    if (!recipes.length) return json({ recipes: {} });

    const answer = await askGemini(apiKey, ingredientsPrompt(recipes), [], { schema: INGREDIENTS_SCHEMA, model });
    if ("error" in answer) return json({ error: answer.error });
    try {
      return json({ recipes: cleanIngredients(JSON.parse(stripFences(answer.text)), new Set(ids)) });
    } catch (e) {
      console.error("ingredients parse", String(e));
      return json({ error: "Couldn't read those ingredients — try again." });
    }
  }

  const counts = cleanCounts(body?.counts);
  if (!Object.keys(counts).length) return json({ error: "Pick at least one meal to plan." }, 400);

  const { data: { user } } = await supabase.auth.getUser();
  const me = (user?.email ?? "").toLowerCase();

  // The household: you, and whoever shares with you. RLS returns only grants
  // you are party to.
  const { data: grants } = await supabase.schema("plates").from("share_grants")
    .select("grantor_email, grantee_email");
  const household = new Set([me, ...(grants ?? [])
    .filter((g: { grantee_email: string }) => g.grantee_email?.toLowerCase() === me)
    .map((g: { grantor_email: string }) => g.grantor_email.toLowerCase())]);

  const { data: rows, error } = await supabase.from("recipes")
    .select("id, title, tags, created_by, calories, protein_g, carbs_g, fat_g");
  if (error) return json({ error: error.message });
  if (!rows?.length) return json({ error: "There are no recipes to plan from yet." });

  const recipes = rows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    title: String(r.title ?? ""),
    tags: (r.tags as string[] | null) ?? null,
    mine: household.has(String(r.created_by ?? "").toLowerCase()),
    calories: r.calories == null ? null : Number(r.calories),
    protein_g: r.protein_g == null ? null : Number(r.protein_g),
    carbs_g: r.carbs_g == null ? null : Number(r.carbs_g),
    fat_g: r.fat_g == null ? null : Number(r.fat_g),
  }));

  const today = new Date().toISOString().slice(0, 10);
  const { data: goals } = await supabase.schema("plates").from("goals")
    .select("calorie_target, protein_target_g, starts_on, ends_on")
    .eq("owner_email", me).is("deleted_at", null).lte("starts_on", today)
    .order("starts_on", { ascending: false }).limit(5);
  const goal = (goals ?? []).find((g: { ends_on: string | null }) => !g.ends_on || g.ends_on >= today) ?? null;

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data: eaten } = await supabase.schema("plates").from("food_log")
    .select("description").is("deleted_at", null).eq("is_planned", false).gte("logged_at", since).limit(1000);
  const tally = new Map<string, number>();
  for (const e of eaten ?? []) {
    const name = String((e as { description: string | null }).description ?? "").trim();
    if (name) tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  const recent = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, n]) => `${name} (${n}×)`);

  const answer = await askGemini(apiKey, planPrompt(counts, recipes, goal, recent), [], { schema: PLAN_SCHEMA, model });
  if ("error" in answer) return json({ error: answer.error });

  let meals;
  try {
    meals = cleanPlan(JSON.parse(stripFences(answer.text)), counts, new Set(recipes.map((r) => r.id)));
  } catch (e) {
    console.error("plan parse", String(e));
    return json({ error: "Couldn't make a plan — try again." });
  }
  if (!meals.length) return json({ error: "Couldn't make a plan from these recipes — try again." });
  return json({ meals });
});

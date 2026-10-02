// The meal prompt, apart from the plumbing so tests can import the same source
// Deno runs (see tests/read-food-photo.test.mjs).

// Long enough for "made with Greek yogurt instead of sour cream, from Cafe Rio,
// no rice"; short enough that a pasted essay can't crowd out the instructions.
export const NOTE_MAX = 300;

export const MEAL_PROMPT =
  "You are estimating the nutrition of a meal from a photograph. This is an " +
  "estimate and you should treat it as one.\n\n" +
  "Identify each distinct food you can see and estimate its portion. Judge " +
  "portion size against whatever is in frame for scale — a fork, a standard " +
  "dinner plate is about 27cm, a can is 355ml. Say what you assumed.\n\n" +
  "Be honest about uncertainty rather than splitting the difference. Hidden " +
  "oil, butter, dressings and sauces matter a lot and are usually invisible; " +
  "if a dish looks cooked in fat, say so in the note.\n\n" +
  "Do not imply precision you do not have. Round calories to the nearest 5 and " +
  "macros to the nearest gram.\n\n" +
  "Return ONLY a JSON object with exactly these keys:\n" +
  '{"items": [{"name": string, "portion": string, "calories": number, ' +
  '"protein_g": number, "carbs_g": number, "fat_g": number}], ' +
  '"confidence": "low"|"medium"|"high", "note": string|null, ' +
  '"unreadable": boolean}\n' +
  "portion is your assumed serving in plain words, e.g. \"about 150g, palm-sized\".\n" +
  'confidence is "high" only for simple, clearly visible, unmixed food; ' +
  '"low" whenever portion size is genuinely ambiguous or the dish could hide ' +
  "significant fat. Most mixed dishes are \"low\" or \"medium\".\n" +
  "note is one short sentence naming the biggest thing that could make this " +
  "wrong, or null. Set unreadable to true if there is no food in the picture.";

/** The eater's note as one trimmed line, capped, or null when there isn't one. */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX).trim();
  return s || null;
}

/**
 * The prompt, with the eater's note when they gave one.
 *
 * The note is what the photo can't show — the yogurt in the sauce, the
 * restaurant it came from — so it is stated as fact and outranks what the
 * picture suggests. It goes last so it reads as the final word on the dish, and
 * it is quoted so it reads as their words rather than more instructions.
 */
export function mealPrompt(note?: string | null): string {
  if (!note) return MEAL_PROMPT;
  return MEAL_PROMPT + "\n\n" +
    "The person who ate this added a note about it:\n" +
    `"""${note}"""\n` +
    "Treat what it says about the food as true. It tells you what the photo " +
    "can't: ingredients, how it was cooked, where it came from. Where it " +
    "disagrees with what you would assume from the picture, go with the note. " +
    "If it names a substitute ingredient, estimate with that ingredient. If it " +
    "names a restaurant or brand, use what you know of that place's menu, " +
    "recipes and published nutrition for the dish, and its usual portion when " +
    "the photo doesn't contradict it. Still list each food you can see.";
}

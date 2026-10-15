// pairing.ts — the pure half of watch-pair: making, reading and hashing codes.
// Split out so node --test can import the same source Deno runs.

export const CODE_LENGTH = 8;

// Long enough to walk from the phone to the watch and type eight digits; short
// enough that a code left on screen is dead by the time anyone else sees it.
export const TTL_MS = 5 * 60_000;

// Wrong guesses allowed against the live codes before they are burned. With
// 10^8 possible codes, ten guesses is a one-in-ten-million chance.
export const MAX_FAILURES = 10;

/**
 * Eight uniformly random digits.
 *
 * Rejection sampling rather than `n % 10^8`: 2^32 is not a multiple of 10^8,
 * so a plain modulo makes low codes slightly likelier than high ones.
 */
export function newCode(random: (buf: Uint32Array) => Uint32Array = (b) => crypto.getRandomValues(b)): string {
  const span = 10 ** CODE_LENGTH;
  const limit = Math.floor(2 ** 32 / span) * span;
  const buf = new Uint32Array(1);
  for (;;) {
    const n = random(buf)[0];
    if (n < limit) return String(n % span).padStart(CODE_LENGTH, "0");
  }
}

/** The code as typed — spaces and dashes forgiven — or null if it isn't one. */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const digits = String(input).replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(digits) ? digits : null;
}

/** Stored as a hash so a read of the table is not a list of working codes. */
export async function hashCode(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

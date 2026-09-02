/**
 * supabase.js — shared client, plus the auth helpers the shell needs.
 *
 * The URL and publishable key are public by design: they grant only what RLS
 * allows, and RLS is the real boundary. No secrets live here.
 *
 * Plates uses the modern publishable key rather than the legacy anon JWT that
 * recipes uses, so rotating one app's key can never break the other — both apps
 * share this Supabase project.
 */

const SUPABASE_URL = 'https://hyxttezhchkihuubyprb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_NEfan_kNLH9aZ87Dh5JCWw_WHC0zqkN';

// window.supabase is the UMD build loaded via <script> in each page's <head>.
export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

/**
 * Every Plates table lives in the `plates` schema, which PostgREST will not
 * serve unless it is in the project's exposed-schemas list. Routing all queries
 * through here means no call site can forget the schema and get a confusing 404.
 */
export const db = (table) => supabase.schema('plates').from(table);

export async function signIn() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/**
 * Membership check. `plates.members` is readable only to members, so an empty
 * result means "not invited" — there is no separate permission call to make.
 *
 * Returns { isMember, members, error }. The error is surfaced rather than
 * swallowed because the most likely cause during setup is the `plates` schema
 * not being exposed, and that should say so instead of looking like a rejection.
 */
export async function loadMembership() {
  // photo_pin_hash rides along or the progress-photo lock asks for a brand-new
  // PIN every session — the hash saved fine, it just never came back down.
  const { data, error } = await db('members').select('email, display_name, weight_unit, is_admin, photo_pin_hash');

  if (error) {
    return { isMember: false, members: [], error };
  }
  return { isMember: (data?.length ?? 0) > 0, members: data ?? [], error: null };
}

/** Turn a PostgREST failure into something a human can act on. */
export function describeError(error) {
  if (!error) return '';
  if (error.code === 'PGRST106' || /schema must be one of/i.test(error.message ?? '')) {
    return 'The `plates` schema is not exposed in the Supabase API settings yet.';
  }
  if (error.code === '42501') {
    return 'Signed in, but this account has no access to the Plates schema.';
  }
  return error.message || 'Something went wrong talking to the database.';
}

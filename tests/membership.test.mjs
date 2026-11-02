/**
 * Who counts as "the other person".
 *
 * Being a member and being the other half of the household are different
 * things. A test account is a member with no share grants either way; it must
 * not become anyone's partner or turn up among the people whose training you
 * can browse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const { supabase, loadMembership, markSharing, partnerOf } = await import('../docs/js/supabase.js');

const CARTER = 'cgividen20@gmail.com';
const AANA = 'aanabraithwaite@gmail.com';
const TEST = 'carterhustle20@gmail.com';

// The test account sorts first on purpose: "any member who isn't me" picked it.
const MEMBERS = [
  { email: TEST, display_name: 'Test' },
  { email: CARTER, display_name: 'Carter' },
  { email: AANA, display_name: 'Aana' },
];

// What RLS returns to Carter: only grants he is party to.
const CARTERS_GRANTS = [
  { grantor_email: CARTER, grantee_email: AANA },
  { grantor_email: AANA, grantee_email: CARTER },
];

test('markSharing flags the members who share with this account, and not the test account', () => {
  const marked = markSharing(MEMBERS, CARTERS_GRANTS);
  assert.equal(marked.find((m) => m.email === AANA).sharing, true);
  assert.equal(marked.find((m) => m.email === TEST).sharing, false);
});

test('markSharing ignores the case of the emails', () => {
  const marked = markSharing([{ email: 'Aana@Example.com' }], [{ grantor_email: 'aana@example.com' }]);
  assert.equal(marked[0].sharing, true);
});

test('the partner is Aana for Carter, even with the test account listed first', () => {
  assert.equal(partnerOf(markSharing(MEMBERS, CARTERS_GRANTS), CARTER).display_name, 'Aana');
});

test('the test account has no partner', () => {
  // RLS shows it no grants: nobody shares with it and it shares with nobody.
  assert.equal(partnerOf(markSharing(MEMBERS, []), TEST), undefined);
});

test('a membership cached before the flag existed still finds the partner', () => {
  const cached = [{ email: CARTER, display_name: 'Carter' }, { email: AANA, display_name: 'Aana' }];
  assert.equal(partnerOf(cached, CARTER).display_name, 'Aana');
});

/** Run loadMembership against canned rows per table, and per rpc. */
async function loadWith(tables, rpcs = {}) {
  const real = supabase.schema;
  supabase.schema = () => ({
    from: (table) => ({
      select: async () => tables[table] ?? { data: [], error: null },
    }),
    rpc: async (name) => rpcs[name] ?? { data: [], error: null },
  });
  try {
    return await loadMembership();
  } finally {
    supabase.schema = real;
  }
}

test('loadMembership reads the grants and flags the members', async () => {
  const result = await loadWith({
    members: { data: MEMBERS, error: null },
    share_grants: { data: CARTERS_GRANTS, error: null },
  });
  assert.equal(result.isMember, true);
  assert.equal(result.members.find((m) => m.email === AANA).sharing, true);
  assert.equal(result.members.find((m) => m.email === TEST).sharing, false);
});

test('a failed grants read leaves membership working the way it used to', async () => {
  const result = await loadWith({
    members: { data: MEMBERS, error: null },
    share_grants: { data: null, error: { message: 'boom' } },
  });
  assert.equal(result.isMember, true);
  assert.equal(result.error, null);
  assert.ok(result.members.every((m) => !('sharing' in m)));
});

// Before this, the hash rode along on the members list, so every member could
// read everyone's and try the 10,000 PINs offline.
test('only your own PIN hash comes down, onto your own row', async () => {
  const result = await loadWith(
    { members: { data: MEMBERS, error: null }, share_grants: { data: CARTERS_GRANTS, error: null } },
    { my_photo_pin_hash: { data: [{ email: 'CGividen20@gmail.com', photo_pin_hash: 'abc' }], error: null } },
  );
  assert.equal(result.members.find((m) => m.email === CARTER).photo_pin_hash, 'abc');
  assert.equal(result.members.find((m) => m.email === AANA).photo_pin_hash, undefined);
});

test('a failed PIN read fails the load, rather than asking for a new PIN over the old one', async () => {
  const result = await loadWith(
    { members: { data: MEMBERS, error: null } },
    { my_photo_pin_hash: { data: null, error: { message: 'boom' } } },
  );
  assert.equal(result.error.message, 'boom');
});

test('the schema closes the hash column to the members list and serves only your own', async () => {
  const sql = await readFile(fileURLToPath(new URL('../supabase/schema.sql', import.meta.url)), 'utf8');
  const block = sql.slice(sql.indexOf('-- ---- the photo PIN hash is your own'));
  assert.ok(sql.indexOf('grant select, insert, update, delete on all tables in schema plates to authenticated')
    < sql.indexOf('revoke select on plates.members from authenticated'), 'narrows the schema-wide grant, after it');
  const columns = block.match(/grant select \(([^)]+)\)\s+on plates\.members to authenticated/)?.[1] ?? '';
  assert.ok(columns.includes('display_name') && !columns.includes('photo_pin_hash'), columns);
  assert.match(block, /lower\(m\.email\) = lower\(coalesce\(auth\.email\(\), ''\)\)/);
});

test('the partner label and the training chips both skip members who do not share', async () => {
  const app = await readFile(fileURLToPath(new URL('../docs/js/app.js', import.meta.url)), 'utf8');
  assert.match(app, /partnerOf\(Alpine\.store\('auth'\)\.members, this\.email\)/);
  assert.match(app, /m\.email\.toLowerCase\(\) !== me\.toLowerCase\(\) && m\.sharing !== false/);
});

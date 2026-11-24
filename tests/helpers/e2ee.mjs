/**
 * The two key tables, in memory, behind the stub Supabase client: just enough
 * PostgREST for e2ee.js (select … in / eq … maybeSingle, upsert). Every other
 * table falls through to the usual do-nothing stub.
 */
import * as e2ee from '../../docs/js/e2ee.js';

export function fakeKeyServer(supabase) {
  const tables = { chat_keys: new Map(), chat_key_vault: new Map() };
  const real = supabase.schema.bind(supabase);
  const calls = [];

  supabase.schema = (name) => {
    const inner = real(name);
    return {
      ...inner,
      from(table) {
        if (!tables[table]) return inner.from(table);
        const rows = tables[table];
        let filter = () => true;
        const q = {
          select() { return q; },
          in(col, values) { const set = new Set(values.map((v) => v.toLowerCase())); filter = (r) => set.has(r[col].toLowerCase()); return q; },
          eq(col, value) { filter = (r) => r[col].toLowerCase() === String(value).toLowerCase(); return q; },
          async maybeSingle() { return { data: [...rows.values()].find(filter) ?? null, error: null }; },
          async upsert(row) { calls.push({ table, row }); rows.set(row.owner_email.toLowerCase(), { ...row }); return { data: null, error: null }; },
          then(resolve) { return Promise.resolve({ data: [...rows.values()].filter(filter), error: null }).then(resolve); },
        };
        return q;
      },
    };
  };

  return {
    tables,
    calls,
    /** Put someone else's keys on the "server", as their phone would. Returns their identity. */
    async addPerson(email) {
      const chatKey = e2ee.newChatKey();
      const identity = await e2ee.createIdentity(chatKey);
      await e2ee.publish(email, identity);
      return { ...identity, chatKey };
    },
    restore() { supabase.schema = real; },
  };
}

/**
 * Take an open conversation on the Stats screen to "ready": set this phone up
 * if it has no key, unlock if it needs to, with the partner already set up.
 */
export async function readyChat(page, server, partnerEmail) {
  if (!server.tables.chat_keys.has(partnerEmail.toLowerCase())) await server.addPerson(partnerEmail);
  await page.loadChatCrypto();
  if (page.chatCrypto === 'setup') {
    await page.setUpChatCrypto();
    await page.chatKeySaved();
  }
  if (page.chatCrypto !== 'ready') throw new Error(`chat stuck at ${page.chatCrypto}: ${page.chatCryptoError}`);
}

const test = require('node:test');
const assert = require('node:assert');
const { generateKeyPairSync, createVerify } = require('node:crypto');

test('FCM JWT assertion is a valid RS256 signature', async () => {
  const { assertion, message } = await import('../scripts/push/fcm.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'x@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'p' };
  const jwt = assertion(sa, 1000);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.strictEqual(claims.exp, 4600);
  assert.ok(createVerify('RSA-SHA256').update(h + '.' + c).verify(publicKey, Buffer.from(s, 'base64url')));
  const m = message('T', 'B', 'US:XOM').message;
  assert.strictEqual(m.topic, 'monz-alerts'); assert.strictEqual(m.data.openSignal, 'US:XOM'); assert.strictEqual(m.android.notification.channel_id, 'strong_signals');
});

test('holding alerts fire once per new STRONG action', async () => {
  const { evaluate } = await import('../scripts/push/holdings-alerts.mjs');
  const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const series = days(200).map((d, i) => [d, 100 * (1 + 0.003 * i)]);
  const wl = { holdings: [{ key: 'US:XOM', market: 'US' }], strategies: { US: 'trend' } };
  const uni = { us: { assets: [{ key: 'US:XOM', symbol: 'XOM', name: 'Exxon', series }] } };
  const G = globalThis.Signals, real = G.analyze;
  G.analyze = (i) => ({ ...real(i), action: 'STRONG BUY' });
  try {
    const state = {};
    assert.strictEqual(evaluate(wl, uni, null, state).length, 1);
    assert.strictEqual(evaluate(wl, uni, null, state).length, 0);
    assert.strictEqual(state['US:XOM'], 'STRONG BUY');
  } finally { G.analyze = real; }
});

/* Firebase Cloud Messaging (HTTP v1) sender for GitHub Actions.
 * Needs the repository secret FIREBASE_SERVICE_ACCOUNT: the JSON key of a Google service account
 * with the "Firebase Cloud Messaging API Admin" role (Firebase console → Project settings →
 * Service accounts → Generate new private key). The key never leaves GitHub's secret store. */
import { createSign } from 'node:crypto';

export const TOPIC = 'monz-alerts';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function serviceAccount(env = process.env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT is not a service-account key');
  return sa;
}

/** Signed JWT assertion for Google's OAuth token endpoint (RS256). */
export function assertion(sa, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(header + '.' + claims).sign(sa.private_key);
  return header + '.' + claims + '.' + b64url(sig);
}

async function accessToken(sa) {
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion(sa) });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('token: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

/** FCM message for the app's strong-signal channel; tapping opens the signal (openSignal extra). */
export function message(title, body, key) {
  return { message: { topic: TOPIC, notification: { title, body },
    data: { title, body, key: key || '', openSignal: key || '' },
    android: { priority: 'HIGH', notification: { channel_id: 'strong_signals', icon: 'ic_notify' } } } };
}

export async function send(sa, title, body, key) {
  const token = await accessToken(sa);
  const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(message(title, body, key)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('FCM ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return j.name;
}

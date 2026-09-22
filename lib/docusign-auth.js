const crypto = require('crypto');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Env-var systems (including Netlify's dashboard, in practice) frequently
// mangle multi-line PEM keys: literal "\n" instead of real newlines,
// newlines flattened away entirely, or stray whitespace introduced by
// copy/paste. A PEM key with damaged line structure fails to parse with
// exactly the "DECODER routines::unsupported" error Node/OpenSSL 3 throws
// for a malformed key — indistinguishable, from that error alone, from the
// *different*, already-documented bug where DocuSign's own auto-generated
// key has a real ASN.1 quirk. Rather than guess which one is happening,
// normalize the key unconditionally: strip all whitespace from the body,
// then rebuild a canonical PEM with real newlines and standard 64-char line
// wrapping, regardless of how mangled the input line-breaks were.
function normalizePemKey(raw) {
  const unescaped = raw.replace(/\\n/g, '\n').trim();
  const match = unescaped.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) {
    throw new Error('DOCUSIGN_RSA_PRIVATE_KEY does not look like a PEM key (missing BEGIN/END markers)');
  }
  const label = match[1];
  // Strip anything that isn't a valid base64 character, not just whitespace — copy/paste from
  // some UIs (e.g. n8n's field preview rendering embedded newlines as a literal "|") leaves
  // stray non-whitespace characters inside the body that whitespace-only stripping misses,
  // corrupting the decoded key with no error until OpenSSL rejects it as unparseable.
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = body.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

/**
 * DocuSign JWT Grant, server-to-server auth. Reads the Integration Key, User
 * ID, and RSA private key from environment variables — these are set
 * directly in Netlify's dashboard and never pass through this codebase or
 * any Claude session as literal values.
 *
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
async function getAccessToken() {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const userId = process.env.DOCUSIGN_USER_ID;
  const authBase = process.env.DOCUSIGN_AUTH_BASE_URL || 'https://account-d.docusign.com';
  const privateKeyRaw = process.env.DOCUSIGN_RSA_PRIVATE_KEY;

  if (!integrationKey || !userId || !privateKeyRaw) {
    throw new Error('Missing DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, or DOCUSIGN_RSA_PRIVATE_KEY env var');
  }

  const privateKey = normalizePemKey(privateKeyRaw);
  const authHost = authBase.replace(/^https?:\/\//, '');

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: integrationKey,
    sub: userId,
    aud: authHost,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(`${authBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign OAuth failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

/**
 * Read-only diagnostic: attempts to parse DOCUSIGN_RSA_PRIVATE_KEY as real RSA key material and
 * reports only non-secret structural facts (key size, public-key fingerprint) — never the key
 * itself. Used to tell apart "the stored value isn't actually valid key material" from "it's a
 * valid key that just doesn't match what DocuSign has registered", without ever exposing the
 * private key's content anywhere.
 */
function diagnosePrivateKey() {
  const privateKeyRaw = process.env.DOCUSIGN_RSA_PRIVATE_KEY;
  if (!privateKeyRaw) {
    return { present: false };
  }
  let normalized;
  try {
    normalized = normalizePemKey(privateKeyRaw);
  } catch (err) {
    return { present: true, normalizes: false, error: String(err && err.message ? err.message : err) };
  }
  try {
    const keyObject = crypto.createPrivateKey(normalized);
    const publicKey = crypto.createPublicKey(keyObject);
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
    return {
      present: true,
      normalizes: true,
      parsesAsValidKey: true,
      keyType: keyObject.asymmetricKeyType,
      modulusLengthBits: keyObject.asymmetricKeyDetails && keyObject.asymmetricKeyDetails.modulusLength,
      publicKeySha256Fingerprint: fingerprint,
      rawBodyLength: privateKeyRaw.replace(/\s+/g, '').replace(/^-----BEGIN[^-]*-----|-----END[^-]*-----$/g, '').length,
    };
  } catch (err) {
    return {
      present: true,
      normalizes: true,
      parsesAsValidKey: false,
      error: String(err && err.message ? err.message : err),
      rawBodyLength: privateKeyRaw.replace(/\s+/g, '').replace(/^-----BEGIN[^-]*-----|-----END[^-]*-----$/g, '').length,
    };
  }
}

module.exports = { getAccessToken, diagnosePrivateKey };

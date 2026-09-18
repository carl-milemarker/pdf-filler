const crypto = require('crypto');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
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

module.exports = { getAccessToken };

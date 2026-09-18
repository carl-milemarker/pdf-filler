const { checkOnboardingStatus } = require('../../lib/onboard-async');

exports.handler = async (event) => {
  const jobId = event.httpMethod === 'GET'
    ? (event.queryStringParameters || {}).job_id
    : JSON.parse(event.body || '{}').job_id;

  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Required: job_id (query param on GET, or JSON body on POST)' }) };
  }

  try {
    const result = await checkOnboardingStatus({ jobId });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Job not found', detail: String(err && err.message ? err.message : err) }) };
  }
};

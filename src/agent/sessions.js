import { CORS_HEADERS, jsonResponse, isValidUrl } from '../lib/http.js';

// ============================================================
// POST /agent/sessions/create — Proxy to Beacon edge function
// ============================================================

async function handleAgentSessionCreate(request, env) {
  if (!env.BEACON_SUPABASE_URL || !env.BEACON_ANON_KEY) {
    return jsonResponse({ error: 'Beacon not configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  const agentId = typeof body?.agent_id === 'string' ? body.agent_id.trim() : '';
  const agentModel = typeof body?.agent_model === 'string' ? body.agent_model.trim() : '';
  const referrerUrl = typeof body?.referrer_url === 'string' ? body.referrer_url.trim() : '';
  const productHandle = typeof body?.product_handle === 'string' ? body.product_handle.trim() : '';

  if (!slug) return jsonResponse({ error: 'slug required' }, 400);
  if (!agentId) return jsonResponse({ error: 'agent_id required' }, 400);
  if (agentId.length > 100) return jsonResponse({ error: 'agent_id too long' }, 400);
  if (agentModel && agentModel.length > 100) return jsonResponse({ error: 'agent_model too long' }, 400);
  if (referrerUrl) {
    if (referrerUrl.length > 2048 || !isValidUrl(referrerUrl)) {
      return jsonResponse({ error: 'invalid referrer_url' }, 400);
    }
  }
  if (productHandle && productHandle.length > 200) {
    return jsonResponse({ error: 'product_handle too long' }, 400);
  }

  const forwardBody = { slug, agent_id: agentId };
  if (agentModel) forwardBody.agent_model = agentModel;
  if (referrerUrl) forwardBody.referrer_url = referrerUrl;
  if (productHandle) forwardBody.product_handle = productHandle;

  let upstream;
  try {
    upstream = await fetch(
      `${env.BEACON_SUPABASE_URL}/functions/v1/agent-session-create`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.BEACON_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(forwardBody)
      }
    );
  } catch (err) {
    console.error('handleAgentSessionCreate fetch error:', err);
    return jsonResponse({ error: 'upstream error' }, 502);
  }

  const upstreamBody = await upstream.text();
  return new Response(upstreamBody, {
    status: upstream.status,
    headers: CORS_HEADERS
  });
}

// ============================================================
// GET /agent/sessions/:session_token — Proxy to Beacon edge function
// ============================================================

async function handleAgentSessionLookup(sessionToken, env) {
  if (!env.BEACON_SUPABASE_URL || !env.BEACON_ANON_KEY) {
    return jsonResponse({ error: 'Beacon not configured' }, 503);
  }

  if (typeof sessionToken !== 'string' || sessionToken.length !== 32 || !sessionToken.startsWith('nctr_sess_')) {
    return jsonResponse({ error: 'invalid session_token format' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(
      `${env.BEACON_SUPABASE_URL}/functions/v1/agent-session-lookup?token=${encodeURIComponent(sessionToken)}`,
      {
        headers: {
          Authorization: `Bearer ${env.BEACON_ANON_KEY}`
        }
      }
    );
  } catch (err) {
    console.error('handleAgentSessionLookup fetch error:', err);
    return jsonResponse({ error: 'upstream error' }, 502);
  }

  const upstreamBody = await upstream.text();
  return new Response(upstreamBody, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'private, max-age=10' }
  });
}

export { handleAgentSessionCreate, handleAgentSessionLookup };

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
])

function getCorsOrigin(request) {
  const origin = request.headers.get('Origin')
  return origin || '*'
}

function buildCorsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(request),
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Authorization,Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function buildProxyUrl(request, apiBaseUrl) {
  const url = new URL(request.url)
  const upstream = new URL(apiBaseUrl)
  const apiPath = url.pathname.replace(/^\/api-proxy\/?/, '')
  upstream.pathname = `${upstream.pathname.replace(/\/+$/, '')}/${apiPath}`.replace(/\/{2,}/g, '/')
  upstream.search = url.search
  return upstream.toString()
}

function copyRequestHeaders(request) {
  const headers = new Headers()
  for (const [key, value] of request.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    headers.set(key, value)
  }
  return headers
}

function copyResponseHeaders(response, request) {
  const headers = new Headers()
  for (const [key, value] of response.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    headers.set(key, value)
  }
  const corsHeaders = buildCorsHeaders(request)
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value)
  return headers
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (!url.pathname.startsWith('/api-proxy/')) {
      return env.ASSETS.fetch(request)
    }

    if (!env.API_PROXY_URL) {
      return new Response('Missing API_PROXY_URL', { status: 500 })
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request),
      })
    }

    const upstreamUrl = buildProxyUrl(request, env.API_PROXY_URL)
    const headers = copyRequestHeaders(request)
    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    }

    const upstreamResponse = await fetch(upstreamUrl, init)
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: copyResponseHeaders(upstreamResponse, request),
    })
  },
}

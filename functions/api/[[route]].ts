/**
 * Cloudflare Pages Function that proxies /api/* requests to the
 * Cloud Run backend. The BACKEND_URL environment variable must be
 * set in the Cloudflare Pages dashboard (e.g.
 * "https://route-atlas-api-xxxxxxxxxx-an.a.run.app").
 */

interface Env {
  BACKEND_URL: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const backendBase = context.env.BACKEND_URL;
  if (!backendBase) {
    return new Response(
      JSON.stringify({ error: "BACKEND_URL is not configured" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const url = new URL(context.request.url);
  const backendUrl = new URL(url.pathname + url.search, backendBase);

  const headers = new Headers(context.request.headers);
  // Forward the original host for cookie domain matching
  headers.set("X-Forwarded-Host", url.host);

  const response = await fetch(backendUrl.toString(), {
    method: context.request.method,
    headers,
    body: context.request.body,
    redirect: "manual",
    // Required by Cloudflare Workers when forwarding a ReadableStream body
    duplex: "half",
  } as RequestInit);

  // Rewrite Set-Cookie headers to strip any explicit domain attribute so the
  // cookie defaults to the requesting origin (Pages domain) instead of the
  // Cloud Run backend hostname, which the browser would reject.
  const responseHeaders = new Headers(response.headers);
  // Cloudflare Workers Headers expose getAll() for set-cookie
  const cookies = (
    response.headers as unknown as { getAll(name: string): string[] }
  ).getAll("set-cookie");
  if (cookies.length > 0) {
    responseHeaders.delete("set-cookie");
    for (const cookie of cookies) {
      const rewritten = cookie.replace(/;\s*domain=[^;]*/gi, "");
      responseHeaders.append("set-cookie", rewritten);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

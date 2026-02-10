import { requirePassword, type PasswordEnv } from "@bob/security";

export type Env = PasswordEnv;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function routeNotFound(): Response {
  return json(404, { error: "Not found" });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  console.log(
    JSON.stringify({
      event: "request.received",
      method,
      path: url.pathname
    })
  );

  if (method === "GET" && url.pathname === "/healthz") {
    return json(200, {
      ok: true,
      service: "control-worker"
    });
  }

  if (url.pathname.startsWith("/v1/")) {
    const unauthorized = requirePassword(request, env, { allowCookie: true });
    if (unauthorized) {
      return unauthorized;
    }

    if (method === "GET" && url.pathname === "/v1/ping") {
      return json(200, {
        ok: true,
        message: "pong"
      });
    }

    return routeNotFound();
  }

  return routeNotFound();
}

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;

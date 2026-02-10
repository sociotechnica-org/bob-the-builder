export type Env = Record<string, never>;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method.toUpperCase() === "GET" && url.pathname === "/healthz") {
      return json(200, {
        ok: true,
        service: "queue-consumer-worker"
      });
    }

    return json(404, { error: "Not found" });
  },

  async queue(batch: MessageBatch<unknown>): Promise<void> {
    console.log(
      JSON.stringify({
        event: "queue.batch.received",
        size: batch.messages.length
      })
    );
  }
} satisfies ExportedHandler<Env>;

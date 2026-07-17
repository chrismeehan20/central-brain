import type { FastifyInstance } from "fastify";
import type { AttentionItem, ProjectDetail } from "@shared/types.js";
import { bus } from "../events/bus.js";
import { getAttentionItems } from "../alert/attention.js";

const HEARTBEAT_MS = 25_000;

export async function streamRoutes(app: FastifyInstance) {
  app.get("/api/stream", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("attention", getAttentionItems());

    const onUpdate = (items: AttentionItem[]) => send("attention", items);
    bus.on("attention:update", onUpdate);

    const onDetail = (payload: { path: string; detail: ProjectDetail }) => send("detail", payload);
    bus.on("detail:update", onDetail);

    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), HEARTBEAT_MS);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      bus.off("attention:update", onUpdate);
      bus.off("detail:update", onDetail);
    });
  });
}

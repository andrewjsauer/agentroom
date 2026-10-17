import { Room } from "./room.js";

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  IDLE_TTL_SEC?: string;
  MAX_AGE_SEC?: string;
  BUFFER_SIZE?: string;
  MAX_MEMBERS?: string;
  MAX_ROOM_CONNS_PER_IP?: string;
  RATE_BURST?: string;
  RATE_PER_SEC?: string;
  CLOSE_GRACE_MS?: string;
  /** Tests only: "1" enables GET /__inspect?room=<id>, which dumps the room's storage. */
  TEST_INSPECT?: string;
}

const ROOM_ID = /^[0-9a-f]{64}$/;

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const room = url.searchParams.get("room");
    const upgrade = req.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const inspect = env.TEST_INSPECT === "1" && url.pathname === "/__inspect";
    if (!upgrade && !inspect) {
      return new Response("agentroom relay: connect with a WebSocket\n", {
        status: 426,
      });
    }
    // The Durable Object is picked before `hello`, so the room id rides in the URL (M4 KTD8).
    if (!room || !ROOM_ID.test(room)) {
      return new Response("missing or invalid room\n", { status: 400 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
  },
} satisfies ExportedHandler<Env>;

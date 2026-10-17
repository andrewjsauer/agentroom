import { Room } from "./room.js";

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** WebSocket upgrades per client address; the limit and period are in wrangler.jsonc `ratelimits`. */
  UPGRADE_LIMITER: RateLimit;
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

const refuse = (status: number, text: string) =>
  new Response(`${text}\n`, { status });

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const room = url.searchParams.get("room");
    const upgrade = req.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const inspect = env.TEST_INSPECT === "1" && url.pathname === "/__inspect";
    if (!upgrade && !inspect) {
      return refuse(426, "agentroom relay: connect with a WebSocket");
    }
    if (upgrade) {
      // Real clients are Node processes and send no Origin; a browser page always does.
      if (req.headers.has("Origin")) {
        return refuse(403, "browser origins are refused");
      }
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await env.UPGRADE_LIMITER.limit({ key: ip })).success) {
        return refuse(429, "too many connections from your address; slow down");
      }
    }
    // The Durable Object is picked before `hello`, so the room id rides in the URL (M4 KTD8).
    if (!room || !ROOM_ID.test(room)) {
      return refuse(400, "missing or invalid room");
    }
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
  },
} satisfies ExportedHandler<Env>;

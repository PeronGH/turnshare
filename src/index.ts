import { DurableObject } from "cloudflare:workers";

const ROOM_PATH = /^\/api\/room\/([A-Za-z0-9_-]{16,64})$/;
const TURN_TTL_SECONDS = 12 * 60 * 60;

export class Room extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keepalive pings are answered by the runtime without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(): Promise<Response> {
		const peers = this.ctx.getWebSockets("peer");
		const [client, server] = Object.values(new WebSocketPair());

		if (peers.length >= 2) {
			this.ctx.acceptWebSocket(server, ["rejected"]);
			server.close(4409, "room full");
		} else {
			this.ctx.acceptWebSocket(server, ["peer"]);
			for (const peer of peers) peer.send(JSON.stringify({ type: "peer-joined" }));
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		for (const peer of this.ctx.getWebSockets("peer")) {
			if (peer !== ws) peer.send(message);
		}
	}

	webSocketClose(ws: WebSocket) {
		if (!this.ctx.getTags(ws).includes("peer")) return;
		for (const peer of this.ctx.getWebSockets("peer")) {
			if (peer !== ws) peer.send(JSON.stringify({ type: "peer-left" }));
		}
	}
}

async function turnCredentials(env: Env): Promise<Response> {
	const res = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
		},
	);
	return new Response(res.body, {
		status: res.status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/api/turn" && request.method === "GET") {
			return turnCredentials(env);
		}

		const room = ROOM_PATH.exec(pathname);
		if (room) {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}
			return env.ROOM.getByName(room[1]).fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

# Turnshare

Peer-to-peer file transfer in the browser. Files go directly between browsers over WebRTC, relayed through [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/) when a direct connection isn't possible. A Cloudflare Worker hands out TURN credentials, and a Durable Object relays signaling over WebSockets. File data never touches the server.

There is no built-in auth; put the app behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).

## Usage

1. Open the app, pick files, and click **Create link**.
2. Share the link (`https://your-domain/#crumb-ivory`) or just the two-word code. Keep the page open.
3. The receiver opens the link, or enters the code under **Have a code?**. The transfer starts automatically.

## Setup

Create a TURN key in the Cloudflare dashboard (Realtime → TURN), then:

```sh
bun install
cp .dev.vars.example .dev.vars   # fill in TURN_KEY_ID and TURN_KEY_API_TOKEN
bun run dev                      # local development
bunx wrangler deploy
bunx wrangler secret bulk .dev.vars
```

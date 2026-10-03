const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024;
const KEEPALIVE_MS = 30_000;
const DOWNLOAD_INTERVAL_MS = 300;
const MAX_RECONNECT_DELAY_MS = 10_000;
const ICE_RESTART_DELAY_MS = 2_000;
const CODE_WORDS = 2;
const CODE_PATTERN = /^[a-z]+-[a-z]+$/;

function randomWord() {
	// Rejection sampling keeps the pick uniform across a non-power-of-two list.
	const limit = 65536 - (65536 % WORDS.length);
	const buf = new Uint16Array(1);
	do crypto.getRandomValues(buf);
	while (buf[0] >= limit);
	return WORDS[buf[0] % WORDS.length];
}

function randomCode() {
	return Array.from({ length: CODE_WORDS }, randomWord).join("-");
}

function normalizeCode(input) {
	return input.trim().toLowerCase().split(/[\s-]+/).join("-");
}

function formatBytes(bytes) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	while (bytes >= 1000 && i < units.length - 1) {
		bytes /= 1000;
		i++;
	}
	return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function selectedRoute(pc) {
	const stats = await pc.getStats();
	const values = [...stats.values()];
	const transport = values.find((s) => s.type === "transport" && s.selectedCandidatePairId);
	const pair = transport
		? stats.get(transport.selectedCandidatePairId)
		: values.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
	if (!pair) return "";
	const relayed = [pair.localCandidateId, pair.remoteCandidateId].some(
		(id) => stats.get(id)?.candidateType === "relay",
	);
	return relayed ? "relayed via TURN" : "direct";
}

document.addEventListener("alpine:init", () => {
	// Native WebRTC/WebSocket objects live outside Alpine's reactive proxies.
	let ws, pc, channel, keepalive, iceServers, session, restartTimer;
	let socketAttempts = 0;
	let socketRetries = 0;
	// Receiver: this page's identity. Sender: the receiver currently being served.
	let peerId;
	let selected = [];
	let signalQueue = Promise.resolve();
	let manifest = [];
	let fileIndex = 0;
	let parts = [];
	let partBytes = 0;

	Alpine.data("app", () => ({
		roomId: location.hash.slice(1),
		role: location.hash.length > 1 ? "receiver" : "sender",
		files: [],
		codeInput: "",
		link: "",
		copied: "",
		status: "",
		error: "",
		busy: false,
		route: "",
		total: 0,
		transferred: 0,
		done: false,
		downloads: [],
		formatBytes,

		init() {
			if (this.role === "receiver") this.run(() => this.connect());
		},

		run(task) {
			Promise.resolve()
				.then(task)
				.catch((err) => this.fail(err));
		},

		fail(err) {
			this.error = err instanceof Error ? err.message : String(err);
			this.busy = false;
			this.closePeer();
		},

		setStatus(status, busy = false) {
			this.status = status;
			this.busy = busy;
		},

		join() {
			const code = normalizeCode(this.codeInput);
			if (!CODE_PATTERN.test(code)) {
				this.error = "A code is two words, like crumb-ivory.";
				return;
			}
			history.replaceState(null, "", `#${code}`);
			this.error = "";
			this.roomId = code;
			this.role = "receiver";
			this.run(() => this.connect());
		},

		pick(event) {
			selected = [...event.target.files];
			this.files = selected.map(({ name, size }) => ({ name, size }));
		},

		share() {
			this.roomId = randomCode();
			this.link = `${location.origin}${location.pathname}#${this.roomId}`;
			this.run(() => this.connect());
		},

		async copy(what, text) {
			await navigator.clipboard.writeText(text);
			this.copied = what;
		},

		async connect() {
			this.setStatus("Connecting…", true);
			const res = await fetch("/api/turn");
			if (!res.ok) throw new Error(`Failed to get TURN credentials (${res.status})`);
			({ iceServers } = await res.json());
			if (this.role === "receiver") peerId = crypto.randomUUID();
			this.openSocket();
		},

		openSocket() {
			const scheme = location.protocol === "https:" ? "wss" : "ws";
			const socket = (ws = new WebSocket(`${scheme}://${location.host}/api/room/${this.roomId}`));
			const firstAttempt = ++socketAttempts === 1;

			socket.onopen = () => {
				socketRetries = 0;
				keepalive = setInterval(() => socket.send("ping"), KEEPALIVE_MS);
				if (!pc) {
					this.setStatus(
						this.role === "sender" ? "Waiting for the receiver to open the link…" : "Waiting for the sender…",
						true,
					);
				}
				if (this.role === "receiver") this.send({ type: "ready", peerId });
			};
			socket.onmessage = ({ data }) => {
				if (data === "pong") return;
				const msg = JSON.parse(data);
				this.enqueue(() => this.signal(msg));
			};
			socket.onclose = ({ code }) => {
				clearInterval(keepalive);
				// A reconnect can briefly hit "room full" until the room notices our old socket is gone.
				if (code === 4409 && firstAttempt) return this.fail("This link is already in use.");
				if (this.role === "receiver" && this.done) return;
				if (!this.peerConnected()) this.setStatus("Reconnecting to the signaling server…", true);
				const delay = Math.min(1000 * 2 ** socketRetries++, MAX_RECONNECT_DELAY_MS);
				setTimeout(() => this.openSocket(), delay);
			};
		},

		send(msg) {
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		},

		enqueue(task) {
			signalQueue = signalQueue.then(task).catch((err) => this.fail(err));
		},

		peerConnected() {
			return pc?.connectionState === "connected";
		},

		// Signaling: the sender always offers. The receiver announces itself with "ready" whenever its
		// socket (re)connects or the sender (re)joins. A "session" identifies one RTCPeerConnection pair.
		async signal(msg) {
			switch (msg.type) {
				case "peer-joined":
					if (this.role === "receiver") this.send({ type: "ready", peerId });
					break;
				case "ready":
					if (msg.peerId === peerId && channel?.readyState === "open") {
						await this.restartIfStale();
					} else {
						peerId = msg.peerId;
						await this.offerNewPeer();
					}
					break;
				case "peer-left":
					// The other side's socket dropping doesn't matter while WebRTC is still up.
					if (this.peerConnected()) break;
					if (this.role === "sender") {
						this.closePeer();
						peerId = undefined;
						this.setStatus("Waiting for the receiver to open the link…", true);
					} else if (!this.done) {
						this.setStatus("The sender disconnected. Waiting for them to come back…", true);
					}
					break;
				case "description":
					if (this.role === "receiver") {
						if (msg.session !== session) this.startPeer(msg.session);
						await pc.setRemoteDescription(msg.description);
						await pc.setLocalDescription();
						this.send({ type: "description", session, description: pc.localDescription });
					} else if (msg.session === session && pc.signalingState === "have-local-offer") {
						await pc.setRemoteDescription(msg.description);
					}
					break;
				case "candidate":
					if (msg.session !== session) break;
					// Candidates from before an ICE restart are rejected; that's expected.
					await pc.addIceCandidate(msg.candidate).catch(() => {});
					break;
			}
		},

		async offerNewPeer() {
			this.startPeer(crypto.randomUUID());
			await pc.setLocalDescription();
			this.send({ type: "description", session, description: pc.localDescription });
		},

		async restartIfStale() {
			if (!pc || this.peerConnected() || channel?.readyState !== "open") return;
			// A previous restart offer may have been lost while signaling was down.
			if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
			pc.restartIce();
			await pc.setLocalDescription();
			this.send({ type: "description", session, description: pc.localDescription });
		},

		startPeer(newSession) {
			this.closePeer();
			session = newSession;
			this.error = "";
			this.done = false;
			this.route = "";
			this.setStatus("Establishing peer connection…", true);

			const peer = (pc = new RTCPeerConnection({ iceServers }));
			peer.onicecandidate = ({ candidate }) => {
				if (candidate) this.send({ type: "candidate", session: newSession, candidate });
			};
			peer.onconnectionstatechange = () => {
				if (peer === pc) this.onConnectionState();
			};

			const ch = (channel = peer.createDataChannel("files", { negotiated: true, id: 0 }));
			ch.binaryType = "arraybuffer";
			ch.bufferedAmountLowThreshold = HIGH_WATER_MARK / 4;
			ch.onopen = () => {
				if (this.role === "sender") this.run(() => this.sendFiles());
				else this.setStatus("Receiving…", true);
			};
			ch.onmessage = ({ data }) => this.receive(data);
			ch.onclose = () => {
				if (ch !== channel || this.done) return;
				// The data channel can't be recovered; start over with a fresh connection.
				this.setStatus("Connection lost, reconnecting…", true);
				if (this.role === "sender") this.enqueue(() => this.offerNewPeer());
			};
		},

		onConnectionState() {
			clearTimeout(restartTimer);
			switch (pc.connectionState) {
				case "connected":
					selectedRoute(pc).then((route) => (this.route = route));
					if (!this.done && channel.readyState === "open") {
						this.setStatus(this.role === "sender" ? "Sending…" : "Receiving…", true);
					}
					break;
				case "disconnected":
				case "failed":
					if (!this.done) this.setStatus("Connection interrupted, reconnecting…", true);
					if (this.role === "sender") {
						// "disconnected" often recovers on its own; give it a moment before restarting ICE.
						const delay = pc.connectionState === "failed" ? 0 : ICE_RESTART_DELAY_MS;
						restartTimer = setTimeout(() => this.enqueue(() => this.restartIfStale()), delay);
					}
					break;
			}
		},

		closePeer() {
			clearTimeout(restartTimer);
			channel?.close();
			pc?.close();
			channel = pc = session = undefined;
		},

		async sendFiles() {
			const ch = channel;
			this.total = selected.reduce((sum, file) => sum + file.size, 0);
			this.transferred = 0;
			this.setStatus("Sending…", true);

			ch.send(
				JSON.stringify({
					type: "manifest",
					files: selected.map(({ name, size, type }) => ({ name, size, type })),
				}),
			);
			for (const file of selected) {
				for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
					if (ch.bufferedAmount > HIGH_WATER_MARK) {
						await new Promise((resolve) => {
							ch.addEventListener("bufferedamountlow", resolve, { once: true });
							ch.addEventListener("close", resolve, { once: true });
						});
					}
					const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
					// The channel closed mid-transfer; its close handler takes over.
					if (ch.readyState !== "open") return;
					ch.send(chunk);
					this.transferred += chunk.byteLength;
				}
			}
			this.setStatus("Waiting for the receiver to confirm…", true);
		},

		receive(data) {
			if (typeof data === "string") {
				const msg = JSON.parse(data);
				if (msg.type === "manifest") {
					manifest = msg.files;
					this.downloads = [];
					fileIndex = 0;
					parts = [];
					partBytes = 0;
					this.total = manifest.reduce((sum, file) => sum + file.size, 0);
					this.transferred = 0;
					this.completeFiles();
				} else if (msg.type === "done") {
					this.done = true;
					this.setStatus("Delivered. Keep this page open to send to someone else.");
				}
				return;
			}

			parts.push(data);
			partBytes += data.byteLength;
			this.transferred += data.byteLength;
			this.completeFiles();
		},

		completeFiles() {
			while (fileIndex < manifest.length && partBytes === manifest[fileIndex].size) {
				const { name, size, type } = manifest[fileIndex];
				const url = URL.createObjectURL(new Blob(parts, { type }));
				this.downloads.push({ name, size, url });
				parts = [];
				partBytes = 0;
				fileIndex++;
			}
			if (fileIndex === manifest.length) {
				this.done = true;
				channel.send(JSON.stringify({ type: "done" }));
				this.setStatus("Done. Click a file to save it.");
			}
		},

		async downloadAll() {
			for (const { name, url } of this.downloads) {
				const link = Object.assign(document.createElement("a"), { href: url, download: name });
				link.click();
				// Browsers drop rapid back-to-back downloads; space them out.
				await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_INTERVAL_MS));
			}
		},
	}));
});

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024;
const KEEPALIVE_MS = 30_000;
const DOWNLOAD_INTERVAL_MS = 300;
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
	let ws, pc, channel, keepalive, iceServers;
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
		copied: false,
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

		async copy() {
			await navigator.clipboard.writeText(this.link);
			this.copied = true;
		},

		async connect() {
			this.setStatus("Connecting…", true);
			const res = await fetch("/api/turn");
			if (!res.ok) throw new Error(`Failed to get TURN credentials (${res.status})`);
			({ iceServers } = await res.json());

			const scheme = location.protocol === "https:" ? "wss" : "ws";
			ws = new WebSocket(`${scheme}://${location.host}/api/room/${this.roomId}`);
			ws.onopen = () => {
				keepalive = setInterval(() => ws.send("ping"), KEEPALIVE_MS);
				if (this.role === "sender") this.setStatus("Waiting for the receiver to open the link…", true);
				else this.setStatus("Waiting for the sender…", true);
			};
			ws.onmessage = ({ data }) => {
				if (data === "pong") return;
				const msg = JSON.parse(data);
				signalQueue = signalQueue.then(() => this.signal(msg)).catch((err) => this.fail(err));
			};
			ws.onclose = ({ code }) => {
				clearInterval(keepalive);
				if (code === 4409) this.fail("This link is already in use.");
				else if (!this.done) this.fail("Lost connection to the signaling server.");
			};
		},

		send(msg) {
			ws.send(JSON.stringify(msg));
		},

		async signal(msg) {
			switch (msg.type) {
				case "peer-joined":
					this.startPeer();
					await pc.setLocalDescription();
					this.send({ type: "description", description: pc.localDescription });
					break;
				case "peer-left":
					if (this.role === "sender") {
						this.closePeer();
						this.setStatus("Waiting for the receiver to open the link…", true);
					} else if (!this.done) {
						this.fail("The sender left.");
					}
					break;
				case "description":
					if (msg.description.type === "offer") this.startPeer();
					await pc.setRemoteDescription(msg.description);
					if (msg.description.type === "offer") {
						await pc.setLocalDescription();
						this.send({ type: "description", description: pc.localDescription });
					}
					break;
				case "candidate":
					await pc.addIceCandidate(msg.candidate);
					break;
			}
		},

		startPeer() {
			this.closePeer();
			this.error = "";
			this.done = false;
			this.route = "";
			this.setStatus("Establishing peer connection…", true);

			const peer = (pc = new RTCPeerConnection({ iceServers }));
			peer.onicecandidate = ({ candidate }) => {
				if (candidate) this.send({ type: "candidate", candidate });
			};
			peer.onconnectionstatechange = () => {
				if (peer !== pc) return;
				if (peer.connectionState === "connected") {
					selectedRoute(peer).then((route) => (this.route = route));
				} else if (peer.connectionState === "failed" && !this.done) {
					this.fail("Peer connection failed.");
				}
			};

			channel = peer.createDataChannel("files", { negotiated: true, id: 0 });
			channel.binaryType = "arraybuffer";
			channel.bufferedAmountLowThreshold = HIGH_WATER_MARK / 4;
			channel.onopen = () => {
				if (this.role === "sender") this.run(() => this.sendFiles());
				else this.setStatus("Receiving…", true);
			};
			channel.onmessage = ({ data }) => this.receive(data);
		},

		closePeer() {
			channel?.close();
			pc?.close();
			channel = pc = undefined;
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
					// The receiver may have left mid-transfer; the room handler already reset the UI.
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

export class PartyCall {
    constructor({ base, socket, signal, presence, update, notice, selfId, settings }) {
        Object.assign(this, { base, socket, signal, presence, update, notice, selfId, settings });
        this.peers = new Map(); this.stream = new MediaStream(); this.camera = false; this.microphone = false;
        this.localVideo = document.createElement('video'); this.localVideo.muted = true; this.localVideo.playsInline = true; this.localVideo.dataset.party = 'true';
        this.localVideo.srcObject = this.stream;
        this.canvas = document.createElement('canvas'); this.canvas.width = 480; this.canvas.height = 270;
        this.lastSpeaking = false; this.closed = false;
        this.frameTimer = setInterval(() => this.sendFrame(), 170);
        this.voiceTimer = setInterval(() => this.checkVoice(), 100);
    }
    async audio() {
        if (!this.context) {
            this.context = new AudioContext({ latencyHint: 'interactive' });
            this.workletReady = this.context.audioWorklet.addModule(this.base + 'audio-worklet.js');
        }
        await this.context.resume();
    }
    async toggle(kind) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require HTTPS and a supported browser.');
        const enabled = kind === 'video' ? this.camera : this.microphone;
        if (enabled) {
            for (const t of this.stream.getTracks().filter(t => t.kind === kind)) { t.stop(); this.stream.removeTrack(t); }
            if (kind === 'audio') this.detachCapture();
        } else {
            const result = await navigator.mediaDevices.getUserMedia(kind === 'video'
                ? { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 } }, audio: false }
                : { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
            if (this.closed) { result.getTracks().forEach(t => t.stop()); return; }
            for (const track of result.getTracks()) { this.stream.addTrack(track); track.onended = () => this.refreshTracks().catch(e => this.notice(e.message)); }
            if (kind === 'audio') { await this.audio(); await this.attachCapture(); }
        }
        await this.refreshTracks();
    }
    async refreshTracks() {
        this.camera = this.stream.getVideoTracks().some(t => t.readyState === 'live');
        this.microphone = this.stream.getAudioTracks().some(t => t.readyState === 'live');
        if (!this.microphone) this.lastSpeaking = false;
        this.localVideo.srcObject = this.stream;
        this.localVideo.play().catch(() => {});
        for (const p of this.peers.values()) if (p.pc) {
            for (const kind of ['audio', 'video']) {
                const transceiver = p.transceivers[kind];
                if (transceiver) await transceiver.sender.replaceTrack(this.stream.getTracks().find(t => t.kind === kind && t.readyState === 'live') || null);
            }
        }
        this.publish(); this.update(this.selfId, { stream: this.stream, camera: this.camera, microphone: this.microphone, speaking: this.lastSpeaking, self: true });
    }
    publish() { this.presence({ camera: this.camera, microphone: this.microphone, speaking: this.lastSpeaking }); }
    async attachCapture() {
        this.detachCapture();
        await this.workletReady;
        this.source = this.context.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
        this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512;
        this.capture = new AudioWorkletNode(this.context, 'party-capture');
        this.silence = this.context.createGain(); this.silence.gain.value = 0;
        this.source.connect(this.analyser); this.source.connect(this.capture); this.capture.connect(this.silence); this.silence.connect(this.context.destination);
        this.capture.port.onmessage = event => { if (this.microphone) this.sendPacket(2, new Uint8Array(event.data)); };
    }
    detachCapture() { for (const key of ['source', 'capture', 'analyser', 'silence']) { this[key]?.disconnect(); this[key] = null; } }
    checkVoice() {
        let speaking = false;
        if (this.microphone && this.analyser) {
            const samples = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
            if (rms > 0.025) this.spokeAt = Date.now();
            speaking = Date.now() - (this.spokeAt || 0) < 500;
        }
        if (speaking !== this.lastSpeaking) { this.lastSpeaking = speaking; this.publish(); this.update(this.selfId, { speaking }); }
    }
    add(id) {
        if (id === this.selfId || this.peers.has(id)) return;
        const p = { id, mode: 'connecting', transceivers: {}, nextAudio: 0, volume: 1, sources: new Set(), ice: [], makingOffer: false, ignoreOffer: false };
        this.peers.set(id, p);
        const pc = new RTCPeerConnection({ iceServers: this.settings.stunUrl ? [{ urls: this.settings.stunUrl }] : [] }); p.pc = pc;
        for (const kind of ['audio', 'video']) {
            const track = this.stream.getTracks().find(t => t.kind === kind && t.readyState === 'live');
            p.transceivers[kind] = pc.addTransceiver(track || kind, { direction: 'sendrecv', streams: [this.stream] });
        }
        pc.createDataChannel('party-ready');
        pc.onicecandidate = e => { if (e.candidate) this.signal(id, { candidate: e.candidate.toJSON() }); };
        p.remoteStream = new MediaStream();
        pc.ontrack = event => {
            if (!p.remoteStream.getTracks().some(t => t.id === event.track.id)) p.remoteStream.addTrack(event.track);
            if (event.track.kind === 'audio' && this.context) {
                p.remoteAudio?.disconnect();
                if (!p.gain) { p.gain = this.context.createGain(); p.gain.gain.value = p.volume; p.gain.connect(this.context.destination); }
                p.remoteAudio = this.context.createMediaStreamSource(new MediaStream([event.track]));
                p.remoteAudio.connect(p.gain);
            }
            this.update(id, { stream: p.remoteStream, mode: p.mode });
        };
        pc.onnegotiationneeded = async () => {
            try { p.makingOffer = true; await pc.setLocalDescription(); this.signal(id, { description: pc.localDescription }); }
            catch (e) { if (!this.closed && p.mode !== 'relay') this.notice('Direct call negotiation failed; trying the tunnel relay.'); this.fallback(id); }
            finally { p.makingOffer = false; }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') { clearTimeout(p.timeout); p.mode = 'p2p'; this.update(id, { mode: 'p2p' }); }
            if (['failed', 'disconnected'].includes(pc.connectionState)) this.fallback(id);
        };
        p.timeout = setTimeout(() => this.fallback(id), 9000);
    }
    async receiveSignal(id, data) {
        const p = this.peers.get(id); if (!p) return;
        if (data.relay) { await this.fallback(id, false); return; }
        const pc = p.pc; if (!pc || p.mode === 'relay') return;
        try {
            if (data.description) {
                const collision = data.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
                p.ignoreOffer = this.selfId < id && collision;
                if (p.ignoreOffer) return;
                await pc.setRemoteDescription(data.description);
                for (const candidate of p.ice.splice(0)) await pc.addIceCandidate(candidate);
                if (data.description.type === 'offer') { await pc.setLocalDescription(); this.signal(id, { description: pc.localDescription }); }
            } else if (data.candidate && !p.ignoreOffer) {
                if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else p.ice.push(data.candidate);
            }
        } catch { await this.fallback(id); }
    }
    async relay() {
        if (this.closed) return;
        if (this.media?.readyState === WebSocket.OPEN) return;
        if (this.relayPromise) return this.relayPromise;
        this.relayPromise = (async () => {
            const ws = await this.socket('media', this.selfId); if (this.closed) { ws.close(); return; }
            this.media = ws; ws.binaryType = 'arraybuffer';
            ws.onmessage = event => this.receivePacket(event.data);
            ws.onclose = () => {
                if (this.media === ws) this.media = null;
                if (!this.closed && [...this.peers.values()].some(p => p.mode === 'relay')) {
                    clearTimeout(this.relayRetry);
                    this.retryRelay();
                }
            };
        })();
        try { await this.relayPromise; } finally { this.relayPromise = null; }
    }
    async fallback(id, notify = true) {
        const p = this.peers.get(id); if (!p || this.closed || p.mode === 'relay') return;
        clearTimeout(p.timeout);
        if (!this.settings.enableRelay) { p.mode = 'unavailable'; this.update(id, { mode: 'unavailable' }); return; }
        p.remoteAudio?.disconnect(); p.remoteAudio = null;
        p.mode = 'relay'; if (p.pc) { p.pc.onconnectionstatechange = null; p.pc.close(); p.pc = null; }
        this.update(id, { mode: 'relay', stream: null });
        if (notify) this.signal(id, { relay: true });
        try { await this.relay(); } catch (e) { this.notice('Tunnel call relay disconnected: ' + e.message); this.retryRelay(); }
    }
    retryRelay() {
        clearTimeout(this.relayRetry);
        if (!this.closed) this.relayRetry = setTimeout(() => this.relay().catch(() => this.retryRelay()), 2000);
    }
    async sendFrame() {
        if (!this.camera || this.encoding || !this.localVideo.videoWidth || ![...this.peers.values()].some(p => p.mode === 'relay')) return;
        this.encoding = true;
        try {
            this.canvas.getContext('2d').drawImage(this.localVideo, 0, 0, 480, 270);
            const blob = await new Promise(resolve => this.canvas.toBlob(resolve, 'image/jpeg', 0.55));
            if (blob && blob.size <= 64000) this.sendPacket(1, new Uint8Array(await blob.arrayBuffer()));
        } finally { this.encoding = false; }
    }
    sendPacket(kind, data) {
        const ws = this.media; if (ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 100000) return;
        for (const p of this.peers.values()) if (p.mode === 'relay') {
            if (ws.bufferedAmount > 200000) break;
            const packet = new Uint8Array(45 + data.length); packet[0] = kind;
            packet.set(new TextEncoder().encode(p.id), 1); new DataView(packet.buffer).setFloat64(37, Date.now(), true); packet.set(data, 45); ws.send(packet);
        }
    }
    receivePacket(buffer) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 46) return;
        const bytes = new Uint8Array(buffer); const id = new TextDecoder().decode(bytes.subarray(1, 37));
        const p = this.peers.get(id); if (!p || p.mode !== 'relay') return;
        if (bytes[0] === 1) {
            const url = URL.createObjectURL(new Blob([bytes.subarray(45)], { type: 'image/jpeg' }));
            this.update(id, { image: url }); if (p.image) URL.revokeObjectURL(p.image); p.image = url;
        } else if (bytes[0] === 2 && this.context?.state === 'running') {
            const count = (bytes.length - 45) / 2; if (!Number.isInteger(count) || count > 1024) return;
            const audio = this.context.createBuffer(1, count, 16000); const data = audio.getChannelData(0); const view = new DataView(buffer);
            for (let i = 0; i < count; i++) data[i] = view.getInt16(45 + i * 2, true) / 32768;
            if (!p.gain) { p.gain = this.context.createGain(); p.gain.connect(this.context.destination); }
            p.gain.gain.value = p.volume;
            // Bound the jitter queue: never accumulate seconds of old conversation.
            if (p.nextAudio > this.context.currentTime + 0.25) return;
            const start = Math.max(this.context.currentTime + 0.04, p.nextAudio);
            const source = this.context.createBufferSource(); source.buffer = audio; source.connect(p.gain); p.sources.add(source);
            source.onended = () => { source.disconnect(); p.sources.delete(source); }; source.start(start); p.nextAudio = start + audio.duration;
        }
    }
    volume(id, value) { const p = this.peers.get(id); if (p) { p.volume = value; if (p.gain) p.gain.gain.value = value; } }
    remove(id) {
        const p = this.peers.get(id); if (!p) return;
        clearTimeout(p.timeout); if (p.pc) { p.pc.onconnectionstatechange = null; p.pc.close(); }
        for (const source of p.sources) { try { source.stop(); } catch {} source.disconnect(); }
        p.remoteAudio?.disconnect(); p.gain?.disconnect(); if (p.image) URL.revokeObjectURL(p.image); this.peers.delete(id);
        this.update(id, { removed: true });
    }
    async close() {
        this.closed = true; clearInterval(this.frameTimer); clearInterval(this.voiceTimer); clearTimeout(this.relayRetry);
        for (const id of [...this.peers.keys()]) this.remove(id);
        this.stream.getTracks().forEach(t => t.stop()); this.detachCapture(); this.media?.close(); this.localVideo.srcObject = null;
        if (this.context) await this.context.close();
    }
}

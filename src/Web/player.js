// Jellyfin 12.1 integration: observe its public API client's playback reports,
// then issue ordinary session commands so native transcoding seeks still work.
export class JellyfinPlayer {
    constructor(api, request, onControl, onNotice) {
        this.api = api; this.request = request; this.onControl = onControl; this.notice = onNotice;
        this.report = null; this.offset = 0; this.suppressUntil = 0; this.roomItem = null;
        this.serverOffset = 0; this.bestRtt = Infinity; this.state = null; this.sessionId = null;
        this.restore = []; this.generation = 0;
        for (const method of ['reportPlaybackStart', 'reportPlaybackProgress', 'reportPlaybackStopped']) {
            const original = api[method];
            if (typeof original !== 'function') continue;
            const wrapper = (...args) => {
                this.observe(method, args[0]);
                return original.apply(api, args);
            };
            api[method] = wrapper;
            this.restore.push(() => { if (api[method] === wrapper) api[method] = original; });
        }
        this.seekHandler = e => {
            if (e.target !== this.video() || !this.roomItem || Date.now() < this.suppressUntil) return;
            // Native reports refresh the transcoding offset during source changes.
            clearTimeout(this.seekTimer);
            this.seekTimer = setTimeout(() => {
                if (Date.now() >= this.suppressUntil && this.report?.ItemId?.replaceAll('-', '') === this.roomItem?.replaceAll('-', '')) this.onControl('seek', this.position());
            }, 350);
        };
        document.addEventListener('seeked', this.seekHandler, true);
        this.timer = setInterval(() => this.correct().catch(e => this.notice(e.message)), 1500);
    }
    video() { return [...document.querySelectorAll('video')].find(v => !v.dataset.party && (v.currentSrc || v.src)); }
    position() { const v = this.video(); return Math.max(0, v ? v.currentTime + this.offset : (this.report?.PositionTicks || 0) / 1e7); }
    observe(method, info) {
        if (!info) return;
        const before = this.report;
        this.report = { ...info };
        const v = this.video();
        if (v && Number.isFinite(info.PositionTicks)) this.offset = info.PositionTicks / 1e7 - v.currentTime;
        if (!this.roomItem) return;
        if (method === 'reportPlaybackStopped') { if (Date.now() >= this.suppressUntil) this.notice('Playback stopped. Use “Rejoin playback” to return to the party.'); return; }
        if (info.ItemId?.replaceAll('-', '') !== this.roomItem.replaceAll('-', '')) return;
        if (Date.now() < this.suppressUntil) return;
        if (info.EventName === 'pause') this.onControl('pause', this.position());
        else if (info.EventName === 'unpause') this.onControl('play', this.position());
        else if (method === 'reportPlaybackStart' && before?.ItemId === info.ItemId) {
            // A native seek may restart the transcode instead of firing DOM seeked.
            const delta = Math.abs((info.PositionTicks || 0) / 1e7 - (before.PositionTicks || 0) / 1e7);
            if (delta > 3) this.onControl('seek', this.position());
        }
    }
    pong(clientTime, serverTime) {
        const rtt = Date.now() - clientTime;
        if (rtt >= 0 && rtt < this.bestRtt + 20) { this.bestRtt = rtt; this.serverOffset = serverTime + rtt / 2 - Date.now(); }
    }
    async session() {
        if (this.sessionId) return this.sessionId;
        const sessions = await this.request('Sessions', { deviceId: this.api.deviceId() });
        const session = sessions.find(s => s.DeviceId === this.api.deviceId() && s.UserId?.replaceAll('-', '') === this.api.getCurrentUserId()?.replaceAll('-', ''));
        if (!session) throw new Error('Jellyfin has not registered this player yet. Start the movie once, then join the party.');
        this.sessionId = session.Id; return session.Id;
    }
    async start(itemId, timeline) {
        this.roomItem = itemId; this.state = timeline; this.suppressUntil = Date.now() + 7000;
        const generation = ++this.generation;
        const id = await this.session();
        if (generation !== this.generation) return;
        if (this.report?.ItemId?.replaceAll('-', '') === itemId.replaceAll('-', '') && this.video()) {
            this.roomItem = this.report.ItemId;
        } else {
            await this.request(`Sessions/${id}/Playing`, { playCommand: 'PlayNow', itemIds: itemId, startPositionTicks: Math.round(this.target(timeline) * 1e7) }, 'POST');
        }
        clearTimeout(this.initialTimer);
        this.initialTimer = setTimeout(() => { this.suppressUntil = 0; this.correct(true).catch(e => this.notice(e.message)); }, 2200);
    }
    target(s = this.state) {
        if (!s) return 0;
        return Math.min(s.duration, Math.max(0, s.position + (s.paused ? 0 : Math.max(0, Date.now() + this.serverOffset - s.serverTime) / 1000)));
    }
    update(state) {
        if (this.state && state.revision < this.state.revision) return;
        const changed = !this.state || state.revision !== this.state.revision;
        this.state = state;
        if (changed) this.correct(true).catch(e => this.notice(e.message));
    }
    async command(command, seconds) {
        const id = await this.session();
        await this.request(`Sessions/${id}/Playing/${command}`, seconds == null ? {} : { seekPositionTicks: Math.round(seconds * 1e7) }, 'POST');
    }
    async correct(force = false) {
        const v = this.video(), state = this.state;
        if (!state || !this.roomItem || !v || this.busy || Date.now() < this.suppressUntil || !this.report || this.report.ItemId?.replaceAll('-', '') !== this.roomItem.replaceAll('-', '')) return;
        this.busy = true;
        try {
            if (v.paused !== state.paused) {
                this.suppressUntil = Date.now() + 1400;
                await this.command(state.paused ? 'Pause' : 'Unpause');
            }
            const delta = this.target(state) - this.position();
            if ((force && Math.abs(delta) > 0.65) || Math.abs(delta) > 2.5) {
                this.suppressUntil = Date.now() + 2500;
                await this.command('Seek', this.target(state));
                v.playbackRate = 1;
            } else if (!state.paused && !v.paused && v.readyState >= 3) {
                v.playbackRate = Math.abs(delta) > 0.18 ? (delta > 0 ? 1.035 : 0.965) : 1;
            } else v.playbackRate = 1;
        } finally { this.busy = false; }
    }
    stop() { this.generation++; this.roomItem = this.state = null; clearTimeout(this.initialTimer); clearTimeout(this.seekTimer); const v = this.video(); if (v) v.playbackRate = 1; }
    destroy() { this.stop(); clearInterval(this.timer); this.restore.forEach(f => f()); document.removeEventListener('seeked', this.seekHandler, true); }
}

import { JellyfinPlayer } from './player.js';
import { PartyCall } from './call.js';

const VERSION = '0.1.0';
const button = (label, action, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = cls; if (action) b.onclick = action; return b; };
const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; };
const safe = action => () => Promise.resolve().then(action).catch(e => window.dispatchEvent(new CustomEvent('jellyfin-party-error', { detail: e?.message || 'That action failed. Please try again.' })));
const guidEqual = (a, b) => a?.replaceAll('-', '') === b?.replaceAll('-', '');

export async function boot(base) {
    let current = null;
    const check = () => {
        const api = window.ApiClient;
        const key = api?.accessToken?.() ? `${api.serverId()}:${api.getCurrentUserId()}` : null;
        if (current && current.key !== key) { current.destroy(); current = null; }
        if (!current && key) { current = new PartyUI(base, api, key); }
    };
    check(); setInterval(check, 1500);
}

export class PartyUI {
    constructor(base, api, key) {
        Object.assign(this, { base, api, key });
        this.tiles = new Map(); this.members = new Map(); this.room = null; this.closed = false; this.chatOpen = true;
        this.preferencesKey = `jellyfin-party:${key}`;
        try { this.prefs = JSON.parse(localStorage.getItem(this.preferencesKey)) || {}; } catch { this.prefs = {}; }
        this.prefs.idle ??= 0.25; this.prefs.speaking ??= 0.85; this.prefs.positions ??= {};
        this.host = document.createElement('div'); this.host.id = 'jellyfin-party-root'; this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
        this.root = this.host.attachShadow({ mode: 'open' });
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'party.css'; this.root.append(css);
        document.body.append(this.host);
        this.root.append(this.launch = button('◉ Watch parties', safe(() => this.showLobby()), 'launch'));
        this.root.append(this.toasts = node('div', 'toasts')); this.toasts.setAttribute('aria-live', 'polite');
        this.root.append(this.layer = node('div', 'tiles'));
        this.root.append(this.toolbar = node('div', 'toolbar')); this.toolbar.hidden = true;
        this.roomLabel = node('span', 'room-label'); this.toolbar.append(this.roomLabel);
        this.micButton = button('Mic off', safe(() => this.toggle('audio')));
        this.camButton = button('Camera off', safe(() => this.toggle('video')));
        this.chatButton = button('Hide chat', () => this.toggleChat());
        this.toolbar.append(this.micButton, this.camButton, this.chatButton,
            button('Pause / play', () => { if (this.room?.timeline) this.control(this.room.timeline.paused ? 'play' : 'pause', this.player.position()); }),
            button('Rejoin playback', safe(() => this.player.start(this.room.itemId, this.room.timeline))),
            button('Fullscreen', safe(() => this.fullscreen())), button('Settings', () => this.showSettings()),
            button('Leave', () => this.leave(), 'danger'));
        this.makeChat();
        this.player = new JellyfinPlayer(api, this.request.bind(this), this.control.bind(this), this.notice.bind(this));
        this.errorHandler = e => this.notice(e.detail); window.addEventListener('jellyfin-party-error', this.errorHandler);
        this.menuHandler = e => { const a = e.target.closest?.('a'); if (a?.getAttribute('href')?.includes('jellyfinParty=1')) { e.preventDefault(); e.stopImmediatePropagation(); this.showLobby().catch(e => this.notice(e.message)); } };
        document.addEventListener('click', this.menuHandler, true);
        this.fullscreenHandler = () => { const target = document.fullscreenElement; (target && !['VIDEO', 'IFRAME'].includes(target.tagName) ? target : document.body).append(this.host); };
        document.addEventListener('fullscreenchange', this.fullscreenHandler);
        this.resizeHandler = () => this.tiles.forEach(tile => this.place(tile)); window.addEventListener('resize', this.resizeHandler);
        this.menuTimer = setInterval(() => this.menuLink(), 2000); this.menuLink();
        this.refreshTimer = setInterval(() => { if (this.lobby?.isConnected) this.refreshRooms().catch(() => {}); }, 10000);
        this.pageHide = () => { this.call?.close(); this.ws?.close(); }; window.addEventListener('pagehide', this.pageHide);
    }
    async request(path, params = {}, method = 'GET', body) {
        const url = new URL(this.api.getUrl(path), location.href);
        for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
        const options = { url: url.href, type: method };
        if (method === 'GET' || body !== undefined) options.dataType = 'json';
        if (body !== undefined) { options.contentType = 'application/json'; options.data = JSON.stringify(body); }
        try { return await this.api.ajax(options); }
        catch (e) {
            let message;
            try { message = (typeof e.json === 'function' ? await e.json() : JSON.parse(e.responseText))?.message; } catch {}
            throw new Error(message || (e.status === 401 ? 'Your Jellyfin login expired. Sign in again.' : 'Jellyfin Party request failed. Check that the plugin is installed and enabled.'));
        }
    }
    async socket(purpose, peerId) {
        const { ticket } = await this.request('JellyfinParty/Ticket', {}, 'POST', { purpose, peerId });
        const url = new URL(this.api.getUrl(`JellyfinParty/Socket/${purpose}`), location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { ws.close(); reject(new Error('Party connection timed out.')); }, 10000);
            ws.onopen = () => { clearTimeout(timeout); resolve(); };
            ws.onerror = () => { clearTimeout(timeout); reject(new Error('Could not connect to the party. Check WebSocket support on the tunnel.')); };
        });
        return ws;
    }
    send(data) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data)); }
    async connect() {
        if (this.ws?.readyState === WebSocket.OPEN && this.selfId) return;
        if (this.connecting) return this.connecting;
        this.connecting = (async () => {
            const ws = await this.socket('control');
            if (this.closed) { ws.close(); return; }
            this.ws = ws;
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('The party server did not respond.')), 8000);
                ws.onmessage = e => {
                    try { const message = JSON.parse(e.data); if (message.type === 'welcome') { clearTimeout(timeout); this.selfId = message.peerId; this.settings = message.settings; resolve(); } this.message(message); }
                    catch (error) { this.notice(error.message); }
                };
                ws.onclose = () => { clearTimeout(timeout); reject(new Error('Party connection closed.')); this.disconnected(ws); };
            });
            clearInterval(this.pingTimer);
            this.send({ op: 'ping', clientTime: Date.now() });
            this.pingTimer = setInterval(() => this.send({ op: 'ping', clientTime: Date.now() }), 3000);
        })();
        try { await this.connecting; } finally { this.connecting = null; }
    }
    disconnected(ws) {
        if (this.ws !== ws) return;
        this.ws = null; this.selfId = null; clearInterval(this.pingTimer);
        const roomId = this.room?.roomId;
        this.call?.close(); this.call = null; this.clearTiles(); this.setButtons();
        this.player.stop();
        if (!this.closed && roomId) {
            this.notice('Party connection lost. Reconnecting; your camera and microphone are off.');
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.join(roomId).catch(e => { this.notice(e.message); this.disconnected(null); }), 2000);
        }
    }
    async join(roomId) {
        // Resume audio during the user's join gesture; receive-only users also need it.
        if (this.joinAudio) this.joinAudio.close();
        this.joinAudio = new AudioContext({ latencyHint: 'interactive' }); this.joinAudio.resume().catch(() => {});
        try { await this.connect(); this.pendingJoin = roomId; this.send({ op: 'join', roomId }); }
        catch (error) { this.joinAudio?.close(); this.joinAudio = null; throw error; }
    }
    message(m) {
        switch (m.type) {
            case 'pong': this.player.pong(m.clientTime, m.serverTime); break;
            case 'joined': {
                this.pendingJoin = null;
                this.call?.close(); this.clearTiles(); this.room = m;
                this.call = new PartyCall({ base: this.base, socket: this.socket.bind(this), signal: (target, data) => this.send({ op: 'signal', target, data }), presence: state => this.send({ op: 'presence', ...state }), update: this.tileUpdate.bind(this), notice: this.notice.bind(this), selfId: this.selfId, settings: this.settings });
                if (this.joinAudio) { this.call.context = this.joinAudio; this.call.workletReady = this.joinAudio.audioWorklet.addModule(this.base + 'audio-worklet.js'); this.joinAudio = null; }
                this.roomLabel.textContent = m.name; this.toolbar.hidden = false; this.launch.hidden = true; this.chatPanel.hidden = !this.chatOpen;
                this.messages.replaceChildren(); for (const chat of m.chat) this.addChat(chat);
                this.dialog?.remove(); this.dialog = null; this.lobby = null;
                this.player.start(m.itemId, m.timeline).catch(e => this.notice(e.message)); this.setButtons(); break;
            }
            case 'members': {
                const ids = new Set(m.members.map(p => p.id));
                for (const id of this.members.keys()) if (!ids.has(id)) { this.call?.remove(id); this.tileUpdate(id, { removed: true }); }
                this.members = new Map(m.members.map(p => [p.id, p]));
                for (const member of m.members) { this.tileUpdate(member.id, { ...member, self: member.id === this.selfId }); this.call?.add(member.id); }
                this.memberCount.textContent = `${m.members.length} watching`; break;
            }
            case 'presence': this.members.set(m.member.id, { ...this.members.get(m.member.id), ...m.member }); this.tileUpdate(m.member.id, m.member); break;
            case 'signal': this.call?.receiveSignal(m.from, m.data).catch(e => this.notice(e.message)); break;
            case 'state': if (this.room?.roomId === m.roomId) { this.room.timeline = m.timeline; this.player.update(m.timeline); } break;
            case 'chat': this.addChat(m.message); break;
            case 'cameraDenied': if (this.call?.camera) this.toggle('video').catch(() => {}); this.notice(m.message); break;
            case 'replaced': this.leave(); this.notice(m.message); break;
            case 'error': if (this.pendingJoin) { this.pendingJoin = null; this.leave(); } this.notice(m.message); break;
        }
    }
    control(action, position) {
        if (!this.room) return;
        this.send({ op: 'sync', action, position, revision: this.room.timeline.revision });
    }
    makeChat() {
        this.chatPanel = node('section', 'chat'); this.chatPanel.setAttribute('aria-label', 'Party chat'); this.chatPanel.hidden = true;
        const header = node('header', 'chat-header'); header.append(node('strong', '', 'Party chat'), this.memberCount = node('span', 'muted'), button('×', () => this.toggleChat()));
        this.messages = node('div', 'messages'); this.messages.setAttribute('role', 'log'); this.messages.setAttribute('aria-live', 'polite');
        const form = node('form', 'chat-form'); this.chatInput = node('input'); this.chatInput.placeholder = 'Say something…'; this.chatInput.maxLength = 2000; this.chatInput.setAttribute('aria-label', 'Chat message');
        const send = button('Send'); send.type = 'submit'; form.append(this.chatInput, send);
        form.onsubmit = e => { e.preventDefault(); const text = this.chatInput.value.trim(); if (text) { this.send({ op: 'chat', text }); this.chatInput.value = ''; } };
        this.chatPanel.append(header, this.messages, form); this.root.append(this.chatPanel);
    }
    addChat(message) {
        const entry = node('div', 'message'); entry.append(node('strong', '', message.user), node('p', '', message.text)); this.messages.append(entry);
        while (this.messages.children.length > 100) this.messages.firstChild.remove(); this.messages.scrollTop = this.messages.scrollHeight;
        if (!this.chatOpen) this.chatButton.textContent = 'Show chat •';
    }
    toggleChat() { this.chatOpen = !this.chatOpen; this.chatPanel.hidden = !this.chatOpen || !this.room; this.chatButton.textContent = this.chatOpen ? 'Hide chat' : 'Show chat'; }
    async toggle(kind) {
        if (!this.call) return;
        const b = kind === 'audio' ? this.micButton : this.camButton; b.disabled = true;
        try { await this.call.toggle(kind); }
        finally { b.disabled = false; this.setButtons(); }
    }
    setButtons() {
        this.micButton.textContent = this.call?.microphone ? 'Mute mic' : 'Mic off'; this.micButton.setAttribute('aria-pressed', String(!!this.call?.microphone));
        this.camButton.textContent = this.call?.camera ? 'Turn camera off' : 'Camera off'; this.camButton.setAttribute('aria-pressed', String(!!this.call?.camera));
    }
    tileUpdate(id, change) {
        let tile = this.tiles.get(id);
        if (change.removed) { tile?.element.remove(); if (tile?.audio) { tile.audio.pause(); tile.audio.srcObject = null; } this.tiles.delete(id); return; }
        if (!tile) {
            tile = { state: {}, element: node('section', 'camera-tile'), video: node('video'), image: node('img'), audio: node('audio') };
            tile.video.autoplay = true; tile.video.playsInline = true; tile.video.muted = true; tile.video.dataset.party = 'true'; tile.image.alt = 'Participant webcam'; tile.audio.autoplay = false; tile.audio.muted = true;
            tile.caption = node('div', 'camera-caption'); tile.name = node('span'); tile.mode = node('span', 'mode');
            tile.volume = node('input'); tile.volume.type = 'range'; tile.volume.min = 0; tile.volume.max = 1; tile.volume.step = 0.05; tile.volume.value = 1; tile.volume.title = 'Participant volume'; tile.volume.setAttribute('aria-label', 'Participant volume');
            tile.volume.oninput = () => { tile.audio.volume = Number(tile.volume.value); this.call?.volume(id, Number(tile.volume.value)); };
            tile.mute = button('Mute', () => { const muted = tile.volume.value !== '0'; tile.volume.value = muted ? '0' : '1'; tile.volume.oninput(); tile.mute.textContent = muted ? 'Unmute' : 'Mute'; });
            tile.caption.append(tile.name, tile.mode, tile.volume, tile.mute);
            tile.element.append(tile.video, tile.image, tile.audio, tile.caption);
            this.layer.append(tile.element); this.tiles.set(id, tile);
            tile.image.hidden = true;
            const grip = node('button', 'resize-grip', '↘'); grip.type = 'button'; grip.title = 'Resize webcam'; grip.setAttribute('aria-label', 'Resize webcam'); tile.element.append(grip);
            this.drag(tile, tile.caption, false); this.drag(tile, grip, true);
        }
        Object.assign(tile.state, change);
        const state = tile.state;
        tile.element.hidden = !state.camera; tile.element.setAttribute('aria-label', `${state.name || 'Participant'} webcam`); tile.name.textContent = `${state.name || (state.self ? 'You' : 'Participant')}${state.self ? ' (you)' : ''}`;
        tile.volume.hidden = tile.mute.hidden = !!state.self;
        tile.element.classList.toggle('speaking', !!state.speaking); tile.element.style.setProperty('--opacity', String(state.speaking ? this.prefs.speaking : this.prefs.idle));
        tile.mode.textContent = state.self ? '' : ({ p2p: 'P2P', relay: 'Tunnel', unavailable: 'No connection' }[state.mode] || 'Connecting');
        if ('stream' in change) {
            tile.video.srcObject = change.stream;
            tile.audio.srcObject = null; // PartyCall mixes audio through its user-activated AudioContext.
            if (change.stream) { tile.video.play().catch(() => {}); }
        }
        if (change.image) tile.image.src = change.image;
        tile.video.hidden = state.mode === 'relay'; tile.image.hidden = state.mode !== 'relay';
        if (!tile.position) { const saved = this.prefs.positions[state.userId || id]; tile.position = saved || this.defaultPosition(this.tiles.size - 1); }
        this.place(tile);
    }
    defaultPosition(index) {
        const columns = Math.max(1, Math.floor((innerWidth - 24) / 232));
        return { x: (12 + index % columns * 232) / innerWidth, y: 0.06 + Math.floor(index / columns) * 170 / innerHeight, w: 220 };
    }
    place(tile) {
        const p = tile.position; if (!p) return;
        const w = Math.max(130, Math.min(p.w, innerWidth - 20)); const h = w * 9 / 16 + 34;
        tile.element.style.width = `${w}px`; tile.element.style.left = `${Math.max(0, Math.min(p.x * innerWidth, innerWidth - w))}px`; tile.element.style.top = `${Math.max(0, Math.min(p.y * innerHeight, innerHeight - h - 70))}px`;
    }
    drag(tile, handle, resize) {
        handle.tabIndex = 0;
        handle.title = resize ? 'Drag or use arrow keys to resize webcam' : 'Drag or use arrow keys to move webcam';
        const remember = () => { this.prefs.positions[tile.state.userId || tile.state.id] = tile.position; this.save(); };
        handle.onkeydown = event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.target !== handle) return;
            event.preventDefault(); event.stopPropagation();
            const step = event.shiftKey ? 30 : 10;
            const sign = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
            if (resize) tile.position.w = Math.max(130, Math.min(640, tile.position.w + sign * step));
            else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) tile.position.x = Math.max(0, Math.min(1, tile.position.x + sign * step / innerWidth));
            else tile.position.y = Math.max(0, Math.min(1, tile.position.y + sign * step / innerHeight));
            this.place(tile); remember();
        };
        let active = false;
        const start = event => {
            if (active || (event.button != null && event.button !== 0) || (!resize && event.target.closest('button,input'))) return;
            event.preventDefault(); active = true;
            const point = event.touches?.[0] || event;
            const initial = { ...tile.position }, x = point.clientX, y = point.clientY;
            const move = e => {
                const current = e.touches?.[0] || e;
                if (e.cancelable) e.preventDefault();
                tile.position = resize ? { ...initial, w: Math.max(130, Math.min(640, initial.w + current.clientX - x)) } : { ...initial, x: Math.max(0, Math.min(1, initial.x + (current.clientX - x) / innerWidth)), y: Math.max(0, Math.min(1, initial.y + (current.clientY - y) / innerHeight)) };
                this.place(tile);
            };
            const done = () => {
                active = false;
                for (const type of ['pointermove', 'mousemove', 'touchmove']) document.removeEventListener(type, move, true);
                for (const type of ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel']) document.removeEventListener(type, done, true);
                remember();
            };
            for (const type of ['pointermove', 'mousemove', 'touchmove']) document.addEventListener(type, move, { capture: true, passive: false });
            for (const type of ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel']) document.addEventListener(type, done, true);
        };
        handle.onpointerdown = start; handle.onmousedown = start; handle.ontouchstart = start;
    }
    save() { try { localStorage.setItem(this.preferencesKey, JSON.stringify(this.prefs)); } catch {} }
    modal(title) {
        this.dialog?.remove(); this.lobby = null;
        const backdrop = node('div', 'backdrop'); const panel = node('section', 'dialog'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title); panel.tabIndex = -1;
        const header = node('header', 'dialog-header'); header.append(node('h2', '', title), button('Close', () => backdrop.remove())); panel.append(header); backdrop.append(panel); this.root.append(backdrop); this.dialog = backdrop;
        backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
        backdrop.onkeydown = e => { if (e.key === 'Escape') backdrop.remove(); if (e.key === 'Tab') { const items = [...panel.querySelectorAll('button,input,select,a')].filter(n => !n.disabled && !n.hidden); if (!items.length) return; const first = items[0], last = items.at(-1); if (e.shiftKey && this.root.activeElement === first) { last.focus(); e.preventDefault(); } else if (!e.shiftKey && this.root.activeElement === last) { first.focus(); e.preventDefault(); } } };
        panel.focus(); return panel;
    }
    async showLobby() {
        const panel = this.modal('Watch parties'); this.lobby = panel;
        panel.append(node('p', 'muted', 'Watch together. Join a room using your Jellyfin account, then switch on your camera or microphone when you are ready.'));
        this.roomList = node('div', 'room-list'); panel.append(this.roomList);
        const create = node('section', 'create'); create.append(node('h3', '', 'Start a party'));
        const name = node('input'); name.placeholder = 'Party name'; name.maxLength = 80; name.setAttribute('aria-label', 'Party name');
        const search = node('input'); search.placeholder = 'Find a movie or episode…'; search.setAttribute('aria-label', 'Find a movie or episode');
        const results = node('div', 'search-results'); let selected = this.player.report?.ItemId || null;
        const selection = node('p', 'muted', selected ? 'Using the movie or episode currently playing.' : 'Select something to watch.');
        let timer; let query = 0;
        search.oninput = () => { clearTimeout(timer); const generation = ++query; timer = setTimeout(async () => {
            try {
                if (search.value.trim().length < 2) { results.replaceChildren(); return; }
                const data = await this.request('Items', { userId: this.api.getCurrentUserId(), recursive: true, includeItemTypes: 'Movie,Episode', searchTerm: search.value.trim(), limit: 12, fields: 'RunTimeTicks' });
                if (generation !== query) return;
                results.replaceChildren();
                for (const item of data.Items || []) {
                    const label = item.SeriesName ? `${item.SeriesName} — ${item.Name}` : `${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}`;
                    results.append(button(label, () => { selected = item.Id; selection.textContent = label; results.replaceChildren(); }));
                }
                if (!data.Items?.length) results.append(node('p', 'muted', 'No matching movies or episodes.'));
            } catch (e) { this.notice(e.message); }
        }, 300); };
        const start = button('Create & join', safe(async () => {
            if (!selected) throw new Error('Select a movie or episode first.');
            if (!name.value.trim()) throw new Error('Give your party a name.');
            start.disabled = true;
            try { const { roomId } = await this.request('JellyfinParty/Rooms', {}, 'POST', { name: name.value.trim(), itemId: selected }); await this.join(roomId); }
            finally { start.disabled = false; }
        }), 'primary');
        create.append(name, search, results, selection, start); panel.append(create);
        await this.refreshRooms();
    }
    async refreshRooms() {
        const list = this.roomList; if (!list?.isConnected) return;
        const rooms = await this.request('JellyfinParty/Rooms'); if (!list.isConnected) return; list.replaceChildren();
        if (!rooms.length) list.append(node('p', 'empty', 'No parties yet. Start one below.'));
        for (const room of rooms) {
            const row = node('article', 'room'); const text = node('div'); text.append(node('strong', '', room.name), node('p', 'muted', `${room.title} · ${room.participants}/${room.capacity} watching`));
            row.append(text, button('Join', safe(() => this.join(room.id)), 'primary')); list.append(row);
        }
    }
    showSettings() {
        const panel = this.modal('Party settings');
        for (const [key, title] of [['idle', 'Webcam opacity while quiet'], ['speaking', 'Webcam opacity while speaking']]) {
            const label = node('label', 'setting', title); const input = node('input'); input.type = 'range'; input.min = 0.05; input.max = 1; input.step = 0.05; input.value = this.prefs[key]; const value = node('span', '', `${Math.round(input.value * 100)}%`);
            input.oninput = () => { this.prefs[key] = Number(input.value); value.textContent = `${Math.round(input.value * 100)}%`; this.tiles.forEach((tile, id) => this.tileUpdate(id, {})); this.save(); }; label.append(input, value); panel.append(label);
        }
        panel.append(button('Enable audio', safe(async () => { await this.call?.audio(); for (const tile of this.tiles.values()) if (tile.audio.srcObject) await tile.audio.play(); })),
            button('Use tunnel relay for all calls', safe(async () => { if (!this.call) return; for (const id of this.call.peers.keys()) await this.call.fallback(id); this.notice('Calls now use the tunnel relay.'); })),
            button('Reset webcam positions', () => { this.prefs.positions = {}; let index = 0; for (const tile of this.tiles.values()) { tile.position = this.defaultPosition(index++); this.place(tile); } this.save(); }));
        panel.append(node('p', 'muted', 'P2P gives smoother calls when available. The tunnel fallback uses 480×270 webcam frames and mono voice. Microphones and cameras are off on entry and after reconnecting.'));
        panel.append(node('p', 'muted', `Jellyfin Party ${VERSION} · ${this.members.size} participants`));
    }
    menuLink() {
        const target = document.querySelector('.customMenuOptions');
        if (target && !target.querySelector('[data-jellyfin-party]')) {
            const link = document.createElement('a'); link.href = '#/home?jellyfinParty=1'; link.dataset.jellyfinParty = 'true'; link.className = 'navMenuOption'; link.textContent = '◉ Watch parties'; target.append(link);
        }
    }
    async fullscreen() { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    notice(message) {
        if (!message || this.lastNotice === message && Date.now() - this.lastNoticeAt < 5000) return;
        this.lastNotice = message; this.lastNoticeAt = Date.now();
        const toast = node('div', 'toast', message); this.toasts.append(toast); setTimeout(() => toast.remove(), 7000);
    }
    clearTiles() { for (const id of [...this.tiles.keys()]) this.tileUpdate(id, { removed: true }); this.members.clear(); }
    leave() {
        clearTimeout(this.reconnectTimer); this.send({ op: 'leave' }); this.room = null; this.pendingJoin = null; clearInterval(this.pingTimer); this.ws?.close(); this.player.stop(); this.call?.close(); this.call = null;
        this.joinAudio?.close(); this.joinAudio = null; this.clearTiles(); this.toolbar.hidden = true; this.chatPanel.hidden = true; this.launch.hidden = false; this.setButtons();
    }
    destroy() {
        this.closed = true; this.leave(); this.ws?.close(); this.player.destroy(); this.host.remove();
        for (const timer of [this.pingTimer, this.menuTimer, this.refreshTimer]) clearInterval(timer);
        document.removeEventListener('click', this.menuHandler, true); document.removeEventListener('fullscreenchange', this.fullscreenHandler); window.removeEventListener('resize', this.resizeHandler); window.removeEventListener('jellyfin-party-error', this.errorHandler); window.removeEventListener('pagehide', this.pageHide);
        document.querySelectorAll('[data-jellyfin-party]').forEach(n => n.remove());
    }
}

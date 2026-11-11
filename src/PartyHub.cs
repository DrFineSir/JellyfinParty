using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace JellyfinParty;

public sealed class PartyFault(string message) : Exception(message);
public sealed record Ticket(Identity Identity, string Purpose, string? PeerId, long Expires);
public sealed record ChatMessage(string Id, string User, string Text, long Time);
public sealed class Room(string name, Movie movie, long now)
{
    public string Id { get; } = Guid.NewGuid().ToString();
    public string Name { get; } = name;
    public Movie Movie { get; } = movie;
    public Timeline Timeline { get; } = new(movie.Duration, now);
    public Dictionary<string, Peer> Peers { get; } = new();
    public Queue<ChatMessage> Chat { get; } = new();
    public long EmptySince { get; set; } = now;
}
public sealed class SocketPipe(WebSocket socket, int capacity, bool lossy) : IDisposable
{
    public WebSocket Socket { get; } = socket;
    public Channel<(byte[] Bytes, WebSocketMessageType Type)> Out { get; } = Channel.CreateBounded<(byte[], WebSocketMessageType)>(new BoundedChannelOptions(capacity) { SingleReader = true, FullMode = lossy ? BoundedChannelFullMode.DropOldest : BoundedChannelFullMode.Wait });
    public void Json(object value) => Enqueue(JsonSerializer.SerializeToUtf8Bytes(value, PartyHub.Json), WebSocketMessageType.Text);
    public void Enqueue(byte[] bytes, WebSocketMessageType type) { if (!Out.Writer.TryWrite((bytes, type))) Socket.Abort(); }
    public async Task Write(CancellationToken cancellation)
    {
        try
        {
            await foreach (var packet in Out.Reader.ReadAllAsync(cancellation))
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                await Socket.SendAsync(packet.Bytes.AsMemory(), packet.Type, true, timeout.Token);
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or IOException) { Socket.Abort(); }
    }
    public void Dispose() { Out.Writer.TryComplete(); Socket.Abort(); Socket.Dispose(); }
}
public sealed class Peer(Identity identity, SocketPipe pipe)
{
    public string Id { get; } = Guid.NewGuid().ToString();
    public Identity Identity { get; } = identity;
    public SocketPipe Pipe { get; } = pipe;
    public SocketPipe? Media { get; set; }
    public Room? Room { get; set; }
    public bool Camera { get; set; }
    public bool Microphone { get; set; }
    public bool Speaking { get; set; }
    public long LastSeen { get; set; } = PartyHub.Now;
    public long Window { get; set; } = PartyHub.Now;
    public int Commands { get; set; }
    public int Bytes { get; set; }
    public int MediaPackets { get; set; }
    public long LastChat { get; set; }
    public object View() => new { id = Id, userId = Identity.UserId, name = Identity.Name, camera = Camera, microphone = Microphone, speaking = Speaking };
}

public sealed class PartyHub(IPartyAccess access)
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly object _gate = new();
    private readonly Dictionary<string, Peer> _peers = new();
    private readonly Dictionary<string, Room> _rooms = new();
    private readonly Dictionary<string, Ticket> _tickets = new();
    public Configuration Settings => Plugin.Instance?.Configuration ?? new();
    public object ClientSettings => new { maxParticipants = Math.Clamp(Settings.MaxParticipants, 2, 64), maxCameras = Math.Clamp(Settings.MaxCameras, 1, 24), enableRelay = Settings.EnableRelay, stunUrl = Settings.StunUrl };

    public string Issue(Identity identity, string purpose, string? peerId)
    {
        lock (_gate)
        {
            foreach (var key in _tickets.Where(x => x.Value.Expires < Now).Select(x => x.Key).ToArray()) _tickets.Remove(key);
            if (purpose is not ("control" or "media")) throw new PartyFault("Unknown connection type.");
            if (purpose == "media" && (!Settings.EnableRelay || peerId == null || !_peers.TryGetValue(peerId, out var peer) || peer.Identity.UserId != identity.UserId || peer.Identity.DeviceId != identity.DeviceId)) throw new PartyFault("No matching party connection.");
            if (_tickets.Values.Count(x => x.Identity.UserId == identity.UserId) >= 8) throw new PartyFault("Too many pending connections. Try again shortly.");
            var key2 = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            _tickets[key2] = new(identity, purpose, peerId, Now + 30000);
            return key2;
        }
    }
    public Ticket? Consume(string ticket, string purpose)
    {
        lock (_gate)
        {
            if (!_tickets.Remove(ticket, out var found) || found.Purpose != purpose || found.Expires < Now || access.Identify(found.Identity.UserId, found.Identity.DeviceId) == null) return null;
            return found;
        }
    }
    public object[] List(Identity identity)
    {
        lock (_gate) return _rooms.Values.Where(r => access.Watch(identity.UserId, r.Movie.Id) != null).Select(r => (object)new { id = r.Id, name = r.Name, itemId = r.Movie.Id, title = r.Movie.Name, participants = r.Peers.Count, capacity = Math.Clamp(Settings.MaxParticipants, 2, 64) }).ToArray();
    }
    public string Create(Identity identity, string name, Guid itemId)
    {
        lock (_gate)
        {
            if (_rooms.Count >= Math.Clamp(Settings.MaxRooms, 1, 64)) throw new PartyFault("The server's party room limit has been reached.");
            if (string.IsNullOrWhiteSpace(name) || name.Length > 80) throw new PartyFault("Use a party name between 1 and 80 characters.");
            var movie = access.Watch(identity.UserId, itemId) ?? throw new PartyFault("You cannot watch that item.");
            if (movie.Duration <= 0) throw new PartyFault("Choose a movie or episode with a known duration. Live TV is not supported.");
            var room = new Room(name.Trim(), movie, Now);
            _rooms[room.Id] = room;
            return room.Id;
        }
    }
    private void Broadcast(Room room, object message) { foreach (var p in room.Peers.Values) p.Pipe.Json(message); }
    private object Members(Room room) => new { type = "members", members = room.Peers.Values.Select(x => x.View()).ToArray() };
    private object State(Room room) => new { type = "state", roomId = room.Id, timeline = room.Timeline.Snapshot(Now) };
    private void Leave(Peer peer)
    {
        var room = peer.Room;
        if (room == null) return;
        room.Peers.Remove(peer.Id); peer.Room = null; peer.Camera = peer.Microphone = peer.Speaking = false;
        room.EmptySince = Now;
        Broadcast(room, Members(room));
    }
    private static string Str(JsonElement e, string name) => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
    private static bool Bool(JsonElement e, string name) => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.True;
    public void Command(Peer peer, JsonElement message)
    {
        lock (_gate)
        {
            var now = Now;
            if (now - peer.Window >= 1000) { peer.Window = now; peer.Commands = peer.Bytes = peer.MediaPackets = 0; }
            if (++peer.Commands > 60) throw new PartyFault("Too many party commands.");
            peer.LastSeen = now;
            if (access.Identify(peer.Identity.UserId, peer.Identity.DeviceId) == null) { peer.Pipe.Socket.Abort(); return; }
            var op = Str(message, "op");
            if (op == "ping") { peer.Pipe.Json(new { type = "pong", clientTime = message.GetProperty("clientTime").GetDouble(), serverTime = now }); return; }
            if (op == "leave") { Leave(peer); peer.Pipe.Json(new { type = "left" }); return; }
            if (op == "join")
            {
                if (!_rooms.TryGetValue(Str(message, "roomId"), out var room)) throw new PartyFault("That party has ended.");
                if (access.Watch(peer.Identity.UserId, room.Movie.Id) == null) throw new PartyFault("Your account cannot access this movie.");
                if (peer.Room == room) return;
                var previous = room.Peers.Values.FirstOrDefault(x => x.Identity.UserId == peer.Identity.UserId);
                if (room.Peers.Count - (previous == null ? 0 : 1) >= Math.Clamp(Settings.MaxParticipants, 2, 64)) throw new PartyFault("This party is full.");
                if (previous != null) { Leave(previous); previous.Pipe.Json(new { type = "replaced", message = "Your account joined this party in another tab or device." }); }
                Leave(peer);
                peer.Room = room; room.Peers[peer.Id] = peer;
                peer.Pipe.Json(new { type = "joined", roomId = room.Id, room.Name, itemId = room.Movie.Id, title = room.Movie.Name, timeline = room.Timeline.Snapshot(now), chat = room.Chat.ToArray() });
                Broadcast(room, Members(room)); return;
            }
            var active = peer.Room ?? throw new PartyFault("Join a party first.");
            if (access.Watch(peer.Identity.UserId, active.Movie.Id) == null) { Leave(peer); throw new PartyFault("Your access to this movie has changed."); }
            switch (op)
            {
                case "sync":
                    var action = Str(message, "action");
                    var position = message.GetProperty("position").GetDouble();
                    var revision = message.GetProperty("revision").GetInt64();
                    if (!active.Timeline.Apply(action, position, revision, now)) { peer.Pipe.Json(State(active)); break; }
                    Broadcast(active, State(active)); break;
                case "chat":
                    var content = Str(message, "text").Trim();
                    if (content.Length is < 1 or > 2000) throw new PartyFault("Messages must contain 1–2000 characters.");
                    if (now - peer.LastChat < 400) throw new PartyFault("Please wait a moment before sending another message.");
                    peer.LastChat = now;
                    var chat = new ChatMessage(Guid.NewGuid().ToString(), peer.Identity.Name, content, now);
                    active.Chat.Enqueue(chat); while (active.Chat.Count > 100) active.Chat.Dequeue();
                    Broadcast(active, new { type = "chat", message = chat }); break;
                case "presence":
                    var camera = Bool(message, "camera");
                    if (camera && !peer.Camera && active.Peers.Values.Count(x => x.Camera) >= Math.Clamp(Settings.MaxCameras, 1, 24)) { peer.Pipe.Json(new { type = "cameraDenied", message = "This party has reached the camera limit." }); break; }
                    peer.Camera = camera; peer.Microphone = Bool(message, "microphone"); peer.Speaking = peer.Microphone && Bool(message, "speaking");
                    Broadcast(active, new { type = "presence", member = peer.View() }); break;
                case "signal":
                    if (!active.Peers.TryGetValue(Str(message, "target"), out var target) || target == peer) break; // Late ICE candidates after a peer leaves are normal.
                    peer.Room.Peers[target.Id].Pipe.Json(new { type = "signal", from = peer.Id, data = message.GetProperty("data") }); break;
                default: throw new PartyFault("Unknown party command.");
            }
        }
    }
    public async Task Control(WebSocket socket, Ticket ticket, CancellationToken cancel)
    {
        using var pipe = new SocketPipe(socket, 128, false);
        var peer = new Peer(ticket.Identity, pipe);
        lock (_gate)
        {
            if (_peers.Values.Count(x => x.Identity.UserId == ticket.Identity.UserId) >= 4) throw new PartyFault("Too many open party tabs.");
            _peers[peer.Id] = peer;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        var writer = pipe.Write(linked.Token);
        pipe.Json(new { type = "welcome", peerId = peer.Id, settings = ClientSettings, serverTime = Now });
        try
        {
            while (socket.State == WebSocketState.Open && !cancel.IsCancellationRequested)
            {
                var packet = await Read(socket, 65536, linked.Token);
                if (packet == null) break;
                try { using var document = JsonDocument.Parse(packet); Command(peer, document.RootElement); }
                catch (Exception ex) when (ex is PartyFault or JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
                { pipe.Json(new { type = "error", message = ex is PartyFault ? ex.Message : "Invalid party message." }); }
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException or PartyFault) { }
        finally
        {
            lock (_gate) { Leave(peer); _peers.Remove(peer.Id); peer.Media?.Socket.Abort(); }
            await linked.CancelAsync(); pipe.Out.Writer.TryComplete(); socket.Abort(); await writer;
        }
    }
    public async Task Media(WebSocket socket, Ticket ticket, CancellationToken cancel)
    {
        using var pipe = new SocketPipe(socket, 32, true);
        Peer peer;
        lock (_gate)
        {
            if (ticket.PeerId == null || !_peers.TryGetValue(ticket.PeerId, out peer!) || peer.Identity.UserId != ticket.Identity.UserId) return;
            peer.Media?.Socket.Abort(); peer.Media = pipe;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        var writer = pipe.Write(linked.Token);
        try
        {
            while (socket.State == WebSocketState.Open && !cancel.IsCancellationRequested)
            {
                var packet = await Read(socket, 65536, linked.Token, WebSocketMessageType.Binary);
                if (packet == null) break;
                lock (_gate)
                {
                    if (!Settings.EnableRelay || peer.Room == null || packet.Length < 46) continue;
                    if (Now - peer.Window >= 1000) { peer.Window = Now; peer.Commands = peer.Bytes = peer.MediaPackets = 0; }
                    peer.Bytes += packet.Length;
                    if (++peer.MediaPackets > 1500 || peer.Bytes > 4000000) throw new PartyFault("Relay rate exceeded.");
                    var kind = packet[0];
                    if ((kind == 1 && !peer.Camera) || (kind == 2 && !peer.Microphone) || kind is not (1 or 2)) continue;
                    if (kind == 2 && (packet.Length > 2093 || (packet.Length - 45) % 2 != 0)) continue;
                    if (kind == 1 && (packet[45] != 0xff || packet.Length < 48 || packet[46] != 0xd8)) continue;
                    var targetId = Encoding.ASCII.GetString(packet, 1, 36);
                    if (!peer.Room.Peers.TryGetValue(targetId, out var target) || target == peer || target.Media == null) continue;
                    Encoding.ASCII.GetBytes(peer.Id, packet.AsSpan(1, 36));
                    target.Media.Enqueue(packet, WebSocketMessageType.Binary);
                }
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException or PartyFault) { }
        finally
        {
            lock (_gate) { if (peer.Media == pipe) peer.Media = null; }
            await linked.CancelAsync(); pipe.Out.Writer.TryComplete(); socket.Abort(); await writer;
        }
    }
    private static async Task<byte[]?> Read(WebSocket socket, int limit, CancellationToken cancel, WebSocketMessageType type = WebSocketMessageType.Text)
    {
        using var data = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer.AsMemory(), cancel);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            if (result.MessageType != type || data.Length + result.Count > limit) throw new PartyFault("Invalid socket frame.");
            data.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return data.ToArray();
        }
    }
    public void Tick()
    {
        lock (_gate)
        {
            foreach (var p in _peers.Values.ToArray())
                if (Now - p.LastSeen > 45000 || access.Identify(p.Identity.UserId, p.Identity.DeviceId) == null || (p.Room != null && access.Watch(p.Identity.UserId, p.Room.Movie.Id) == null)) { Leave(p); p.Pipe.Socket.Abort(); p.Media?.Socket.Abort(); }
            foreach (var room in _rooms.Values.ToArray())
            {
                if (room.Peers.Count == 0 && Now - room.EmptySince > 60000) _rooms.Remove(room.Id);
                else if (room.Peers.Count > 0) Broadcast(room, State(room));
            }
            foreach (var key in _tickets.Where(x => x.Value.Expires < Now).Select(x => x.Key).ToArray()) _tickets.Remove(key);
        }
    }
}
public sealed class PartyTicker(PartyHub hub, ILogger<PartyTicker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        try { while (await timer.WaitForNextTickAsync(stoppingToken)) { try { hub.Tick(); } catch (Exception ex) { logger.LogError(ex, "Party maintenance failed"); } } }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}

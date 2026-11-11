using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace JellyfinParty;

[ApiController]
[Route("JellyfinParty")]
public sealed class PartyController(PartyHub hub, IPartyAccess access) : ControllerBase
{
    private Identity? Current()
    {
        var value = User.FindFirst("Jellyfin-UserId")?.Value;
        var device = User.FindFirst("Jellyfin-DeviceId")?.Value ?? "";
        return Guid.TryParse(value, out var userId) && device.Length > 0 ? access.Identify(userId, device) : null;
    }
    [Authorize, HttpGet("Rooms")]
    public IActionResult Rooms() => Current() is { } identity ? Ok(hub.List(identity)) : Forbid();
    public record CreateRequest(string Name, string ItemId);
    [Authorize, HttpPost("Rooms")]
    public IActionResult Create(CreateRequest request)
    {
        if (Current() is not { } identity) return Forbid();
        if (!Guid.TryParse(request.ItemId, out var itemId)) return BadRequest(new { message = "Invalid movie identifier." });
        try { return Ok(new { roomId = hub.Create(identity, request.Name, itemId) }); }
        catch (PartyFault ex) { return BadRequest(new { message = ex.Message }); }
    }
    public record TicketRequest(string Purpose, string? PeerId);
    [Authorize, HttpPost("Ticket")]
    public IActionResult Ticket(TicketRequest request)
    {
        if (Current() is not { } identity) return Forbid();
        try { return Ok(new { ticket = hub.Issue(identity, request.Purpose, request.PeerId) }); }
        catch (PartyFault ex) { return BadRequest(new { message = ex.Message }); }
    }
    [AllowAnonymous, HttpGet("Socket/{purpose}")]
    public async Task Socket(string purpose, [FromQuery] string ticket)
    {
        var grant = hub.Consume(ticket, purpose);
        if (grant == null || !HttpContext.WebSockets.IsWebSocketRequest) { Response.StatusCode = 401; return; }
        // This endpoint accepts only short-lived, single-use tickets issued by authenticated POST.
        using var socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
        if (purpose == "control") await hub.Control(socket, grant, HttpContext.RequestAborted);
        else await hub.Media(socket, grant, HttpContext.RequestAborted);
    }
    [AllowAnonymous, HttpGet("Assets/{file}")]
    public IActionResult Asset(string file)
    {
        var types = new Dictionary<string, string> { ["bootstrap.js"] = "text/javascript", ["party.js"] = "text/javascript", ["call.js"] = "text/javascript", ["player.js"] = "text/javascript", ["audio-worklet.js"] = "text/javascript", ["party.css"] = "text/css" };
        if (!types.TryGetValue(file, out var type)) return NotFound();
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("JellyfinParty.Web." + file);
        if (stream == null) return NotFound();
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(stream, type);
    }
}

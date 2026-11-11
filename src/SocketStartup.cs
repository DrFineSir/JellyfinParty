using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace JellyfinParty;

// Jellyfin 12.1's own WebSocket middleware captures every upgrade before MVC.
// Install a narrowly scoped handler ahead of it; ordinary requests still use
// Jellyfin's authentication, authorization, base URL, and controller pipeline.
public sealed class SocketStartup : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.UseWebSockets();
        app.Use(async (context, following) =>
        {
            var path = context.Request.Path.Value ?? "";
            var purpose = path.EndsWith("/JellyfinParty/Socket/control", StringComparison.Ordinal) ? "control"
                : path.EndsWith("/JellyfinParty/Socket/media", StringComparison.Ordinal) ? "media" : null;
            if (purpose == null || !context.WebSockets.IsWebSocketRequest) { await following(); return; }
            var hub = context.RequestServices.GetRequiredService<PartyHub>();
            var ticket = context.Request.Query["ticket"].ToString();
            var grant = hub.Consume(ticket, purpose);
            if (grant == null) { context.Response.StatusCode = 401; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            try
            {
                if (purpose == "control") await hub.Control(socket, grant, context.RequestAborted);
                else await hub.Media(socket, grant, context.RequestAborted);
            }
            catch (PartyFault) { socket.Abort(); }
        });
        next(app);
    };
}

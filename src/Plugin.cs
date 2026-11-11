using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.DependencyInjection;

namespace JellyfinParty;

public sealed class Configuration : BasePluginConfiguration
{
    public int MaxParticipants { get; set; } = 24;
    public int MaxCameras { get; set; } = 8;
    public int MaxRooms { get; set; } = 16;
    public bool EnableRelay { get; set; } = true;
    public string StunUrl { get; set; } = "stun:stun.l.google.com:19302";
}

public sealed class Plugin : BasePlugin<Configuration>, IHasWebPages
{
    public static Plugin? Instance { get; private set; }
    public Plugin(IApplicationPaths paths, IXmlSerializer xml) : base(paths, xml) { Instance = this; }
    public override string Name => "Jellyfin Party";
    public override string Description => "Watch together with chat, transparent webcams, and a tunnel-compatible call relay.";
    public override Guid Id => Guid.Parse("e6ae3bcc-179d-4e47-a214-b12502fb22df");
    public IEnumerable<PluginPageInfo> GetPages() => new[] { new PluginPageInfo { Name = "JellyfinParty", EmbeddedResourcePath = "JellyfinParty.Web.settings.html" } };
}

public sealed class Services : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost host)
    {
        services.AddTransient<Microsoft.AspNetCore.Hosting.IStartupFilter, SocketStartup>();
        services.AddSingleton<IPartyAccess, JellyfinAccess>();
        services.AddSingleton<PartyHub>();
        services.AddHostedService<PartyTicker>();
    }
}

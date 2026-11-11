using System.Security.Claims;
using System.Text.Encodings.Web;
using JellyfinParty;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.FileProviders;

// Isolated test host only. Never package or deploy this executable to Jellyfin.
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:17891");
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuth>("fixture", _ => {});
builder.Services.AddAuthorization();
builder.Services.AddTransient<Microsoft.AspNetCore.Hosting.IStartupFilter, SocketStartup>();
builder.Services.AddControllers().AddApplicationPart(typeof(PartyController).Assembly);
builder.Services.AddSingleton<IPartyAccess, FixtureAccess>();
builder.Services.AddSingleton<PartyHub>(); builder.Services.AddHostedService<PartyTicker>();
var app = builder.Build();
app.UseWebSockets(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers();
var project = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(Path.Combine(project, "src/Web")), RequestPath = "/assets" });
app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(Path.Combine(project, "tests/fixture")), RequestPath = "/fixture" });
app.Run();

public sealed class FixtureAccess : IPartyAccess
{
    public static readonly Guid MovieId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    public Identity? Identify(Guid userId, string deviceId) => userId == Guid.Empty ? null : new(userId, userId.ToString()[0] == '1' ? "Alice" : "Bob", deviceId);
    public Movie? Watch(Guid userId, Guid itemId) => itemId == MovieId && userId.ToString()[0] != '9' ? new(itemId, "Synthetic test movie", 600) : null;
}
public sealed class FixtureAuth(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Guid.TryParse(Request.Headers["Test-User"], out var user)) return Task.FromResult(AuthenticateResult.NoResult());
        var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user.ToString()), new Claim("Jellyfin-DeviceId", Request.Headers["Test-Device"].FirstOrDefault() ?? "test") }, "fixture");
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), "fixture")));
    }
}

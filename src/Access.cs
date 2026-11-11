using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Data;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace JellyfinParty;

public record Identity(Guid UserId, string Name, string DeviceId);
public record Movie(Guid Id, string Name, double Duration);
public interface IPartyAccess
{
    Identity? Identify(Guid userId, string deviceId);
    Movie? Watch(Guid userId, Guid itemId);
}
public sealed class JellyfinAccess(IUserManager users, ILibraryManager library) : IPartyAccess
{
    public Identity? Identify(Guid userId, string deviceId)
    {
        var user = users.GetUserById(userId);
        if (user == null || user.HasPermission(PermissionKind.IsDisabled) || !user.HasPermission(PermissionKind.EnableMediaPlayback)) return null;
        return new(userId, user.Username, deviceId);
    }
    public Movie? Watch(Guid userId, Guid itemId)
    {
        var user = users.GetUserById(userId);
        var item = library.GetItemById(itemId);
        if (user == null || item == null || !item.IsVisibleStandalone(user) || item.MediaType != Jellyfin.Data.Enums.MediaType.Video) return null;
        return new(item.Id, item.Name, (item.RunTimeTicks ?? 0) / 10000000d);
    }
}

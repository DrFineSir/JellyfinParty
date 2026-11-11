namespace JellyfinParty;

// The server owns the timeline. Clients estimate server time using round-trip pings.
public sealed class Timeline(double duration, long now)
{
    public double Position { get; private set; }
    public bool Paused { get; private set; } = true;
    public long UpdatedAt { get; private set; } = now;
    public long Revision { get; private set; }
    public double At(long now) => Math.Clamp(Position + (Paused ? 0 : Math.Max(0, now - UpdatedAt) / 1000d), 0, Math.Max(0, duration));
    public bool Apply(string action, double position, long revision, long now)
    {
        if (revision != Revision || !double.IsFinite(position) || action is not ("play" or "pause" or "seek")) return false;
        Position = action == "seek" ? Math.Clamp(position, 0, duration) : At(now);
        if (action == "play") Paused = false;
        if (action == "pause") Paused = true;
        UpdatedAt = now;
        Revision++;
        return true;
    }
    public object Snapshot(long now) => new { position = At(now), paused = Paused, revision = Revision, serverTime = now, duration };
}

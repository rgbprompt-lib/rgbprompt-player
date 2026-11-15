namespace RGBPrompt.Player.Core.Models;

/// <summary>
/// Holds protocol / file entry points that arrive before the app controller is
/// ready, then delivers each distinct entry once.
/// </summary>
/// <remarks>
/// A cold <c>rgbprompt://</c> launch can deliver the URL via argv, the process
/// command line, or a protocol activation event at slightly different times.
/// Dropping the first URL means the site has to be clicked again once the
/// first instance is already running. This queue keeps the first deep link
/// and deduplicates the same URL if more than one source delivers it.
/// </remarks>
public sealed class LaunchEntryQueue
{
    readonly Action<EntryPoint> _deliver;
    readonly List<EntryPoint> _pending = new();
    bool _started;
    string? _lastDeliveredKey;

    public LaunchEntryQueue(Action<EntryPoint> deliver)
    {
        _deliver = deliver;
    }

    public bool HasStarted => _started;
    public int PendingCount => _pending.Count;

    public void Submit(EntryPoint entry)
    {
        if (entry is EntryPoint.Ignored) return;
        var key = Key(entry);
        if (key is null) return;
        if (!_started)
        {
            if (_pending.Exists(item => Key(item) == key)) return;
            _pending.Add(entry);
            return;
        }
        Emit(entry, key);
    }

    public void Start()
    {
        if (_started) return;
        _started = true;
        var queued = _pending.ToArray();
        _pending.Clear();
        foreach (var entry in queued)
        {
            var key = Key(entry);
            if (key is null) continue;
            Emit(entry, key);
        }
    }

    public static string? Key(EntryPoint entry) => entry switch
    {
        EntryPoint.PlayerUrl url => "url:" + url.Url.AbsoluteUri,
        EntryPoint.LepFile file => "lep:" + System.IO.Path.GetFullPath(file.Path),
        _ => null,
    };

    void Emit(EntryPoint entry, string key)
    {
        if (_lastDeliveredKey == key) return;
        _lastDeliveredKey = key;
        _deliver(entry);
    }
}

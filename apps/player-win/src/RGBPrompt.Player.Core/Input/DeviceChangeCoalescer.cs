namespace RGBPrompt.Player.Core.Input;

/// <summary>
/// Collapses a burst of HID arrival/removal notifications into one callback
/// after <see cref="Delay"/>. Mirrors the Mac <c>DeviceChangeCoalescer</c>
/// (300 ms default).
/// </summary>
public sealed class DeviceChangeCoalescer : IDisposable
{
    readonly TimeSpan _delay;
    readonly Action<TimeSpan, Action> _schedule;
    readonly object _gate = new();
    Timer? _timer;
    bool _scheduled;
    int _added;
    int _removed;

    public TimeSpan Delay => _delay;

    public DeviceChangeCoalescer(
        TimeSpan? delay = null,
        Action<TimeSpan, Action>? schedule = null)
    {
        _delay = delay ?? TimeSpan.FromMilliseconds(300);
        _schedule = schedule ?? DefaultSchedule;
    }

    public Action<int /*added*/, int /*removed*/>? OnFlush { get; set; }

    public void Record(int added = 0, int removed = 0)
    {
        bool shouldSchedule;
        lock (_gate)
        {
            _added += added;
            _removed += removed;
            shouldSchedule = !_scheduled;
            _scheduled = true;
        }

        if (!shouldSchedule) return;
        _schedule(_delay, Flush);
    }

    void DefaultSchedule(TimeSpan delay, Action action)
    {
        lock (_gate)
        {
            _timer?.Dispose();
            _timer = new Timer(_ => action(), null, delay, Timeout.InfiniteTimeSpan);
        }
    }

    void Flush()
    {
        int added, removed;
        lock (_gate)
        {
            _scheduled = false;
            added = _added;
            removed = _removed;
            _added = 0;
            _removed = 0;
        }
        OnFlush?.Invoke(added, removed);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _timer?.Dispose();
            _timer = null;
        }
    }
}

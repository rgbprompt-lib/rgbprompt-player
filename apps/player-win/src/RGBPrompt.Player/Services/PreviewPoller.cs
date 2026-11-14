using Microsoft.UI.Xaml;
using RGBPrompt.Player.Core.Interop;
using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player;

/// <summary>
/// Pulls <c>rgbp_preview_frame</c> at most 25 Hz while the panel is visible
/// and the core is playing. Publishes only when the sequence number changes.
/// </summary>
public sealed class PreviewPoller : IDisposable
{
    readonly PlayerCoreBridge _bridge;
    readonly DispatcherTimer _timer;
    PreviewFrame? _frame;

    public event Action<PreviewFrame?>? FrameChanged;

    public PreviewFrame? Frame => _frame;

    public PreviewPoller(PlayerCoreBridge bridge, TimeSpan? interval = null)
    {
        _bridge = bridge;
        _timer = new DispatcherTimer { Interval = interval ?? TimeSpan.FromMilliseconds(40) };
        _timer.Tick += (_, _) => PollOnce();
    }

    public bool IsRunning => _timer.IsEnabled;

    public void SetActive(bool active)
    {
        if (active)
        {
            if (!_timer.IsEnabled) _timer.Start();
            PollOnce();
        }
        else
        {
            _timer.Stop();
        }
    }

    public PreviewFrame? PollOnce()
    {
        var next = _bridge.PreviewFrame();
        if (next is { } frame && frame.Seq != _frame?.Seq)
        {
            _frame = frame;
            FrameChanged?.Invoke(_frame);
        }
        return next;
    }

    public void Dispose() => _timer.Stop();
}

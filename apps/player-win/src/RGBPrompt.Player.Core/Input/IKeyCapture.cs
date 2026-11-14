namespace RGBPrompt.Player.Core.Input;

/// <summary>WH_KEYBOARD_LL hook (M6-W3 / PLW-05). Callback must only enqueue.</summary>
public interface IKeyCapture : IDisposable
{
    bool IsRunning { get; }
    event Action<string /*ansi104*/, bool /*down*/>? KeyEvent;
    void Start();
    void Stop();
}

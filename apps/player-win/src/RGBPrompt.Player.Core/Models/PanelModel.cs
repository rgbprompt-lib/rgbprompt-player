namespace RGBPrompt.Player.Core.Models;

/// <summary>Remembers vendor-conflict names for the quit hint (PLAYER §8).</summary>
public sealed class VendorConflictSession
{
    readonly List<string> _names = new();

    public IReadOnlyList<string> Names => _names;

    public void Note(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return;
        foreach (var part in raw.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (!_names.Contains(part)) _names.Add(part);
        }
    }

    public string DisplayNames => string.Join(", ", _names);
    public bool IsEmpty => _names.Count == 0;
}

public sealed class PanelModel
{
    public string LastKeyboardName { get; private set; } = "";
    public VendorConflictSession Conflicts { get; } = new();

    public void Apply(PanelState state, string keyboardName)
    {
        LastKeyboardName = keyboardName.Trim();
        if (state is PanelState.VendorConflict conflict)
            Conflicts.Note(conflict.Name);
    }

    public bool HasConflictHint => !Conflicts.IsEmpty;
}

using System.IO.Pipes;
using System.Text;

namespace RGBPrompt.Player.Services;

/// <summary>Named-pipe single-instance guard. Second process forwards one line per arg then exits.</summary>
public static class SingleInstance
{
    const string PipeName = "RGBPrompt.Player.SingleInstance.v1";

    public static bool TryAcquire(out NamedPipeServerStream? server)
    {
        try
        {
            server = new NamedPipeServerStream(
                PipeName,
                PipeDirection.In,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);
            return true;
        }
        catch (IOException)
        {
            server = null;
            return false;
        }
    }

    public static void ForwardArgsAndExit(string[] args)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(500);
            using var writer = new StreamWriter(client, Encoding.UTF8) { AutoFlush = true };
            foreach (var arg in args)
                writer.WriteLine(arg);
        }
        catch
        {
            // Best-effort: the first instance may be shutting down.
        }
        Environment.Exit(0);
    }

    public static async Task ListenForForwardedArgs(
        NamedPipeServerStream server,
        Action<string> onArg)
    {
        while (true)
        {
            try
            {
                await server.WaitForConnectionAsync().ConfigureAwait(true);
                using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
                string? line;
                while ((line = await reader.ReadLineAsync().ConfigureAwait(true)) != null)
                {
                    if (!string.IsNullOrWhiteSpace(line))
                        onArg(line.Trim());
                }
                server.Disconnect();
            }
            catch
            {
                break;
            }
        }
    }
}

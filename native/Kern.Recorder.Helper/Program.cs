using System.Globalization;
using System.Text.Json;

namespace Kern.Recorder.Helper;

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--render")
            {
                if (args.Length == 4 && args[2] == "--through" && !string.IsNullOrWhiteSpace(args[1]))
                {
                    if (!long.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out var throughMs) || throughMs <= 0)
                        throw new ArgumentException("Usage: --render <absolute-session-directory> --through <positive-milliseconds>");
                    var live = CallRenderer.RenderThrough(args[1], throughMs);
                    Console.WriteLine(JsonSerializer.Serialize(new
                    {
                        complete = live.Complete,
                        sessionId = live.SessionId,
                        throughSamples = live.ThroughSamples,
                        windowCount = live.Windows.Count,
                        manifestPath = "derived/live-manifest.json",
                        peakPolicy = live.PeakPolicy,
                    }, Protocol.JsonOptions));
                    return 0;
                }
                if (args.Length != 2 || string.IsNullOrWhiteSpace(args[1]))
                    throw new ArgumentException("Usage: --render <absolute-session-directory> [--through <milliseconds>]");
                var manifest = CallRenderer.Render(args[1]);
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    complete = manifest.Complete,
                    sessionId = manifest.SessionId,
                    sourceFingerprint = manifest.SourceFingerprint,
                    manifestPath = "derived/manifest.json",
                    durationSeconds = manifest.DurationSeconds,
                    warnings = manifest.Warnings,
                }, Protocol.JsonOptions));
                return 0;
            }
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Kern recorder helper requires Windows.");
            var options = HelperOptions.Parse(args);
            using var server = new HelperServer(options);
            await server.RunAsync().ConfigureAwait(false);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"{error.GetType().Name}: {error.Message}");
            if (args.Length > 0 && args[0] == "--render")
                return error switch
                {
                    InvalidDataException => 20,
                    UnauthorizedAccessException => 21,
                    IOException => 22,
                    _ => 23,
                };
            return 1;
        }
    }
}

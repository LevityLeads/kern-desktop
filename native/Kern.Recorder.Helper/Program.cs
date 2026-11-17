namespace Kern.Recorder.Helper;

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Kern recorder helper requires Windows.");
            if (args.Length > 0 && args[0] == "--mic-watch") return await RunMicWatchAsync(args[1..]).ConfigureAwait(false);
            var options = HelperOptions.Parse(args);
            using var server = new HelperServer(options);
            await server.RunAsync().ConfigureAwait(false);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"{error.GetType().Name}: {error.Message}");
            return 1;
        }
    }

    // `--mic-watch --parent-pid <pid>`: report who holds the microphone until the parent exits.
    // Runs on the thread pool (MTA) end to end so the WASAPI COM objects never cross apartments
    // while the STA main thread sits in an await it does not pump.
    private static Task RunMicWatchCore(int parentPid, CancellationToken cancellationToken) => Task.Run(async () =>
    {
        using var source = new WasapiMicSessionSource();
        var watch = new MicWatch(source, [Environment.ProcessId, parentPid], Console.Out.WriteLine, () => Environment.TickCount64);
        await watch.RunAsync(cancellationToken).ConfigureAwait(false);
    });

    private static async Task<int> RunMicWatchAsync(string[] args)
    {
        if (args.Length != 2 || args[0] != "--parent-pid" ||
            !int.TryParse(args[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parentPid) || parentPid < 1)
            throw new ArgumentException("--mic-watch requires --parent-pid <pid>.");
        using var stop = new CancellationTokenSource();
        using var watchdog = new ParentWatchdog(parentPid, () => stop.Cancel());
        await RunMicWatchCore(parentPid, stop.Token).ConfigureAwait(false);
        return 0;
    }
}

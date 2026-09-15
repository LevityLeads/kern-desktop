namespace Kern.Recorder.Helper;

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Kern recorder helper requires Windows.");
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
}

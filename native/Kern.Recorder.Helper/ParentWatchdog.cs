using System.Diagnostics;

namespace Kern.Recorder.Helper;

internal sealed class ParentWatchdog : IDisposable
{
    private readonly Process parent;
    private readonly DateTime parentStartTimeUtc;
    private readonly CancellationTokenSource cancellation = new();
    private readonly Task monitor;

    public ParentWatchdog(int parentProcessId, Action onParentDeath)
    {
        try
        {
            parent = Process.GetProcessById(parentProcessId);
            parentStartTimeUtc = parent.StartTime.ToUniversalTime();
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException)
        {
            throw new InvalidOperationException("Desktop parent is not running.", error);
        }
        monitor = Task.Run(async () =>
        {
            try
            {
                while (!cancellation.Token.IsCancellationRequested)
                {
                    if (parent.HasExited || parent.StartTime.ToUniversalTime() != parentStartTimeUtc)
                    {
                        onParentDeath();
                        return;
                    }
                    await Task.Delay(250, cancellation.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            catch { onParentDeath(); }
        });
    }

    public void Dispose()
    {
        cancellation.Cancel();
        if (Task.CurrentId != monitor.Id)
        {
            try { monitor.Wait(TimeSpan.FromSeconds(1)); }
            catch { }
        }
        parent.Dispose();
        cancellation.Dispose();
    }
}

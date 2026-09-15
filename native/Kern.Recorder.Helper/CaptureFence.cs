namespace Kern.Recorder.Helper;

internal sealed class CaptureFence
{
    public object SyncRoot { get; } = new();
    public bool PersistAll { get; set; } = true;
    public bool PersistMicrophone { get; set; } = true;
    public long Generation { get; set; } = 1;
}

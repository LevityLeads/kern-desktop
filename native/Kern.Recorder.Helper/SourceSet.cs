namespace Kern.Recorder.Helper;

// One capture source for the life of a session. The WASAPI stream behind it may be closed and
// reopened many times; the slot, its pipeline (timeline cursor, counters) and its id persist.
// Mutated only under the engine lock; the capture thread touches just the pipeline and the fault.
internal sealed class SourceSlot(string id, int lane, string mode, string name, SourcePipeline pipeline, Func<ICaptureSource> open)
{
    internal enum Condition { Open, Recovering, Detached, Closed }

    private Exception? fault;
    private int generation;

    public string Id { get; } = id;
    public int Lane { get; } = lane;
    public string Mode { get; } = mode;
    public string Name { get; set; } = name;
    public SourcePipeline Pipeline { get; } = pipeline;
    public Func<ICaptureSource> Open { get; } = open;
    // Set for endpoint-loopback slots, which come and go with their device.
    public string? EndpointId { get; init; }
    public ICaptureSource? Source { get; set; }
    public Condition State { get; set; } = Condition.Recovering;
    public string? Message { get; set; }
    public long NextAttemptTicks { get; set; }

    // A late failure from a stream that was already replaced must not tear down its successor.
    public Action<Exception> FaultReporter()
    {
        var current = Interlocked.Increment(ref generation);
        return error =>
        {
            if (Volatile.Read(ref generation) == current) Interlocked.CompareExchange(ref fault, error, null);
        };
    }

    public Exception? TakeFault() => Interlocked.Exchange(ref fault, null);

    public string DisplayState(long nowTicks) => State switch
    {
        Condition.Open => Pipeline.LastPacketTicks is long last && nowTicks - last <= SourceSet.IdleTicks ? "active" : "idle",
        Condition.Recovering => "recovering",
        _ => "idle",
    };

    public SourceStatus Status(long nowTicks) => new(Id, CallAudio.LaneNames[Lane], Name, Mode, DisplayState(nowTicks),
        Pipeline.Level(nowTicks), Message, Pipeline.Stats());

    public SessionSource Record(long nowTicks) => new(Id, CallAudio.LaneNames[Lane], Name, Mode, DisplayState(nowTicks),
        Message, Pipeline.Stats());
}

// Opens, watches and reopens a session's sources. Nothing a source does escapes this class:
// a failed open or a stream that dies becomes a "recovering" slot retried every 2 s.
internal sealed class SourceSet
{
    public static readonly long RetryTicks = TimelineClock.Frequency * 2;
    public static readonly long IdleTicks = TimelineClock.Frequency * 2;

    private readonly List<SourceSlot> slots = [];

    public IReadOnlyList<SourceSlot> Slots => slots;

    public void Add(SourceSlot slot, long nowTicks)
    {
        slots.Add(slot);
        TryOpen(slot, nowTicks);
    }

    // Adds the slot only if its stream opens, for callers with a fallback when it does not.
    public bool TryAdd(SourceSlot slot, long nowTicks)
    {
        if (!TryOpen(slot, nowTicks)) return false;
        slots.Add(slot);
        return true;
    }

    // Returns true when any slot changed condition, so the caller can publish promptly.
    public bool Maintain(long nowTicks)
    {
        var changed = false;
        foreach (var slot in slots)
        {
            if (slot.TakeFault() is Exception fault && slot.State == SourceSlot.Condition.Open)
            {
                Close(slot, SourceSlot.Condition.Recovering, fault.Message);
                slot.NextAttemptTicks = nowTicks;
                changed = true;
            }
            if (slot.State == SourceSlot.Condition.Recovering && nowTicks >= slot.NextAttemptTicks)
                changed |= TryOpen(slot, nowTicks);
        }
        return changed;
    }

    // Endpoint-loopback mode: follow the set of active playback devices. A device that leaves
    // is detached (not retried); one that returns reopens into its old slot and counters.
    public bool Reconcile(IReadOnlyDictionary<string, string> activeEndpoints, long nowTicks,
        Func<string, string, SourceSlot> createSlot)
    {
        var changed = false;
        foreach (var slot in slots)
        {
            if (slot.EndpointId is not string endpointId) continue;
            var present = activeEndpoints.ContainsKey(endpointId);
            if (!present && slot.State is SourceSlot.Condition.Open or SourceSlot.Condition.Recovering)
            {
                Close(slot, SourceSlot.Condition.Detached, "Device is not connected.");
                changed = true;
            }
            else if (present && slot.State == SourceSlot.Condition.Detached)
            {
                slot.State = SourceSlot.Condition.Recovering;
                TryOpen(slot, nowTicks);
                changed = true;
            }
        }
        foreach (var (endpointId, name) in activeEndpoints)
        {
            if (slots.Any(slot => slot.EndpointId == endpointId)) continue;
            Add(createSlot(endpointId, name), nowTicks);
            changed = true;
        }
        return changed;
    }

    public void CloseAll()
    {
        foreach (var slot in slots) Close(slot, SourceSlot.Condition.Closed, slot.Message);
    }

    private static bool TryOpen(SourceSlot slot, long nowTicks)
    {
        ICaptureSource? source = null;
        try
        {
            source = slot.Open();
            slot.Pipeline.Bind(source.Format);
            source.Start(slot.Pipeline.Accept, slot.FaultReporter());
            slot.Source = source;
            slot.Name = source.Name;
            slot.State = SourceSlot.Condition.Open;
            slot.Message = null;
            return true;
        }
        catch (Exception error)
        {
            slot.Pipeline.Unbind();
            source?.Dispose();
            slot.State = SourceSlot.Condition.Recovering;
            slot.Message = error.Message;
            slot.NextAttemptTicks = nowTicks + RetryTicks;
            return false;
        }
    }

    private static void Close(SourceSlot slot, SourceSlot.Condition state, string? message)
    {
        var source = slot.Source;
        slot.Source = null;
        slot.Pipeline.Unbind();
        source?.Dispose();
        slot.State = state;
        slot.Message = message;
    }
}

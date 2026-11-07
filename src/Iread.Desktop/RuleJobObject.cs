using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

/// <summary>Unnamed, non-inherited job; nested jobs are supported on the target Windows platform.</summary>
internal sealed class RuleJobObject : IDisposable
{
    private readonly SafeFileHandle handle;
    internal RuleJobObject()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "RULE_WORKER: CreateJobObject");
        try
        {
            var limits = new ExtendedLimits
            {
                Basic = new BasicLimits
                {
                    // ACTIVE_PROCESS | PROCESS_MEMORY | JOB_MEMORY | DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE
                    Flags = 0x8 | 0x100 | 0x200 | 0x400 | 0x2000,
                    ActiveProcesses = 32
                },
                ProcessMemory = (UIntPtr)(768UL * 1024 * 1024),
                JobMemory = (UIntPtr)(1536UL * 1024 * 1024)
            };
            if (!SetExtended(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "RULE_WORKER: job resource limits");
            var cpu = new CpuLimits { Flags = 1 | 4, Rate = 2500 }; // Hard cap: 25% per task, four tasks maximum.
            if (!SetCpu(handle, 15, ref cpu, (uint)Marshal.SizeOf<CpuLimits>()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "RULE_WORKER: job CPU limit");
        }
        catch { handle.Dispose(); throw; }
    }
    internal void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "RULE_WORKER: AssignProcessToJobObject");
    }
    public void Dispose() => handle.Dispose();

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct CpuLimits { public uint Flags, Rate; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetExtended(SafeFileHandle job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCpu(SafeFileHandle job, int infoClass, ref CpuLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}

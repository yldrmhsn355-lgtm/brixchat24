using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ResourceRunner
{
    const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
    const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectCpuRateControlInformation = 15;
    const uint INFINITE = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] struct CPU_RATE { public uint ControlFlags, CpuRate; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);

    static void Check(bool value, string operation) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void SetStruct<T>(IntPtr job, int kind, T value) where T : struct
    {
        int size = Marshal.SizeOf(typeof(T)); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, buffer, false); Check(SetInformationJobObject(job, kind, buffer, (uint)size), "SetInformationJobObject"); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public static int Main(string[] args)
    {
        IntPtr job = IntPtr.Zero, process = IntPtr.Zero, thread = IntPtr.Zero;
        try {
            if (args.Length < 6 || args[0] != "--run") throw new ArgumentException("Usage: --run <name> <memoryMiB> <cpuPercent> <reportPath> <executable> [args]");
            string name = args[1], report = Path.GetFullPath(args[4]), executable = Path.GetFullPath(args[5]);
            int memoryMiB, cpuPercent;
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z0-9-]+$") || !int.TryParse(args[2], out memoryMiB) || memoryMiB < 128 || memoryMiB > 8192 || !int.TryParse(args[3], out cpuPercent) || cpuPercent < 1 || cpuPercent > 100)
                throw new ArgumentException("Invalid resource limits");
            if (!File.Exists(executable)) throw new FileNotFoundException("Child executable missing", executable);
            job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
            var limits = new EXTENDED_LIMIT();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            limits.JobMemoryLimit = new UIntPtr(checked((ulong)memoryMiB * 1024UL * 1024UL));
            SetStruct(job, JobObjectExtendedLimitInformation, limits);
            SetStruct(job, JobObjectCpuRateControlInformation, new CPU_RATE { ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, CpuRate = checked((uint)cpuPercent * 100U) });
            Directory.CreateDirectory(Path.GetDirectoryName(report));
            File.WriteAllText(report, "{\"component\":\"" + name + "\",\"jobMemoryMiB\":" + memoryMiB + ",\"cpuHardCapPercent\":" + cpuPercent + ",\"limitsApplied\":true,\"runnerPid\":" + Process.GetCurrentProcess().Id + ",\"appliedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
            var command = new StringBuilder(Quote(executable)); for (int i = 6; i < args.Length; i++) command.Append(' ').Append(Quote(args[i]));
            var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x100, hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
            PROCESS_INFORMATION created;
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out created), "CreateProcess");
            process = created.hProcess; thread = created.hThread;
            if (!AssignProcessToJobObject(job, process)) { TerminateProcess(process, 125); throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject"); }
            if (ResumeThread(thread) == 0xffffffff) { TerminateProcess(process, 125); throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread"); }
            WaitForSingleObject(process, INFINITE); uint code; Check(GetExitCodeProcess(process, out code), "GetExitCodeProcess"); return unchecked((int)code);
        } catch (Exception error) { Console.Error.WriteLine("ResourceRunner: " + error.Message); return 125; }
        finally { if (thread != IntPtr.Zero) CloseHandle(thread); if (process != IntPtr.Zero) CloseHandle(process); if (job != IntPtr.Zero) CloseHandle(job); }
    }
}

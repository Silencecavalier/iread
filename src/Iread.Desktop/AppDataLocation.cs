using System;
using System.IO;
using System.Text;
using System.Text.Json;

internal static class AppDataLocation
{
    internal static string PrepareProfile(string installDirectory, string localAppData, string isolatedDirectory = null)
    {
        if (!string.IsNullOrWhiteSpace(isolatedDirectory))
        {
            var isolated = Path.GetFullPath(isolatedDirectory);
            Directory.CreateDirectory(isolated);
            return isolated;
        }
        var target = Path.GetFullPath(Path.Combine(localAppData, "iread-plugin-data", "EBWebView"));
        if (Directory.Exists(target)) return target;
        var legacy = Path.Combine(installDirectory, "EBWebView");
        if (!Directory.Exists(legacy)) legacy = Path.Combine(localAppData, "iread-webview2", "EBWebView");
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        if (!Directory.Exists(legacy))
        {
            Directory.CreateDirectory(target);
            return target;
        }
        var staging = target + ".migration-" + Guid.NewGuid().ToString("N");
        try
        {
            CopyProfile(legacy, staging);
            Directory.Move(staging, target);
            return target;
        }
        catch (Exception ex)
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            throw new IOException("插件测试版首次启动的数据导入未完成，请关闭其它 iread 客户端后重试；原数据已保留。", ex);
        }
    }

    internal static string SaveRecoveryBackup(string profile, string text)
    {
        var encoding = new UTF8Encoding(false);
        if (string.IsNullOrEmpty(text) || encoding.GetByteCount(text) > 128 * 1024 * 1024)
            throw new ArgumentException("备份为空或超过 128 MiB 上限");
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("format", out var format) || format.GetString() != "iread-backup" ||
            !root.TryGetProperty("version", out var version) || !version.TryGetInt32(out var v) || v != 1 ||
            !root.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("local", out var local) || local.ValueKind != JsonValueKind.Array)
            throw new ArgumentException("备份格式不合法");
        var directory = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(profile)), "backups");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "iread-plugin-recovery-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N") + ".json");
        using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        var bytes = encoding.GetBytes(text);
        output.Write(bytes);
        output.Flush(true);
        return path;
    }

    private static void CopyProfile(string source, string target)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("数据目录包含链接，无法安全迁移。");
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("数据文件包含链接，无法安全迁移。");
            using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var output = new FileStream(Path.Combine(target, Path.GetFileName(file)), FileMode.CreateNew, FileAccess.Write, FileShare.None);
            input.CopyTo(output);
            output.Flush(true);
        }
        foreach (var directory in Directory.EnumerateDirectories(source))
            CopyProfile(directory, Path.Combine(target, Path.GetFileName(directory)));
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace AntigravityTaskbarMonitor
{
    internal sealed class QuotaPoolInfo
    {
        public string PoolKey;
        public string PoolLabel;
        public string PoolName;
        public bool Has5h;
        public bool HasWeekly;
        public double? RemainingPct;
        public int? RemainingIntPct;
        public double? UsedPct;
        public DateTime? ResetTimeUtc;
        public double? WeeklyRemainingPct;
        public int? WeeklyRemainingIntPct;
        public double? WeeklyUsedPct;
        public DateTime? WeeklyResetTimeUtc;
    }

    internal sealed class QuotaSnapshot
    {
        public long UpdatedAtMs;
        public long FetchedAtMs;
        public bool HasOfficialData;
        public bool IsStale;
        public bool RefreshFailed;
        public string ErrorMessage;
        public string ActivePoolKey;
        public List<QuotaPoolInfo> Pools;
        public string SourcePath;

        public QuotaSnapshot()
        {
            Pools = new List<QuotaPoolInfo>();
        }
    }

    internal struct BarMetricValue
    {
        public bool Available;
        public double Pct;
        public int IntPct;
        public DateTime? ResetTimeUtc;
    }

    internal enum BarLayoutMode
    {
        Hidden = 0,
        MiniText = 1,
        FullBars = 2
    }

    internal sealed class WidgetSettings
    {
        public string PinnedPoolKey;
        public string DisplayMode;
        public string ThemePreset;
        public string BarMode;
        public int OffsetX;
        public bool HideOnFullscreen;

        public WidgetSettings()
        {
            PinnedPoolKey = "auto";
            DisplayMode = "remaining";
            ThemePreset = "terracotta";
            BarMode = "auto";
            OffsetX = 0;
            HideOnFullscreen = true;
        }

        public WidgetSettings Clone()
        {
            var copy = new WidgetSettings();
            copy.PinnedPoolKey = PinnedPoolKey;
            copy.DisplayMode = DisplayMode;
            copy.ThemePreset = ThemePreset;
            copy.BarMode = BarMode;
            copy.OffsetX = OffsetX;
            copy.HideOnFullscreen = HideOnFullscreen;
            return copy;
        }
    }

    internal static class QuotaDataStore
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static string ResolveGeminiBaseDir()
        {
            string envDir = Environment.GetEnvironmentVariable("ANTIGRAVITY_GEMINI_DIR");
            if (!string.IsNullOrWhiteSpace(envDir))
            {
                return envDir.Trim();
            }
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".gemini");
        }

        public static string[] GetSnapshotCandidatePaths()
        {
            string geminiBase = ResolveGeminiBaseDir();
            return new string[]
            {
                Path.Combine(geminiBase, "antigravity", "sidecar_data", "usage-monitor", "panel", "data", "cli-status-snapshot.json"),
                Path.Combine(geminiBase, "antigravity-cli", "sidecar_data", "usage-monitor", "panel", "data", "cli-status-snapshot.json")
            };
        }

        public static string GetSettingsFilePath()
        {
            string geminiBase = ResolveGeminiBaseDir();
            return Path.Combine(geminiBase, "antigravity", "sidecar_data", "usage-monitor", "taskbar-widget-settings.json");
        }

        public static string DiscoverWebMonitorUrl()
        {
            string geminiBase = ResolveGeminiBaseDir();
            string[] dataDirs = new string[]
            {
                Path.Combine(geminiBase, "antigravity", "sidecar_data", "usage-monitor", "panel"),
                Path.Combine(geminiBase, "antigravity-cli", "sidecar_data", "usage-monitor", "panel")
            };

            for (int i = 0; i < dataDirs.Length; i++)
            {
                string settingsFile = Path.Combine(dataDirs[i], "settings.json");
                int standalonePort = ReadIntFieldFromJsonFile(settingsFile, "standalonePort");
                if (standalonePort >= 1024 && standalonePort <= 65535)
                {
                    return string.Format(CultureInfo.InvariantCulture, "http://127.0.0.1:{0}/", standalonePort);
                }

                string leaseFile = Path.Combine(dataDirs[i], "data", "window-bridge-lease.json");
                int bridgePort = ReadIntFieldFromJsonFile(leaseFile, "bridgePort");
                if (bridgePort >= 1024 && bridgePort <= 65535)
                {
                    return string.Format(CultureInfo.InvariantCulture, "http://127.0.0.1:{0}/", bridgePort);
                }
            }
            return null;
        }

        private static int ReadIntFieldFromJsonFile(string path, string fieldName)
        {
            try
            {
                if (!File.Exists(path)) return 0;
                string raw = ReadAllTextShared(path);
                var dict = Json.DeserializeObject(raw) as Dictionary<string, object>;
                if (dict == null) return 0;
                int? val = ReadNullableInt(dict, fieldName);
                return val.HasValue ? val.Value : 0;
            }
            catch
            {
                return 0;
            }
        }

        public static WidgetSettings LoadSettings()
        {
            var defaults = new WidgetSettings();
            try
            {
                string path = GetSettingsFilePath();
                if (!File.Exists(path)) return defaults;
                string raw = File.ReadAllText(path, Encoding.UTF8);
                var dict = Json.DeserializeObject(raw) as Dictionary<string, object>;
                if (dict == null) return defaults;

                string pinned = ReadString(dict, "pinnedPoolKey");
                if (!string.IsNullOrWhiteSpace(pinned)) defaults.PinnedPoolKey = pinned;

                string mode = ReadString(dict, "displayMode");
                if (string.Equals(mode, "used", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(mode, "remaining", StringComparison.OrdinalIgnoreCase))
                {
                    defaults.DisplayMode = mode.ToLowerInvariant();
                }

                string theme = ReadString(dict, "themePreset");
                if (string.Equals(theme, "terracotta", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(theme, "status", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(theme, "blue", StringComparison.OrdinalIgnoreCase))
                {
                    defaults.ThemePreset = theme.ToLowerInvariant();
                }

                string barMode = ReadString(dict, "barMode");
                if (string.Equals(barMode, "auto", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(barMode, "full", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(barMode, "mini", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(barMode, "trayonly", StringComparison.OrdinalIgnoreCase))
                {
                    defaults.BarMode = barMode.ToLowerInvariant();
                }

                int? offsetX = ReadNullableInt(dict, "offsetX");
                if (offsetX.HasValue)
                {
                    defaults.OffsetX = Math.Max(-1200, Math.Min(600, offsetX.Value));
                }

                bool? hideFs = ReadNullableBool(dict, "hideOnFullscreen");
                if (hideFs.HasValue)
                {
                    defaults.HideOnFullscreen = hideFs.Value;
                }
            }
            catch
            {
                // Ignore corrupted settings and fall back to defaults.
            }
            return defaults;
        }

        public static void SaveSettings(WidgetSettings settings)
        {
            if (settings == null) return;
            try
            {
                string path = GetSettingsFilePath();
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                var payload = new Dictionary<string, object>();
                payload["pinnedPoolKey"] = settings.PinnedPoolKey ?? "auto";
                payload["displayMode"] = settings.DisplayMode ?? "remaining";
                payload["themePreset"] = settings.ThemePreset ?? "terracotta";
                payload["barMode"] = settings.BarMode ?? "auto";
                payload["offsetX"] = settings.OffsetX;
                payload["hideOnFullscreen"] = settings.HideOnFullscreen;

                string json = Json.Serialize(payload);
                string tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllText(tmp, json, new UTF8Encoding(false));
                    if (File.Exists(path))
                    {
                        try
                        {
                            File.Replace(tmp, path, null);
                        }
                        catch
                        {
                            File.Copy(tmp, path, true);
                        }
                    }
                    else
                    {
                        File.Move(tmp, path);
                    }
                }
                finally
                {
                    try
                    {
                        if (File.Exists(tmp)) File.Delete(tmp);
                    }
                    catch
                    {
                        // Ignore temp cleanup failure.
                    }
                }
            }
            catch
            {
                // Non-fatal persistence failure.
            }
        }

        public static QuotaSnapshot LoadFreshestSnapshot()
        {
            string[] candidates = GetSnapshotCandidatePaths();
            QuotaSnapshot best = null;
            for (int i = 0; i < candidates.Length; i++)
            {
                string file = candidates[i];
                try
                {
                    if (!File.Exists(file)) continue;
                    string raw = ReadAllTextShared(file);
                    QuotaSnapshot parsed = ParseSnapshotJson(raw, file);
                    if (parsed == null) continue;
                    if (best == null || parsed.UpdatedAtMs > best.UpdatedAtMs)
                    {
                        best = parsed;
                    }
                }
                catch
                {
                    // Skip unreadable or transiently written file.
                }
            }
            return best;
        }

        private static string ReadAllTextShared(string file)
        {
            using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var sr = new StreamReader(fs, Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        public static QuotaSnapshot ParseSnapshotJson(string rawJson, string sourcePath)
        {
            if (string.IsNullOrWhiteSpace(rawJson)) return null;
            Dictionary<string, object> root;
            try
            {
                root = Json.DeserializeObject(rawJson) as Dictionary<string, object>;
            }
            catch
            {
                return null;
            }
            if (root == null) return null;

            var snap = new QuotaSnapshot();
            snap.SourcePath = sourcePath;
            snap.UpdatedAtMs = ReadLong(root, "updatedAtMs", 0);

            var quotas = ReadDict(root, "quotas");
            if (quotas == null) return snap;

            var meta = ReadDict(quotas, "meta");
            if (meta != null)
            {
                snap.FetchedAtMs = ReadLong(meta, "fetchedAtMs", snap.UpdatedAtMs);
                snap.HasOfficialData = ReadNullableBool(meta, "hasOfficialData") ?? false;
                snap.IsStale = ReadNullableBool(meta, "isStale") ?? false;
                snap.RefreshFailed = ReadNullableBool(meta, "refreshFailed") ?? false;
                snap.ErrorMessage = ReadString(meta, "errorMessage");
            }

            var activePool = ReadDict(quotas, "activePool");
            if (activePool != null)
            {
                snap.ActivePoolKey = ReadString(activePool, "poolKey");
            }

            var poolsArr = ReadArray(quotas, "pools");
            if (poolsArr != null)
            {
                for (int i = 0; i < poolsArr.Length; i++)
                {
                    var pDict = poolsArr[i] as Dictionary<string, object>;
                    if (pDict == null) continue;
                    QuotaPoolInfo pool = ParsePool(pDict);
                    if (pool != null)
                    {
                        snap.Pools.Add(pool);
                    }
                }
            }

            if (snap.Pools.Count == 0 && activePool != null)
            {
                QuotaPoolInfo fallbackPool = ParsePool(activePool);
                if (fallbackPool != null)
                {
                    snap.Pools.Add(fallbackPool);
                }
            }

            return snap;
        }

        private static QuotaPoolInfo ParsePool(Dictionary<string, object> dict)
        {
            if (dict == null) return null;
            string poolKey = ReadString(dict, "poolKey");
            string poolLabel = ReadString(dict, "poolLabel");
            string poolName = ReadString(dict, "poolName");
            if (string.IsNullOrWhiteSpace(poolKey) && string.IsNullOrWhiteSpace(poolLabel))
            {
                return null;
            }

            var info = new QuotaPoolInfo();
            info.PoolKey = !string.IsNullOrWhiteSpace(poolKey) ? poolKey : poolLabel;
            info.PoolLabel = !string.IsNullOrWhiteSpace(poolLabel) ? poolLabel : info.PoolKey;
            info.PoolName = !string.IsNullOrWhiteSpace(poolName) ? poolName : info.PoolLabel;
            info.Has5h = ReadNullableBool(dict, "has5h") ?? false;
            info.HasWeekly = ReadNullableBool(dict, "hasWeekly") ?? false;
            info.RemainingPct = ReadNullableDouble(dict, "remainingPct");
            info.RemainingIntPct = ReadNullableInt(dict, "remainingIntPct");
            info.UsedPct = ReadNullableDouble(dict, "usedPct");
            info.ResetTimeUtc = ParseIsoUtc(ReadString(dict, "resetTime"));
            info.WeeklyRemainingPct = ReadNullableDouble(dict, "weeklyRemainingPct");
            info.WeeklyRemainingIntPct = ReadNullableInt(dict, "weeklyRemainingIntPct");
            info.WeeklyUsedPct = ReadNullableDouble(dict, "weeklyUsedPct");
            info.WeeklyResetTimeUtc = ParseIsoUtc(ReadString(dict, "weeklyResetTime"));
            return info;
        }

        public static QuotaPoolInfo ResolveTargetPool(QuotaSnapshot snap, string pinnedPoolKey)
        {
            if (snap == null || snap.Pools == null || snap.Pools.Count == 0) return null;

            if (!string.IsNullOrWhiteSpace(pinnedPoolKey) &&
                !string.Equals(pinnedPoolKey, "auto", StringComparison.OrdinalIgnoreCase))
            {
                for (int i = 0; i < snap.Pools.Count; i++)
                {
                    if (string.Equals(snap.Pools[i].PoolKey, pinnedPoolKey, StringComparison.OrdinalIgnoreCase))
                    {
                        return snap.Pools[i];
                    }
                }
            }

            if (!string.IsNullOrWhiteSpace(snap.ActivePoolKey))
            {
                for (int i = 0; i < snap.Pools.Count; i++)
                {
                    if (string.Equals(snap.Pools[i].PoolKey, snap.ActivePoolKey, StringComparison.OrdinalIgnoreCase))
                    {
                        return snap.Pools[i];
                    }
                }
            }

            return snap.Pools[0];
        }

        public static BarMetricValue GetBarMetric(QuotaPoolInfo pool, bool isWeekly, string displayMode)
        {
            var result = new BarMetricValue();
            if (pool == null) return result;

            bool hasWindow = isWeekly ? pool.HasWeekly : pool.Has5h;
            double? rem = isWeekly ? pool.WeeklyRemainingPct : pool.RemainingPct;
            int? remInt = isWeekly ? pool.WeeklyRemainingIntPct : pool.RemainingIntPct;
            double? used = isWeekly ? pool.WeeklyUsedPct : pool.UsedPct;
            DateTime? reset = isWeekly ? pool.WeeklyResetTimeUtc : pool.ResetTimeUtc;

            if (!hasWindow || (!rem.HasValue && !used.HasValue))
            {
                result.Available = false;
                return result;
            }

            double remVal = rem.HasValue ? ClampPct(rem.Value) : ClampPct(100.0 - used.Value);
            double usedVal = used.HasValue ? ClampPct(used.Value) : ClampPct(100.0 - remVal);

            bool isUsedMode = string.Equals(displayMode, "used", StringComparison.OrdinalIgnoreCase);
            double chosen = isUsedMode ? usedVal : remVal;
            int chosenInt;
            if (!isUsedMode && remInt.HasValue)
            {
                chosenInt = Math.Max(0, Math.Min(100, remInt.Value));
            }
            else
            {
                chosenInt = (int)Math.Floor(chosen + 1e-6);
            }

            result.Available = true;
            result.Pct = chosen;
            result.IntPct = chosenInt;
            result.ResetTimeUtc = reset;
            return result;
        }

        public static BarLayoutMode ResolveDisplayLayoutMode(
            string barModeSetting,
            bool hasFreeSpaceInfo,
            int freeSpacePx,
            int fullBarWidth,
            int miniTextWidth)
        {
            if (string.Equals(barModeSetting, "trayonly", StringComparison.OrdinalIgnoreCase))
            {
                return BarLayoutMode.Hidden;
            }
            if (string.Equals(barModeSetting, "full", StringComparison.OrdinalIgnoreCase))
            {
                return BarLayoutMode.FullBars;
            }
            if (string.Equals(barModeSetting, "mini", StringComparison.OrdinalIgnoreCase))
            {
                return BarLayoutMode.MiniText;
            }

            // "auto" mode: dynamically avoid covering taskbar shortcuts
            if (!hasFreeSpaceInfo)
            {
                return BarLayoutMode.FullBars;
            }
            if (freeSpacePx >= fullBarWidth)
            {
                return BarLayoutMode.FullBars;
            }
            if (freeSpacePx >= miniTextWidth)
            {
                return BarLayoutMode.MiniText;
            }
            return BarLayoutMode.Hidden;
        }

        public static string FormatCompactCountdown(DateTime? resetUtc, DateTime utcNow)
        {
            if (!resetUtc.HasValue) return string.Empty;
            TimeSpan diff = resetUtc.Value - utcNow;
            if (diff.TotalSeconds <= 0) return "0m";
            if (diff.TotalHours >= 24.0)
            {
                int days = (int)Math.Floor(diff.TotalDays);
                return string.Format(CultureInfo.InvariantCulture, "{0}d", days);
            }
            if (diff.TotalMinutes >= 60.0)
            {
                int hours = (int)Math.Floor(diff.TotalHours);
                return string.Format(CultureInfo.InvariantCulture, "{0}h", hours);
            }
            int mins = Math.Max(1, (int)Math.Ceiling(diff.TotalMinutes));
            return string.Format(CultureInfo.InvariantCulture, "{0}m", mins);
        }

        public static string FormatDetailedCountdown(DateTime? resetUtc, DateTime utcNow)
        {
            if (!resetUtc.HasValue) return "--";
            TimeSpan diff = resetUtc.Value - utcNow;
            if (diff.TotalSeconds <= 0) return "已重設";
            if (diff.TotalDays >= 1.0)
            {
                int days = (int)Math.Floor(diff.TotalDays);
                int hours = diff.Hours;
                return hours > 0
                    ? string.Format(CultureInfo.InvariantCulture, "{0}d {1}h", days, hours)
                    : string.Format(CultureInfo.InvariantCulture, "{0}d", days);
            }
            if (diff.TotalHours >= 1.0)
            {
                int hours = (int)Math.Floor(diff.TotalHours);
                int mins = diff.Minutes;
                return mins > 0
                    ? string.Format(CultureInfo.InvariantCulture, "{0}h {1}m", hours, mins)
                    : string.Format(CultureInfo.InvariantCulture, "{0}h", hours);
            }
            int m = Math.Max(1, (int)Math.Ceiling(diff.TotalMinutes));
            return string.Format(CultureInfo.InvariantCulture, "{0}m", m);
        }

        public static string FormatFreshness(long updatedAtMs, DateTime utcNow)
        {
            if (updatedAtMs <= 0) return "無更新時間";
            DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            DateTime updatedUtc = epoch.AddMilliseconds(updatedAtMs);
            TimeSpan age = utcNow - updatedUtc;
            if (age.TotalSeconds < 60) return "剛剛更新";
            if (age.TotalMinutes < 60)
            {
                return string.Format(CultureInfo.InvariantCulture, "{0} 分鐘前", (int)Math.Floor(age.TotalMinutes));
            }
            return string.Format(CultureInfo.InvariantCulture, "{0} 小時前", (int)Math.Floor(age.TotalHours));
        }

        private static double ClampPct(double val)
        {
            if (double.IsNaN(val) || double.IsInfinity(val)) return 0;
            if (val < 0) return 0;
            if (val > 100) return 100;
            return val;
        }

        private static DateTime? ParseIsoUtc(string iso)
        {
            if (string.IsNullOrWhiteSpace(iso)) return null;
            DateTime dt;
            if (DateTime.TryParse(
                iso,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out dt))
            {
                return dt;
            }
            return null;
        }

        private static Dictionary<string, object> ReadDict(Dictionary<string, object> parent, string key)
        {
            object val;
            if (parent != null && parent.TryGetValue(key, out val))
            {
                return val as Dictionary<string, object>;
            }
            return null;
        }

        private static object[] ReadArray(Dictionary<string, object> parent, string key)
        {
            object val;
            if (parent == null || !parent.TryGetValue(key, out val) || val == null) return null;
            var arr = val as object[];
            if (arr != null) return arr;
            var list = val as ArrayList;
            if (list != null) return list.ToArray();
            return null;
        }

        private static string ReadString(Dictionary<string, object> parent, string key)
        {
            object val;
            if (parent != null && parent.TryGetValue(key, out val) && val != null)
            {
                return Convert.ToString(val, CultureInfo.InvariantCulture);
            }
            return null;
        }

        private static long ReadLong(Dictionary<string, object> parent, string key, long fallback)
        {
            object val;
            if (parent != null && parent.TryGetValue(key, out val) && val != null)
            {
                try
                {
                    return Convert.ToInt64(val, CultureInfo.InvariantCulture);
                }
                catch
                {
                    return fallback;
                }
            }
            return fallback;
        }

        private static int? ReadNullableInt(Dictionary<string, object> parent, string key)
        {
            object val;
            if (parent != null && parent.TryGetValue(key, out val) && val != null)
            {
                try
                {
                    return Convert.ToInt32(val, CultureInfo.InvariantCulture);
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }

        private static double? ReadNullableDouble(Dictionary<string, object> parent, string key)
        {
            object val;
            if (parent != null && parent.TryGetValue(key, out val) && val != null)
            {
                try
                {
                    return Convert.ToDouble(val, CultureInfo.InvariantCulture);
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }

        private static bool? ReadNullableBool(Dictionary<string, object> parent, string key)
        {
            object val;
            if (parent != null && parent.TryGetValue(key, out val) && val != null)
            {
                try
                {
                    return Convert.ToBoolean(val, CultureInfo.InvariantCulture);
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }
    }
}

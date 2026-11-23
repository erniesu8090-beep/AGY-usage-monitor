using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
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

    internal enum QuotaResetKind
    {
        Scheduled = 0,
        Early = 1
    }

    internal sealed class QuotaResetEvent
    {
        public string PoolKey;
        public string PoolLabel;
        public bool IsWeekly;
        public QuotaResetKind Kind;
        public double PreviousPct;
        public double CurrentPct;
        public DateTime? PreviousResetUtc;
        public DateTime? CurrentResetUtc;
    }

    internal sealed class QuotaResetDetector
    {
        private sealed class WindowBaseline
        {
            public double RemainingPct;
            public DateTime? ResetTimeUtc;
        }

        private readonly Dictionary<string, WindowBaseline> _baselines =
            new Dictionary<string, WindowBaseline>(StringComparer.OrdinalIgnoreCase);

        private static readonly DateTime UnixEpochUtc = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public List<QuotaResetEvent> Evaluate(QuotaSnapshot snapshot, DateTime utcNow)
        {
            var events = new List<QuotaResetEvent>();
            if (snapshot == null ||
                !snapshot.HasOfficialData ||
                snapshot.IsStale ||
                snapshot.RefreshFailed ||
                snapshot.Pools == null ||
                snapshot.Pools.Count == 0)
            {
                return events;
            }

            long refMs = snapshot.FetchedAtMs > 0 ? snapshot.FetchedAtMs : snapshot.UpdatedAtMs;
            DateTime evalUtc = refMs > 0 ? UnixEpochUtc.AddMilliseconds(refMs) : utcNow;

            for (int i = 0; i < snapshot.Pools.Count; i++)
            {
                QuotaPoolInfo pool = snapshot.Pools[i];
                if (pool == null || string.IsNullOrWhiteSpace(pool.PoolKey)) continue;

                EvaluateWindow(pool, false, evalUtc, events);
                EvaluateWindow(pool, true, evalUtc, events);
            }

            return events;
        }

        private void EvaluateWindow(
            QuotaPoolInfo pool,
            bool isWeekly,
            DateTime evalUtc,
            List<QuotaResetEvent> events)
        {
            BarMetricValue metric = QuotaDataStore.GetBarMetric(pool, isWeekly, "remaining");
            if (!metric.Available) return;

            string key = pool.PoolKey + "|" + (isWeekly ? "7d" : "5h");
            WindowBaseline prev;
            if (_baselines.TryGetValue(key, out prev))
            {
                double delta = metric.Pct - prev.RemainingPct;
                bool jumpedSignificantly = delta >= 15.0 || (prev.RemainingPct < 95.0 && metric.Pct >= 99.5);
                if (jumpedSignificantly)
                {
                    bool isEarly = !prev.ResetTimeUtc.HasValue ||
                                   prev.ResetTimeUtc.Value > evalUtc.AddMinutes(2.0);
                    var ev = new QuotaResetEvent();
                    ev.PoolKey = pool.PoolKey;
                    ev.PoolLabel = !string.IsNullOrWhiteSpace(pool.PoolLabel) ? pool.PoolLabel : pool.PoolKey;
                    ev.IsWeekly = isWeekly;
                    ev.Kind = isEarly ? QuotaResetKind.Early : QuotaResetKind.Scheduled;
                    ev.PreviousPct = prev.RemainingPct;
                    ev.CurrentPct = metric.Pct;
                    ev.PreviousResetUtc = prev.ResetTimeUtc;
                    ev.CurrentResetUtc = metric.ResetTimeUtc;
                    events.Add(ev);
                }

                prev.RemainingPct = metric.Pct;
                prev.ResetTimeUtc = metric.ResetTimeUtc;
            }
            else
            {
                var baseline = new WindowBaseline();
                baseline.RemainingPct = metric.Pct;
                baseline.ResetTimeUtc = metric.ResetTimeUtc;
                _baselines[key] = baseline;
            }
        }

        public static List<QuotaResetEvent> FilterEvents(List<QuotaResetEvent> events, string resetNotifyMode)
        {
            var filtered = new List<QuotaResetEvent>();
            if (events == null || events.Count == 0) return filtered;
            if (string.Equals(resetNotifyMode, "off", StringComparison.OrdinalIgnoreCase))
            {
                return filtered;
            }

            bool onlyEarly = !string.Equals(resetNotifyMode, "all", StringComparison.OrdinalIgnoreCase);
            for (int i = 0; i < events.Count; i++)
            {
                QuotaResetEvent ev = events[i];
                if (ev == null) continue;
                if (onlyEarly && ev.Kind != QuotaResetKind.Early) continue;
                filtered.Add(ev);
            }
            return filtered;
        }

        public static void FormatBalloonNotification(
            List<QuotaResetEvent> events,
            out string title,
            out string body)
        {
            if (events == null || events.Count == 0)
            {
                title = string.Empty;
                body = string.Empty;
                return;
            }

            bool hasEarly = false;
            for (int i = 0; i < events.Count; i++)
            {
                if (events[i].Kind == QuotaResetKind.Early)
                {
                    hasEarly = true;
                    break;
                }
            }

            if (events.Count == 1)
            {
                QuotaResetEvent ev = events[0];
                string win = ev.IsWeekly ? "7d" : "5h";
                title = ev.Kind == QuotaResetKind.Early
                    ? "Antigravity 配額提前重設"
                    : "Antigravity 配額已重設";
                body = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0} ({1}) 已從 {2}% 恢復至 {3}%",
                    ev.PoolLabel,
                    win,
                    (int)Math.Floor(ev.PreviousPct + 1e-6),
                    (int)Math.Floor(ev.CurrentPct + 1e-6));
                return;
            }

            title = hasEarly
                ? string.Format(CultureInfo.InvariantCulture, "Antigravity {0} 項配額提前重設", events.Count)
                : string.Format(CultureInfo.InvariantCulture, "Antigravity {0} 項配額已重設", events.Count);

            var sb = new StringBuilder();
            int limit = Math.Min(events.Count, 4);
            for (int i = 0; i < limit; i++)
            {
                QuotaResetEvent ev = events[i];
                string win = ev.IsWeekly ? "7d" : "5h";
                if (i > 0) sb.Append("；");
                sb.AppendFormat(
                    CultureInfo.InvariantCulture,
                    "{0}({1}) {2}%→{3}%",
                    ev.PoolLabel,
                    win,
                    (int)Math.Floor(ev.PreviousPct + 1e-6),
                    (int)Math.Floor(ev.CurrentPct + 1e-6));
            }
            if (events.Count > limit)
            {
                sb.AppendFormat(CultureInfo.InvariantCulture, " 等共 {0} 項", events.Count);
            }
            body = sb.ToString();
        }
    }

    internal sealed class WidgetSettings
    {
        public string PinnedPoolKey;
        public string DisplayMode;
        public string ThemePreset;
        public string BarMode;
        public int OffsetX;
        public bool HideOnFullscreen;
        public string ResetNotifyMode;
        public bool NotifySound;
        public bool AutoPollWebMonitor;

        public WidgetSettings()
        {
            PinnedPoolKey = "auto";
            DisplayMode = "remaining";
            ThemePreset = "terracotta";
            BarMode = "auto";
            OffsetX = 0;
            HideOnFullscreen = true;
            ResetNotifyMode = "early";
            NotifySound = true;
            AutoPollWebMonitor = true;
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
            copy.ResetNotifyMode = ResetNotifyMode;
            copy.NotifySound = NotifySound;
            copy.AutoPollWebMonitor = AutoPollWebMonitor;
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

        public static string[] GetPanelDataCandidateDirs()
        {
            string geminiBase = ResolveGeminiBaseDir();
            string[] productRoots = new string[]
            {
                "antigravity",
                "antigravity-cli",
                "antigravity-ide",
                "antigravity-idea"
            };
            var dirs = new string[productRoots.Length];
            for (int i = 0; i < productRoots.Length; i++)
            {
                dirs[i] = Path.Combine(geminiBase, productRoots[i], "sidecar_data", "usage-monitor", "panel", "data");
            }
            return dirs;
        }

        public static string[] GetSnapshotCandidatePaths()
        {
            string[] dataDirs = GetPanelDataCandidateDirs();
            var paths = new string[dataDirs.Length];
            for (int i = 0; i < dataDirs.Length; i++)
            {
                paths[i] = Path.Combine(dataDirs[i], "cli-status-snapshot.json");
            }
            return paths;
        }

        public static string GetSettingsFilePath()
        {
            string geminiBase = ResolveGeminiBaseDir();
            return Path.Combine(geminiBase, "antigravity", "sidecar_data", "usage-monitor", "taskbar-widget-settings.json");
        }

        public static bool TryTriggerWebMonitorRefresh(int timeoutMs)
        {
            string baseUrl = DiscoverWebMonitorUrl();
            if (string.IsNullOrEmpty(baseUrl)) return false;

            int effectiveTimeout = timeoutMs > 0 ? timeoutMs : 8000;
            try
            {
                string endpoint = baseUrl.TrimEnd('/') + "/api/telemetry?force=1";
                var req = (HttpWebRequest)WebRequest.Create(endpoint);
                req.Method = "GET";
                req.Proxy = null;
                req.Timeout = effectiveTimeout;
                req.ReadWriteTimeout = effectiveTimeout;
                req.UserAgent = "AntigravityTaskbarMonitor/1.0";
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    int code = (int)resp.StatusCode;
                    return code >= 200 && code < 300;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool IsSnapshotOlderThan(QuotaSnapshot snap, DateTime utcNow, double thresholdSeconds)
        {
            if (snap == null || snap.UpdatedAtMs <= 0) return true;
            DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            DateTime updatedUtc = epoch.AddMilliseconds(snap.UpdatedAtMs);
            return (utcNow - updatedUtc).TotalSeconds >= thresholdSeconds;
        }

        public static string DiscoverWebMonitorUrl()
        {
            return DiscoverWebMonitorUrl(IsLocalPortListening);
        }

        public static string DiscoverWebMonitorUrl(Func<int, bool> portProbe)
        {
            Func<int, bool> probe = portProbe ?? IsLocalPortListening;
            string[] dataDirs = GetPanelDataCandidateDirs();
            var candidates = new[]
            {
                new { FileName = "standalone-runtime.json", FieldName = "port" },
                new { FileName = "settings.json", FieldName = "standalonePort" }
            };

            for (int c = 0; c < candidates.Length; c++)
            {
                for (int i = 0; i < dataDirs.Length; i++)
                {
                    string filePath = Path.Combine(dataDirs[i], candidates[c].FileName);
                    int port = ReadIntFieldFromJsonFile(filePath, candidates[c].FieldName);
                    if (port >= 1024 && port <= 65535 && probe(port))
                    {
                        return string.Format(CultureInfo.InvariantCulture, "http://127.0.0.1:{0}/", port);
                    }
                }
            }
            return null;
        }

        public static bool IsLocalPortListening(int port)
        {
            if (port < 1024 || port > 65535) return false;
            TcpClient client = null;
            try
            {
                client = new TcpClient(AddressFamily.InterNetwork);
                IAsyncResult ar = client.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(80))
                {
                    return false;
                }
                client.EndConnect(ar);
                return client.Connected;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (client != null)
                {
                    try { client.Close(); }
                    catch { }
                }
            }
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

                string notifyMode = ReadString(dict, "resetNotifyMode");
                if (string.Equals(notifyMode, "early", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(notifyMode, "all", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(notifyMode, "off", StringComparison.OrdinalIgnoreCase))
                {
                    defaults.ResetNotifyMode = notifyMode.ToLowerInvariant();
                }

                bool? notifySound = ReadNullableBool(dict, "notifySound");
                if (notifySound.HasValue)
                {
                    defaults.NotifySound = notifySound.Value;
                }

                bool? autoPoll = ReadNullableBool(dict, "autoPollWebMonitor");
                if (autoPoll.HasValue)
                {
                    defaults.AutoPollWebMonitor = autoPoll.Value;
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
                payload["resetNotifyMode"] = settings.ResetNotifyMode ?? "early";
                payload["notifySound"] = settings.NotifySound;
                payload["autoPollWebMonitor"] = settings.AutoPollWebMonitor;

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

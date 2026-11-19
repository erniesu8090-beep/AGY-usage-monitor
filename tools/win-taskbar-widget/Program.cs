using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace AntigravityTaskbarMonitor
{
    internal static class Program
    {
        private const string SingleInstanceMutexName = @"Local\AntigravityUsageMonitorTaskbarWidget";

        [STAThread]
        private static int Main(string[] args)
        {
            if (args != null && args.Length > 0 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                return RunSelfTests();
            }

            TaskbarLocator.EnablePerMonitorDpiAwareness();

            bool createdNew;
            using (var mutex = new Mutex(true, SingleInstanceMutexName, out createdNew))
            {
                if (!createdNew)
                {
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var form = new TaskbarBarForm())
                {
                    Application.Run(form);
                }
            }
            return 0;
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException("ASSERTION FAILED: " + message);
            }
        }

        private static int RunSelfTests()
        {
            int passed = 0;
            try
            {
                // 1. Parse multi-pool snapshot JSON (including Argon with has5h=false)
                string sampleJson = @"{
                    ""updatedAtMs"": 1795093216865,
                    ""quotas"": {
                        ""meta"": { ""fetchedAtMs"": 1795093214549, ""hasOfficialData"": true, ""isStale"": false, ""refreshFailed"": false },
                        ""activePool"": { ""poolKey"": ""Gemini"", ""poolLabel"": ""Gemini"" },
                        ""pools"": [
                            {
                                ""poolKey"": ""Gemini"",
                                ""poolLabel"": ""Gemini"",
                                ""has5h"": true, ""hasWeekly"": true,
                                ""remainingPct"": 76.8, ""remainingIntPct"": 76, ""usedPct"": 23.2, ""resetTime"": ""2026-11-19T17:05:35Z"",
                                ""weeklyRemainingPct"": 39.3, ""weeklyRemainingIntPct"": 39, ""weeklyUsedPct"": 60.7, ""weeklyResetTime"": ""2026-11-25T00:35:40Z""
                            },
                            {
                                ""poolKey"": ""Argon"",
                                ""poolLabel"": ""Gemini 4 Argon"",
                                ""has5h"": false, ""hasWeekly"": true,
                                ""remainingPct"": null, ""remainingIntPct"": null, ""usedPct"": null, ""resetTime"": null,
                                ""weeklyRemainingPct"": 23.7, ""weeklyRemainingIntPct"": 23, ""weeklyUsedPct"": 76.3, ""weeklyResetTime"": ""2026-11-25T02:51:58Z""
                            }
                        ]
                    }
                }";

                QuotaSnapshot snap = QuotaDataStore.ParseSnapshotJson(sampleJson, "memory://sample");
                Assert(snap != null, "Snapshot should parse");
                Assert(snap.Pools.Count == 2, "Expected 2 pools");
                Assert(snap.ActivePoolKey == "Gemini", "Active pool should be Gemini");
                passed++;

                // 2. Pool resolution & remaining vs used mode
                QuotaPoolInfo autoPool = QuotaDataStore.ResolveTargetPool(snap, "auto");
                Assert(autoPool != null && autoPool.PoolKey == "Gemini", "Auto should pick activePool Gemini");

                BarMetricValue rem5 = QuotaDataStore.GetBarMetric(autoPool, false, "remaining");
                Assert(rem5.Available && rem5.IntPct == 76 && Math.Abs(rem5.Pct - 76.8) < 0.01, "Remaining 5h should be 76% (76.8)");

                BarMetricValue used5 = QuotaDataStore.GetBarMetric(autoPool, false, "used");
                Assert(used5.Available && used5.IntPct == 23 && Math.Abs(used5.Pct - 23.2) < 0.01, "Used 5h should be 23% (23.2)");
                passed++;

                // 3. Argon pool where has5h is false
                QuotaPoolInfo argon = QuotaDataStore.ResolveTargetPool(snap, "Argon");
                Assert(argon != null && argon.PoolKey == "Argon", "Pinned Argon should resolve");
                BarMetricValue argon5 = QuotaDataStore.GetBarMetric(argon, false, "remaining");
                BarMetricValue argon7 = QuotaDataStore.GetBarMetric(argon, true, "remaining");
                Assert(!argon5.Available, "Argon 5h should be unavailable");
                Assert(argon7.Available && argon7.IntPct == 23, "Argon weekly should be 23%");
                passed++;

                // 4. Countdown formatting
                DateTime now = new DateTime(2026, 11, 19, 13, 0, 0, DateTimeKind.Utc);
                Assert(QuotaDataStore.FormatCompactCountdown(now.AddHours(2).AddMinutes(15), now) == "2h", "2h15m compact -> 2h");
                Assert(QuotaDataStore.FormatCompactCountdown(now.AddMinutes(45), now) == "45m", "45m compact -> 45m");
                Assert(QuotaDataStore.FormatCompactCountdown(now.AddDays(4).AddHours(5), now) == "4d", "4d5h compact -> 4d");
                Assert(QuotaDataStore.FormatCompactCountdown(now.AddMinutes(-1), now) == "0m", "Expired -> 0m");
                Assert(QuotaDataStore.FormatCompactCountdown(null, now) == string.Empty, "Null -> empty");
                Assert(QuotaDataStore.FormatDetailedCountdown(now.AddDays(4).AddHours(5), now) == "4d 5h", "Detailed 4d 5h");
                passed++;

                // 5. Malformed JSON handling
                Assert(QuotaDataStore.ParseSnapshotJson("{bad json", "bad") == null, "Malformed JSON should return null");
                Assert(QuotaDataStore.ParseSnapshotJson("", "empty") == null, "Empty JSON should return null");
                passed++;

                // 6. Settings round-trip in isolated temp dir
                string prevEnv = Environment.GetEnvironmentVariable("ANTIGRAVITY_GEMINI_DIR");
                string tempDir = Path.Combine(Path.GetTempPath(), "ag_taskbar_test_" + Guid.NewGuid().ToString("N"));
                try
                {
                    Environment.SetEnvironmentVariable("ANTIGRAVITY_GEMINI_DIR", tempDir);
                    var s = new WidgetSettings();
                    s.PinnedPoolKey = "Claude & GPT";
                    s.DisplayMode = "used";
                    s.ThemePreset = "status";
                    s.BarMode = "mini";
                    s.OffsetX = -48;
                    s.HideOnFullscreen = false;
                    QuotaDataStore.SaveSettings(s);

                    WidgetSettings loaded = QuotaDataStore.LoadSettings();
                    Assert(loaded.PinnedPoolKey == "Claude & GPT", "PinnedPoolKey round-trip");
                    Assert(loaded.DisplayMode == "used", "DisplayMode round-trip");
                    Assert(loaded.ThemePreset == "status", "ThemePreset round-trip");
                    Assert(loaded.BarMode == "mini", "BarMode round-trip");
                    Assert(loaded.OffsetX == -48, "OffsetX round-trip");
                    Assert(loaded.HideOnFullscreen == false, "HideOnFullscreen round-trip");
                }
                finally
                {
                    Environment.SetEnvironmentVariable("ANTIGRAVITY_GEMINI_DIR", prevEnv);
                    if (Directory.Exists(tempDir))
                    {
                        Directory.Delete(tempDir, true);
                    }
                }
                passed++;

                // 7. GDI+ segmented bar rendering smoke test
                using (var bmp = new Bitmap(180, 38, PixelFormat.Format32bppPArgb))
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    Color accent = WidgetPainter.ResolveAccentColor("terracotta", "remaining", 62.5, true, false);
                    WidgetPainter.DrawSegmentedBar(g, 10f, 10f, 8.5f, 11.5f, 2f, 2f, 62.5, true, accent, Color.FromArgb(72, 255, 255, 255));
                }
                passed++;

                // 8. Auto-avoidance layout solver tests
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("auto", true, 160, 145, 62) == BarLayoutMode.FullBars, "Auto fits full bar when freeSpace >= fullW");
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("auto", true, 110, 145, 62) == BarLayoutMode.MiniText, "Auto switches to mini text when between miniW and fullW");
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("auto", true, 40, 145, 62) == BarLayoutMode.Hidden, "Auto hides bar when freeSpace < miniW");
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("auto", false, 0, 145, 62) == BarLayoutMode.FullBars, "Auto falls back to full when UIA info unavailable");
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("trayonly", true, 300, 145, 62) == BarLayoutMode.Hidden, "TrayOnly always hides bar");
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("full", true, 10, 145, 62) == BarLayoutMode.FullBars, "Manual full overrides auto");
                Assert(QuotaDataStore.ResolveDisplayLayoutMode("mini", true, 300, 145, 62) == BarLayoutMode.MiniText, "Manual mini overrides auto");
                passed++;

                // 9. Live snapshot read check (non-fatal if no snapshot on CI, validates readability if present)
                QuotaSnapshot liveSnap = QuotaDataStore.LoadFreshestSnapshot();
                string liveInfo = liveSnap != null
                    ? string.Format(CultureInfo.InvariantCulture, "live pools={0}, active={1}", liveSnap.Pools.Count, liveSnap.ActivePoolKey ?? "none")
                    : "no live snapshot file";

                Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "ALL {0} SELF-TESTS PASSED ({1})", passed, liveInfo));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SELF-TEST FAILED: " + ex);
                return 1;
            }
        }
    }
}

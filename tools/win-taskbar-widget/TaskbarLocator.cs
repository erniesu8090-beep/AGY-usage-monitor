using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AntigravityTaskbarMonitor
{
    internal struct TaskbarEnvironment
    {
        public bool Visible;
        public bool IsLightTheme;
        public float DpiScale;
        public IntPtr ShellTrayHandle;
        public int ShellLeft;
        public int ShellRight;
        public int ShellTop;
        public int ShellHeight;
        public int AnchorRight;
        public int Gap;
        public bool HasFreeSpaceInfo;
        public int FreeSpacePx;
    }

    /// <summary>
    /// 使用唯讀視窗矩形 API 定位 Windows 工作列與系統匣左緣座標，並透過分層視窗繪製工作列小條。
    /// 已移除 UIAutomation 跨行程控制項掃描，避免觸發防毒行為監控。
    /// </summary>
    internal static class TaskbarLocator
    {
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_TOPMOST = 0x00000008;
        private const int WS_EX_NOACTIVATE = 0x08000000;

        private const int ULW_ALPHA = 0x00000002;
        private const byte AC_SRC_OVER = 0x00;
        private const byte AC_SRC_ALPHA = 0x01;

        private const int ABM_GETSTATE = 0x00000004;
        private const int ABS_AUTOHIDE = 0x0000001;
        private const int MONITOR_DEFAULTTONEAREST = 2;

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint GW_HWNDPREV = 3;

        private const string AutoStartRegPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AutoStartValueName = "AntigravityTaskbarMonitor";

        public static int LayeredToolWindowExStyle
        {
            get { return WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE; }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SIZE
        {
            public int cx;
            public int cy;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct APPBARDATA
        {
            public int cbSize;
            public IntPtr hWnd;
            public uint uCallbackMessage;
            public uint uEdge;
            public RECT rc;
            public IntPtr lParam;
        }

        private enum QUERY_USER_NOTIFICATION_STATE
        {
            QUNS_NOT_PRESENT = 1,
            QUNS_BUSY = 2,
            QUNS_RUNNING_D3D_FULL_SCREEN = 3,
            QUNS_PRESENTATION_MODE = 4,
            QUNS_ACCEPTS_NOTIFICATIONS = 5,
            QUNS_QUIET_TIME = 6,
            QUNS_APP = 7
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int awareness);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(
            IntPtr hwnd,
            IntPtr hdcDst,
            ref POINT pptDst,
            ref SIZE psize,
            IntPtr hdcSrc,
            ref POINT pptSrc,
            int crKey,
            ref BLENDFUNCTION pblend,
            int dwFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("shell32.dll")]
        private static extern IntPtr SHAppBarMessage(int dwMessage, ref APPBARDATA pData);

        [DllImport("shell32.dll")]
        private static extern int SHQueryUserNotificationState(out QUERY_USER_NOTIFICATION_STATE pquns);

        public static void EnablePerMonitorDpiAwareness()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch
            {
            }
            try
            {
                if (SetProcessDpiAwareness(2) == 0) return;
            }
            catch
            {
            }
            try
            {
                SetProcessDPIAware();
            }
            catch
            {
            }
        }

        public static bool IsSystemTaskbarLightTheme()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", false))
                {
                    if (key != null)
                    {
                        object val = key.GetValue("SystemUsesLightTheme");
                        if (val is int)
                        {
                            return ((int)val) != 0;
                        }
                    }
                }
            }
            catch
            {
            }
            return false;
        }

        public static float GetPrimaryTaskbarDpiScale()
        {
            try
            {
                IntPtr hShell = FindWindow("Shell_TrayWnd", null);
                if (hShell != IntPtr.Zero)
                {
                    uint dpi = GetDpiForWindow(hShell);
                    if (dpi >= 96 && dpi <= 480)
                    {
                        return dpi / 96.0f;
                    }
                }
            }
            catch
            {
            }
            return 1.0f;
        }

        public static TaskbarEnvironment ProbeTaskbarEnvironment(
            bool hideOnFullscreen,
            IntPtr selfHandle,
            IntPtr popupHandle)
        {
            var env = new TaskbarEnvironment();
            env.IsLightTheme = IsSystemTaskbarLightTheme();
            env.DpiScale = GetPrimaryTaskbarDpiScale();

            IntPtr hShell = FindWindow("Shell_TrayWnd", null);
            if (hShell == IntPtr.Zero || !IsWindowVisible(hShell))
            {
                env.Visible = false;
                return env;
            }
            env.ShellTrayHandle = hShell;

            RECT shellRect;
            if (!GetWindowRect(hShell, out shellRect))
            {
                env.Visible = false;
                return env;
            }

            int shellW = shellRect.Right - shellRect.Left;
            int shellH = shellRect.Bottom - shellRect.Top;
            if (shellW <= 0 || shellH <= 16)
            {
                env.Visible = false;
                return env;
            }

            env.ShellLeft = shellRect.Left;
            env.ShellRight = shellRect.Right;
            env.ShellTop = shellRect.Top;
            env.ShellHeight = shellH;

            MONITORINFO monInfo = new MONITORINFO();
            monInfo.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            IntPtr hMon = MonitorFromWindow(hShell, MONITOR_DEFAULTTONEAREST);
            bool hasMon = hMon != IntPtr.Zero && GetMonitorInfo(hMon, ref monInfo);

            if (hasMon && IsTaskbarAutoHidden())
            {
                bool offBottom = shellRect.Top >= monInfo.rcMonitor.Bottom - 4;
                bool offTop = shellRect.Bottom <= monInfo.rcMonitor.Top + 4;
                if (offBottom || offTop)
                {
                    env.Visible = false;
                    return env;
                }
            }

            if (hideOnFullscreen && IsFullscreenActive(hShell, monInfo, hasMon, selfHandle, popupHandle))
            {
                env.Visible = false;
                return env;
            }

            int anchorRight = shellRect.Right - (int)Math.Round(240 * env.DpiScale);
            IntPtr hTrayNotify = FindWindowEx(hShell, IntPtr.Zero, "TrayNotifyWnd", null);
            if (hTrayNotify != IntPtr.Zero && IsWindowVisible(hTrayNotify))
            {
                RECT trayRect;
                if (GetWindowRect(hTrayNotify, out trayRect) && (trayRect.Right - trayRect.Left) > 20)
                {
                    anchorRight = trayRect.Left;
                }
            }

            env.AnchorRight = anchorRight;
            env.Gap = (int)Math.Round(2 * env.DpiScale);
            env.HasFreeSpaceInfo = false;
            env.FreeSpacePx = 0;

            env.Visible = true;
            return env;
        }

        public static void ComputeWidgetCoordinates(
            TaskbarEnvironment env,
            int widgetWidth,
            int widgetHeight,
            int offsetX,
            out int x,
            out int y)
        {
            x = env.AnchorRight - widgetWidth - env.Gap + offsetX;
            int minX = env.ShellLeft + (int)Math.Round(6 * env.DpiScale);
            int maxX = env.ShellRight - widgetWidth - (int)Math.Round(6 * env.DpiScale);
            if (x < minX) x = minX;
            if (x > maxX) x = maxX;
            y = env.ShellTop + Math.Max(0, (env.ShellHeight - widgetHeight) / 2);
        }

        private static bool IsTaskbarAutoHidden()
        {
            try
            {
                var abd = new APPBARDATA();
                abd.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
                IntPtr state = SHAppBarMessage(ABM_GETSTATE, ref abd);
                return (state.ToInt64() & ABS_AUTOHIDE) != 0;
            }
            catch
            {
                return false;
            }
        }

        public static bool IsQuietOrFullscreenActive(IntPtr selfHandle, IntPtr popupHandle)
        {
            IntPtr hShell = FindWindow("Shell_TrayWnd", null);
            MONITORINFO monInfo = new MONITORINFO();
            monInfo.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            IntPtr hMon = hShell != IntPtr.Zero
                ? MonitorFromWindow(hShell, MONITOR_DEFAULTTONEAREST)
                : IntPtr.Zero;
            bool hasMon = hMon != IntPtr.Zero && GetMonitorInfo(hMon, ref monInfo);
            return IsFullscreenActive(hShell, monInfo, hasMon, selfHandle, popupHandle);
        }

        private static bool IsFullscreenActive(
            IntPtr hShell,
            MONITORINFO monInfo,
            bool hasMon,
            IntPtr selfHandle,
            IntPtr popupHandle)
        {
            try
            {
                QUERY_USER_NOTIFICATION_STATE state;
                if (SHQueryUserNotificationState(out state) == 0)
                {
                    if (state == QUERY_USER_NOTIFICATION_STATE.QUNS_RUNNING_D3D_FULL_SCREEN ||
                        state == QUERY_USER_NOTIFICATION_STATE.QUNS_PRESENTATION_MODE)
                    {
                        return true;
                    }
                }
            }
            catch
            {
            }

            if (!hasMon) return false;

            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero || fg == hShell || fg == selfHandle || fg == popupHandle)
            {
                return false;
            }

            var sb = new StringBuilder(64);
            GetClassName(fg, sb, sb.Capacity);
            string cls = sb.ToString();
            if (string.Equals(cls, "Progman", StringComparison.Ordinal) ||
                string.Equals(cls, "WorkerW", StringComparison.Ordinal) ||
                string.Equals(cls, "Shell_TrayWnd", StringComparison.Ordinal) ||
                string.Equals(cls, "Shell_SecondaryTrayWnd", StringComparison.Ordinal))
            {
                return false;
            }

            RECT fgRect;
            if (!GetWindowRect(fg, out fgRect)) return false;

            return fgRect.Left <= monInfo.rcMonitor.Left &&
                   fgRect.Top <= monInfo.rcMonitor.Top &&
                   fgRect.Right >= monInfo.rcMonitor.Right &&
                   fgRect.Bottom >= monInfo.rcMonitor.Bottom;
        }

        public static void EnsureTopMostNoActivate(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }

        public static void EnsureAboveTaskbarIfNeeded(IntPtr hwnd, IntPtr hShell)
        {
            if (hwnd == IntPtr.Zero || hShell == IntPtr.Zero) return;
            IntPtr prev = hwnd;
            int guard = 0;
            while ((prev = GetWindow(prev, GW_HWNDPREV)) != IntPtr.Zero && guard < 128)
            {
                guard++;
                if (prev == hShell)
                {
                    EnsureTopMostNoActivate(hwnd);
                    return;
                }
            }
        }

        public static void BlitPremultipliedBitmap(IntPtr hwnd, Bitmap bmp, int x, int y)
        {
            if (hwnd == IntPtr.Zero || bmp == null) return;

            IntPtr screenDc = IntPtr.Zero;
            IntPtr memDc = IntPtr.Zero;
            IntPtr hBitmap = IntPtr.Zero;
            IntPtr oldBitmap = IntPtr.Zero;

            try
            {
                screenDc = GetDC(IntPtr.Zero);
                memDc = CreateCompatibleDC(screenDc);
                hBitmap = bmp.GetHbitmap(Color.FromArgb(0));
                oldBitmap = SelectObject(memDc, hBitmap);

                var topPos = new POINT { x = x, y = y };
                var size = new SIZE { cx = bmp.Width, cy = bmp.Height };
                var srcPos = new POINT { x = 0, y = 0 };
                var blend = new BLENDFUNCTION
                {
                    BlendOp = AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = 255,
                    AlphaFormat = AC_SRC_ALPHA
                };

                UpdateLayeredWindow(hwnd, screenDc, ref topPos, ref size, memDc, ref srcPos, 0, ref blend, ULW_ALPHA);
            }
            finally
            {
                if (oldBitmap != IntPtr.Zero && memDc != IntPtr.Zero)
                {
                    SelectObject(memDc, oldBitmap);
                }
                if (hBitmap != IntPtr.Zero)
                {
                    DeleteObject(hBitmap);
                }
                if (memDc != IntPtr.Zero)
                {
                    DeleteDC(memDc);
                }
                if (screenDc != IntPtr.Zero)
                {
                    ReleaseDC(IntPtr.Zero, screenDc);
                }
            }
        }

        public static bool IsAutoStartEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(AutoStartRegPath, false))
                {
                    if (key == null) return false;
                    object val = key.GetValue(AutoStartValueName);
                    return val != null && !string.IsNullOrWhiteSpace(val.ToString());
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool SetAutoStart(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(AutoStartRegPath, true))
                {
                    if (key == null) return false;
                    if (enable)
                    {
                        key.SetValue(AutoStartValueName, "\"" + Application.ExecutablePath + "\"");
                    }
                    else
                    {
                        key.DeleteValue(AutoStartValueName, false);
                    }
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }
    }
}

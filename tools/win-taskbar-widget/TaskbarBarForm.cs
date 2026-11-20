using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Windows.Forms;

namespace AntigravityTaskbarMonitor
{
    internal static class WidgetPainter
    {
        public static GraphicsPath CreateRoundedRectPath(float x, float y, float width, float height, float radius)
        {
            var path = new GraphicsPath();
            float d = Math.Min(radius * 2.0f, Math.Min(width, height));
            if (d <= 0.1f)
            {
                path.AddRectangle(new RectangleF(x, y, width, height));
                return path;
            }
            path.AddArc(x, y, d, d, 180, 90);
            path.AddArc(x + width - d, y, d, d, 270, 90);
            path.AddArc(x + width - d, y + height - d, d, d, 0, 90);
            path.AddArc(x, y + height - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static Color ResolveAccentColor(string themePreset, string displayMode, double pct, bool available, bool stale)
        {
            if (!available)
            {
                return Color.FromArgb(120, 130, 136, 145);
            }

            Color baseColor;
            if (string.Equals(themePreset, "blue", StringComparison.OrdinalIgnoreCase))
            {
                baseColor = Color.FromArgb(255, 91, 155, 213);
            }
            else if (string.Equals(themePreset, "status", StringComparison.OrdinalIgnoreCase))
            {
                bool isUsedMode = string.Equals(displayMode, "used", StringComparison.OrdinalIgnoreCase);
                double remainingEquiv = isUsedMode ? (100.0 - pct) : pct;
                if (remainingEquiv >= 50.0)
                {
                    baseColor = Color.FromArgb(255, 63, 185, 124);
                }
                else if (remainingEquiv >= 20.0)
                {
                    baseColor = Color.FromArgb(255, 217, 147, 70);
                }
                else
                {
                    baseColor = Color.FromArgb(255, 224, 90, 90);
                }
            }
            else
            {
                // Default warm terracotta matching screenshot
                baseColor = Color.FromArgb(255, 212, 122, 90);
            }

            if (stale)
            {
                return Color.FromArgb(175, baseColor.R, baseColor.G, baseColor.B);
            }
            return baseColor;
        }

        public static void DrawSegmentedBar(
            Graphics g,
            float startX,
            float y,
            float segW,
            float segH,
            float segGap,
            float radius,
            double pct,
            bool available,
            Color fillColor,
            Color emptyColor)
        {
            double clamped = available ? Math.Max(0.0, Math.Min(100.0, pct)) : 0.0;
            using (var emptyBrush = new SolidBrush(emptyColor))
            using (var fillBrush = new SolidBrush(fillColor))
            {
                for (int i = 0; i < 10; i++)
                {
                    float sx = startX + i * (segW + segGap);
                    using (GraphicsPath path = CreateRoundedRectPath(sx, y, segW, segH, radius))
                    {
                        g.FillPath(emptyBrush, path);

                        if (available)
                        {
                            double segFill = Math.Max(0.0, Math.Min(1.0, (clamped / 10.0) - i));
                            if (segFill > 0.02)
                            {
                                GraphicsState state = g.Save();
                                g.SetClip(path, CombineMode.Intersect);
                                g.FillRectangle(fillBrush, sx, y, segW * (float)segFill, segH);
                                g.Restore(state);
                            }
                        }
                    }
                }
            }
        }
    }

    internal sealed class PoolPopupForm : Form
    {
        private readonly float _dpiScale;
        private readonly WidgetSettings _settings;
        private readonly Action<string> _onSelectPool;
        private QuotaSnapshot _snapshot;
        private readonly List<Rectangle> _rowBounds = new List<Rectangle>();
        private readonly List<string> _rowPoolKeys = new List<string>();
        private int _hoverRowIndex = -1;

        protected override bool ShowWithoutActivation
        {
            get { return false; }
        }

        public PoolPopupForm(float dpiScale, WidgetSettings settings, Action<string> onSelectPool)
        {
            _dpiScale = Math.Max(1.0f, dpiScale);
            _settings = settings;
            _onSelectPool = onSelectPool;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            DoubleBuffered = true;
            BackColor = Color.FromArgb(255, 31, 33, 38);

            Deactivate += delegate { Hide(); };
            MouseMove += OnPopupMouseMove;
            MouseLeave += delegate
            {
                if (_hoverRowIndex != -1)
                {
                    _hoverRowIndex = -1;
                    Invalidate();
                }
            };
            MouseClick += OnPopupMouseClick;
        }

        public void ShowAtAnchor(QuotaSnapshot snapshot, int anchorCenterX, int taskbarTopY)
        {
            _snapshot = snapshot;
            int poolCount = (snapshot != null && snapshot.Pools != null && snapshot.Pools.Count > 0)
                ? snapshot.Pools.Count
                : 1;

            int width = (int)Math.Round(336 * _dpiScale);
            int headerH = (int)Math.Round(42 * _dpiScale);
            int rowH = (int)Math.Round(56 * _dpiScale);
            int footerH = (int)Math.Round(28 * _dpiScale);
            int height = headerH + poolCount * rowH + footerH;

            Size = new Size(width, height);

            Screen screen = Screen.FromPoint(new Point(anchorCenterX, taskbarTopY));
            Rectangle workArea = screen != null
                ? screen.WorkingArea
                : (Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new Rectangle(0, 0, 1920, 1040));

            int x = anchorCenterX - width / 2;
            int margin = (int)Math.Round(8 * _dpiScale);
            if (x + width > workArea.Right - margin) x = workArea.Right - width - margin;
            if (x < workArea.Left + margin) x = workArea.Left + margin;

            int y = taskbarTopY - height - (int)Math.Round(8 * _dpiScale);
            if (y < workArea.Top + margin) y = workArea.Top + margin;

            Location = new Point(x, y);
            Invalidate();
            Show();
            Activate();
        }

        private void OnPopupMouseMove(object sender, MouseEventArgs e)
        {
            int nextHover = -1;
            for (int i = 0; i < _rowBounds.Count; i++)
            {
                if (_rowBounds[i].Contains(e.Location))
                {
                    nextHover = i;
                    break;
                }
            }
            if (nextHover != _hoverRowIndex)
            {
                _hoverRowIndex = nextHover;
                Cursor = _hoverRowIndex >= 0 ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
        }

        private void OnPopupMouseClick(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            for (int i = 0; i < _rowBounds.Count; i++)
            {
                if (_rowBounds[i].Contains(e.Location) && i < _rowPoolKeys.Count)
                {
                    if (_onSelectPool != null)
                    {
                        _onSelectPool(_rowPoolKeys[i]);
                    }
                    Invalidate();
                    return;
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            float s = _dpiScale;
            int padX = (int)Math.Round(14 * s);
            int headerH = (int)Math.Round(42 * s);
            int rowH = (int)Math.Round(56 * s);

            using (var borderPen = new Pen(Color.FromArgb(255, 58, 62, 70), 1f))
            {
                g.DrawRectangle(borderPen, 0, 0, Width - 1, Height - 1);
            }

            using (var titleFont = new Font("Segoe UI", 13.0f * s, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var subFont = new Font("Segoe UI", 11.0f * s, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var labelFont = new Font("Segoe UI", 12.0f * s, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var monoFont = new Font("Segoe UI", 11.2f * s, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var titleBrush = new SolidBrush(Color.FromArgb(255, 240, 242, 246)))
            using (var mutedBrush = new SolidBrush(Color.FromArgb(255, 152, 158, 170)))
            using (var dividerPen = new Pen(Color.FromArgb(255, 46, 49, 56), 1f))
            {
                string modeLabel = string.Equals(_settings.DisplayMode, "used", StringComparison.OrdinalIgnoreCase)
                    ? "已用 %"
                    : "剩餘 %";
                g.DrawString("Antigravity 配額速覽", titleFont, titleBrush, padX, 11 * s);

                string fresh = _snapshot != null
                    ? QuotaDataStore.FormatFreshness(_snapshot.UpdatedAtMs, DateTime.UtcNow)
                    : "尚無快照資料";
                if (_snapshot != null && _snapshot.IsStale)
                {
                    fresh = fresh + " (陳舊)";
                }
                string rightHeader = string.Format(CultureInfo.InvariantCulture, "{0} · {1}", modeLabel, fresh);
                SizeF rhSize = g.MeasureString(rightHeader, subFont);
                g.DrawString(rightHeader, subFont, mutedBrush, Width - padX - rhSize.Width, 13 * s);

                g.DrawLine(dividerPen, padX, headerH - 2, Width - padX, headerH - 2);

                _rowBounds.Clear();
                _rowPoolKeys.Clear();

                if (_snapshot == null || _snapshot.Pools.Count == 0)
                {
                    g.DrawString("等待 Antigravity Usage Monitor 寫入配額快照…", subFont, mutedBrush, padX, headerH + 16 * s);
                }
                else
                {
                    QuotaPoolInfo currentTarget = QuotaDataStore.ResolveTargetPool(_snapshot, _settings.PinnedPoolKey);
                    DateTime utcNow = DateTime.UtcNow;

                    for (int i = 0; i < _snapshot.Pools.Count; i++)
                    {
                        QuotaPoolInfo pool = _snapshot.Pools[i];
                        int ry = headerH + i * rowH;
                        var rowRect = new Rectangle(padX - (int)(4 * s), ry + (int)(2 * s), Width - 2 * padX + (int)(8 * s), rowH - (int)(4 * s));
                        _rowBounds.Add(rowRect);
                        _rowPoolKeys.Add(pool.PoolKey);

                        bool isTarget = currentTarget != null && string.Equals(currentTarget.PoolKey, pool.PoolKey, StringComparison.OrdinalIgnoreCase);
                        bool isHovered = i == _hoverRowIndex;
                        if (isTarget || isHovered)
                        {
                            Color bg = isTarget
                                ? Color.FromArgb(46, 212, 122, 90)
                                : Color.FromArgb(24, 255, 255, 255);
                            using (GraphicsPath rPath = WidgetPainter.CreateRoundedRectPath(rowRect.X, rowRect.Y, rowRect.Width, rowRect.Height, 6 * s))
                            using (var bgBrush = new SolidBrush(bg))
                            {
                                g.FillPath(bgBrush, rPath);
                            }
                        }

                        string title = isTarget ? ("★ " + pool.PoolLabel) : pool.PoolLabel;
                        g.DrawString(title, labelFont, titleBrush, padX, ry + 5 * s);

                        BarMetricValue m5 = QuotaDataStore.GetBarMetric(pool, false, _settings.DisplayMode);
                        BarMetricValue m7 = QuotaDataStore.GetBarMetric(pool, true, _settings.DisplayMode);

                        DrawPopupMetricRow(g, "5h", m5, utcNow, padX, ry + 23 * s, s, monoFont, mutedBrush);
                        DrawPopupMetricRow(g, "7d", m7, utcNow, padX, ry + 38 * s, s, monoFont, mutedBrush);
                    }
                }

                string footer = string.Equals(_settings.PinnedPoolKey, "auto", StringComparison.OrdinalIgnoreCase)
                    ? "目前：自動跟隨 activePool · 點擊上方模型池可固定"
                    : string.Format(CultureInfo.InvariantCulture, "已固定顯示：{0} · 右鍵圖示可切回自動", _settings.PinnedPoolKey);
                g.DrawString(footer, subFont, mutedBrush, padX, Height - (int)(21 * s));
            }
        }

        private void DrawPopupMetricRow(
            Graphics g,
            string tag,
            BarMetricValue metric,
            DateTime utcNow,
            float x,
            float y,
            float s,
            Font font,
            Brush textBrush)
        {
            g.DrawString(tag, font, textBrush, x, y);
            float barX = x + 24 * s;
            float segW = 10 * s;
            float segH = 9 * s;
            float segGap = 2 * s;
            Color accent = WidgetPainter.ResolveAccentColor(_settings.ThemePreset, _settings.DisplayMode, metric.Pct, metric.Available, _snapshot != null && _snapshot.IsStale);
            Color empty = Color.FromArgb(64, 255, 255, 255);
            WidgetPainter.DrawSegmentedBar(g, barX, y + 2 * s, segW, segH, segGap, 2 * s, metric.Pct, metric.Available, accent, empty);

            float textX = barX + 10 * (segW + segGap) + 8 * s;
            string detail;
            if (!metric.Available)
            {
                detail = "--";
            }
            else
            {
                string cd = QuotaDataStore.FormatDetailedCountdown(metric.ResetTimeUtc, utcNow);
                detail = string.Format(CultureInfo.InvariantCulture, "{0}% · {1}", metric.IntPct, cd);
            }
            g.DrawString(detail, font, textBrush, textX, y);
        }
    }

    internal sealed class TaskbarBarForm : Form
    {
        private readonly WidgetSettings _settings;
        private readonly Timer _refreshTimer;
        private readonly NotifyIcon _trayIcon;
        private readonly ContextMenuStrip _menu;
        private readonly PoolPopupForm _popup;

        private QuotaSnapshot _snapshot;
        private float _dpiScale = 1.0f;
        private int _currentX = -1;
        private int _currentY = -1;
        private bool _isHovered;
        private bool _isDragging;
        private int _dragStartScreenX;
        private int _dragStartOffsetX;
        private string _lastTraySignature = string.Empty;
        private string _lastBarSignature = string.Empty;

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= TaskbarLocator.LayeredToolWindowExStyle;
                return cp;
            }
        }

        public TaskbarBarForm()
        {
            _settings = QuotaDataStore.LoadSettings();
            _dpiScale = TaskbarLocator.GetPrimaryTaskbarDpiScale();

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;

            _menu = new ContextMenuStrip();
            _menu.Opening += OnMenuOpening;

            _popup = new PoolPopupForm(_dpiScale, _settings, OnPoolSelectedFromPopup);

            _trayIcon = new NotifyIcon();
            _trayIcon.ContextMenuStrip = _menu;
            _trayIcon.Visible = true;
            _trayIcon.MouseClick += OnTrayMouseClick;

            MouseEnter += delegate
            {
                _isHovered = true;
                RenderAndSync(true);
            };
            MouseLeave += delegate
            {
                _isHovered = false;
                RenderAndSync(true);
            };
            MouseDown += OnBarMouseDown;
            MouseMove += OnBarMouseMove;
            MouseUp += OnBarMouseUp;

            _refreshTimer = new Timer();
            _refreshTimer.Interval = 1000;
            _refreshTimer.Tick += delegate { RefreshDataAndSync(false); };
            _refreshTimer.Start();

            RefreshDataAndSync(true);
        }

        private void OnPoolSelectedFromPopup(string poolKey)
        {
            _settings.PinnedPoolKey = poolKey;
            QuotaDataStore.SaveSettings(_settings);
            RenderAndSync(true);
        }

        private void OnTrayMouseClick(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                TogglePopup();
            }
        }

        private void OnBarMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && (ModifierKeys & Keys.Alt) == Keys.Alt)
            {
                _isDragging = true;
                _dragStartScreenX = Cursor.Position.X;
                _dragStartOffsetX = _settings.OffsetX;
                Capture = true;
            }
        }

        private void OnBarMouseMove(object sender, MouseEventArgs e)
        {
            if (!_isDragging) return;
            int dx = Cursor.Position.X - _dragStartScreenX;
            _settings.OffsetX = Math.Max(-1200, Math.Min(600, _dragStartOffsetX + dx));
            RenderAndSync(false);
        }

        private void OnBarMouseUp(object sender, MouseEventArgs e)
        {
            if (_isDragging)
            {
                _isDragging = false;
                Capture = false;
                QuotaDataStore.SaveSettings(_settings);
                return;
            }

            if (e.Button == MouseButtons.Right)
            {
                _menu.Show(Cursor.Position);
            }
            else if (e.Button == MouseButtons.Left)
            {
                TogglePopup();
            }
        }

        private void TogglePopup()
        {
            if (_popup.Visible)
            {
                _popup.Hide();
                return;
            }
            TaskbarEnvironment env = TaskbarLocator.ProbeTaskbarEnvironment(false, Handle, _popup.Handle);
            Rectangle fallbackWork = Screen.PrimaryScreen != null
                ? Screen.PrimaryScreen.WorkingArea
                : new Rectangle(0, 0, 1920, 1040);
            int centerX;
            int anchorY;
            if (Visible && _currentX >= 0 && Width > 0)
            {
                centerX = _currentX + Width / 2;
                anchorY = _currentY;
            }
            else if (env.Visible)
            {
                centerX = env.AnchorRight - (int)(120 * _dpiScale);
                anchorY = env.ShellTop;
            }
            else
            {
                centerX = fallbackWork.Right - (int)(180 * _dpiScale);
                anchorY = fallbackWork.Bottom;
            }
            _popup.ShowAtAnchor(_snapshot, centerX, anchorY);
        }

        private void RefreshDataAndSync(bool forceRedraw)
        {
            _snapshot = QuotaDataStore.LoadFreshestSnapshot();
            RenderAndSync(forceRedraw);
        }

        private void RenderAndSync(bool forceRedraw)
        {
            TaskbarEnvironment env = TaskbarLocator.ProbeTaskbarEnvironment(
                _settings.HideOnFullscreen,
                Handle,
                _popup.Handle);

            float dpiScale = env.DpiScale > 0 ? env.DpiScale : TaskbarLocator.GetPrimaryTaskbarDpiScale();
            _dpiScale = dpiScale;

            QuotaPoolInfo targetPool = QuotaDataStore.ResolveTargetPool(_snapshot, _settings.PinnedPoolKey);
            BarMetricValue m5 = QuotaDataStore.GetBarMetric(targetPool, false, _settings.DisplayMode);
            BarMetricValue m7 = QuotaDataStore.GetBarMetric(targetPool, true, _settings.DisplayMode);
            DateTime utcNow = DateTime.UtcNow;

            UpdateTrayBadgeAndTooltip(targetPool, m5, m7, utcNow);

            if (!env.Visible)
            {
                if (Visible) Hide();
                return;
            }

            string text5 = FormatRowValueText(m5, utcNow);
            string text7 = FormatRowValueText(m7, utcNow);
            string mini5 = m5.Available ? string.Format(CultureInfo.InvariantCulture, "{0}%", m5.IntPct) : "--";
            string mini7 = m7.Available ? string.Format(CultureInfo.InvariantCulture, "{0}%", m7.IntPct) : "--";

            int fullW;
            int fullH;
            int miniW;
            int miniH;
            MeasureLayoutSizes(dpiScale, text5, text7, mini5, mini7, out fullW, out fullH, out miniW, out miniH);

            BarLayoutMode layoutMode = QuotaDataStore.ResolveDisplayLayoutMode(
                _settings.BarMode,
                env.HasFreeSpaceInfo,
                env.FreeSpacePx,
                fullW,
                miniW);

            if (layoutMode == BarLayoutMode.Hidden)
            {
                if (Visible) Hide();
                return;
            }

            int targetW = layoutMode == BarLayoutMode.MiniText ? miniW : fullW;
            int targetH = layoutMode == BarLayoutMode.MiniText ? miniH : fullH;
            int nextX;
            int nextY;
            TaskbarLocator.ComputeWidgetCoordinates(env, targetW, targetH, _settings.OffsetX, out nextX, out nextY);

            string barSig = string.Format(
                CultureInfo.InvariantCulture,
                "{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8:F2}|{9}",
                (int)layoutMode,
                env.IsLightTheme ? 1 : 0,
                _isHovered ? 1 : 0,
                _settings.ThemePreset,
                _settings.DisplayMode,
                layoutMode == BarLayoutMode.MiniText ? (mini5 + "/" + mini7) : (text5 + "/" + text7),
                _snapshot != null && _snapshot.IsStale ? 1 : 0,
                dpiScale,
                targetPool != null ? targetPool.PoolKey : "",
                targetW);

            if (!forceRedraw && Visible && nextX == _currentX && nextY == _currentY && string.Equals(barSig, _lastBarSignature, StringComparison.Ordinal))
            {
                if (!_menu.Visible && !_popup.Visible)
                {
                    TaskbarLocator.EnsureAboveTaskbarIfNeeded(Handle, env.ShellTrayHandle);
                }
                return;
            }

            using (Bitmap bmp = layoutMode == BarLayoutMode.MiniText
                ? RenderMiniTextBitmap(dpiScale, env.IsLightTheme, m5, m7, mini5, mini7, miniW, miniH)
                : RenderBarBitmap(dpiScale, env.IsLightTheme, m5, m7, text5, text7, fullW, fullH))
            {
                if (!Visible)
                {
                    Show();
                }

                _currentX = nextX;
                _currentY = nextY;
                _lastBarSignature = barSig;
                Size = new Size(targetW, targetH);
                TaskbarLocator.BlitPremultipliedBitmap(Handle, bmp, _currentX, _currentY);
                TaskbarLocator.EnsureTopMostNoActivate(Handle);
            }
        }

        private static void MeasureLayoutSizes(
            float s,
            string text5,
            string text7,
            string mini5,
            string mini7,
            out int fullWidth,
            out int fullHeight,
            out int miniWidth,
            out int miniHeight)
        {
            float padLeft = 4f * s;
            float dividerW = 1.5f * s;
            float afterDividerGap = 4f * s;
            float tagWidth = 17f * s;
            float segW = 5.5f * s;
            float segGap = 1.5f * s;
            float barsTotalW = 10f * segW + 9f * segGap;
            float afterBarsGap = 4.5f * s;
            float padRight = 4f * s;

            using (var font = new Font("Segoe UI", 10.8f * s, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var measureBmp = new Bitmap(1, 1, PixelFormat.Format32bppPArgb))
            using (var mg = Graphics.FromImage(measureBmp))
            {
                mg.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                float w5 = mg.MeasureString(text5, font).Width;
                float w7 = mg.MeasureString(text7, font).Width;
                float valAreaW = Math.Max(w5, w7);

                fullWidth = (int)Math.Ceiling(padLeft + dividerW + afterDividerGap + tagWidth + barsTotalW + afterBarsGap + valAreaW + padRight);
                fullHeight = (int)Math.Ceiling(36f * s);

                float mw5 = mg.MeasureString(mini5, font).Width;
                float mw7 = mg.MeasureString(mini7, font).Width;
                float miniValW = Math.Max(mw5, mw7);
                miniWidth = (int)Math.Ceiling(padLeft + dividerW + afterDividerGap + 21f * s + miniValW + padRight);
                miniHeight = fullHeight;
            }
        }

        private Bitmap RenderBarBitmap(
            float s,
            bool isLightTaskbar,
            BarMetricValue m5,
            BarMetricValue m7,
            string text5,
            string text7,
            int outWidth,
            int outHeight)
        {
            float padLeft = 4f * s;
            float dividerW = 1.5f * s;
            float afterDividerGap = 4f * s;
            float tagWidth = 17f * s;
            float segW = 5.5f * s;
            float segH = 10.5f * s;
            float segGap = 1.5f * s;
            float barsTotalW = 10f * segW + 9f * segGap;
            float afterBarsGap = 4.5f * s;

            var bmp = new Bitmap(outWidth, outHeight, PixelFormat.Format32bppPArgb);
            using (var font = new Font("Segoe UI", 10.8f * s, FontStyle.Regular, GraphicsUnit.Pixel))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                DrawWidgetBackdropAndDivider(g, outWidth, outHeight, s, isLightTaskbar, padLeft, dividerW);

                Color labelColor = isLightTaskbar
                    ? Color.FromArgb(220, 45, 49, 56)
                    : Color.FromArgb(215, 168, 173, 182);
                Color emptyColor = isLightTaskbar
                    ? Color.FromArgb(44, 0, 0, 0)
                    : Color.FromArgb(72, 255, 255, 255);

                bool stale = _snapshot != null && _snapshot.IsStale;
                float contentX = padLeft + dividerW + afterDividerGap;
                float row1Y = 4.0f * s;
                float row2Y = 19.5f * s;

                DrawTaskbarRow(g, "5h", m5, text5, contentX, row1Y, tagWidth, segW, segH, segGap, barsTotalW, afterBarsGap, s, font, labelColor, emptyColor, stale);
                DrawTaskbarRow(g, "7d", m7, text7, contentX, row2Y, tagWidth, segW, segH, segGap, barsTotalW, afterBarsGap, s, font, labelColor, emptyColor, stale);
            }

            return bmp;
        }

        private Bitmap RenderMiniTextBitmap(
            float s,
            bool isLightTaskbar,
            BarMetricValue m5,
            BarMetricValue m7,
            string mini5,
            string mini7,
            int outWidth,
            int outHeight)
        {
            float padLeft = 4f * s;
            float dividerW = 1.5f * s;
            float afterDividerGap = 4f * s;

            var bmp = new Bitmap(outWidth, outHeight, PixelFormat.Format32bppPArgb);
            using (var font = new Font("Segoe UI", 10.8f * s, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var boldFont = new Font("Segoe UI", 10.8f * s, FontStyle.Bold, GraphicsUnit.Pixel))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                DrawWidgetBackdropAndDivider(g, outWidth, outHeight, s, isLightTaskbar, padLeft, dividerW);

                Color labelColor = isLightTaskbar
                    ? Color.FromArgb(215, 45, 49, 56)
                    : Color.FromArgb(210, 168, 173, 182);
                Color valueColor = isLightTaskbar
                    ? Color.FromArgb(240, 28, 32, 38)
                    : Color.FromArgb(235, 224, 228, 234);

                bool stale = _snapshot != null && _snapshot.IsStale;
                float contentX = padLeft + dividerW + afterDividerGap;

                DrawMiniRow(g, "5h", m5, mini5, contentX, 4.0f * s, s, font, boldFont, labelColor, valueColor, stale);
                DrawMiniRow(g, "7d", m7, mini7, contentX, 19.5f * s, s, font, boldFont, labelColor, valueColor, stale);
            }

            return bmp;
        }

        private void DrawWidgetBackdropAndDivider(
            Graphics g,
            int outWidth,
            int outHeight,
            float s,
            bool isLightTaskbar,
            float padLeft,
            float dividerW)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            Color bg = _isHovered
                ? (isLightTaskbar ? Color.FromArgb(26, 0, 0, 0) : Color.FromArgb(34, 255, 255, 255))
                : Color.FromArgb(2, 28, 28, 28);

            using (GraphicsPath bgPath = WidgetPainter.CreateRoundedRectPath(1f, 1f, outWidth - 2f, outHeight - 2f, 6f * s))
            using (var bgBrush = new SolidBrush(bg))
            {
                g.FillPath(bgBrush, bgPath);
            }

            Color dividerColor = isLightTaskbar
                ? Color.FromArgb(70, 0, 0, 0)
                : Color.FromArgb(95, 180, 185, 195);
            float divH = 20f * s;
            float divY = (outHeight - divH) / 2f;
            using (var divBrush = new SolidBrush(dividerColor))
            using (GraphicsPath divPath = WidgetPainter.CreateRoundedRectPath(padLeft, divY, dividerW, divH, 1f * s))
            {
                g.FillPath(divBrush, divPath);
            }
        }

        private void DrawMiniRow(
            Graphics g,
            string tag,
            BarMetricValue metric,
            string valueText,
            float x,
            float y,
            float s,
            Font tagFont,
            Font valFont,
            Color labelColor,
            Color valueColor,
            bool stale)
        {
            Color accent = WidgetPainter.ResolveAccentColor(_settings.ThemePreset, _settings.DisplayMode, metric.Pct, metric.Available, stale);
            using (var pillPath = WidgetPainter.CreateRoundedRectPath(x, y + 2.0f * s, 2.5f * s, 9.0f * s, 1.0f * s))
            using (var pillBrush = new SolidBrush(accent))
            using (var labelBrush = new SolidBrush(labelColor))
            using (var valBrush = new SolidBrush(valueColor))
            {
                g.FillPath(pillBrush, pillPath);
                g.DrawString(tag, tagFont, labelBrush, x + 4.5f * s, y - 1.0f * s);
                g.DrawString(valueText, valFont, valBrush, x + 20.5f * s, y - 1.0f * s);
            }
        }

        private void DrawTaskbarRow(
            Graphics g,
            string tag,
            BarMetricValue metric,
            string valueText,
            float x,
            float y,
            float tagWidth,
            float segW,
            float segH,
            float segGap,
            float barsTotalW,
            float afterBarsGap,
            float s,
            Font font,
            Color labelColor,
            Color emptyColor,
            bool stale)
        {
            using (var textBrush = new SolidBrush(labelColor))
            {
                g.DrawString(tag, font, textBrush, x, y - 1.2f * s);
                float barX = x + tagWidth;
                float barY = y + 1.0f * s;
                Color accent = WidgetPainter.ResolveAccentColor(_settings.ThemePreset, _settings.DisplayMode, metric.Pct, metric.Available, stale);
                WidgetPainter.DrawSegmentedBar(g, barX, barY, segW, segH, segGap, 2.0f * s, metric.Pct, metric.Available, accent, emptyColor);
                g.DrawString(valueText, font, textBrush, barX + barsTotalW + afterBarsGap, y - 1.2f * s);
            }
        }

        private static string FormatRowValueText(BarMetricValue metric, DateTime utcNow)
        {
            if (!metric.Available) return "--";
            string cd = QuotaDataStore.FormatCompactCountdown(metric.ResetTimeUtc, utcNow);
            if (string.IsNullOrEmpty(cd))
            {
                return string.Format(CultureInfo.InvariantCulture, "{0}%", metric.IntPct);
            }
            return string.Format(CultureInfo.InvariantCulture, "{0}% · {1}", metric.IntPct, cd);
        }

        private void UpdateTrayBadgeAndTooltip(QuotaPoolInfo pool, BarMetricValue m5, BarMetricValue m7, DateTime utcNow)
        {
            BarMetricValue primary = m5.Available ? m5 : m7;
            string badgeText = primary.Available ? primary.IntPct.ToString(CultureInfo.InvariantCulture) : "--";
            bool stale = _snapshot != null && _snapshot.IsStale;
            Color badgeColor = WidgetPainter.ResolveAccentColor(_settings.ThemePreset, _settings.DisplayMode, primary.Pct, primary.Available, stale);

            string poolName = pool != null ? pool.PoolLabel : "Antigravity";
            string s5 = m5.Available ? string.Format(CultureInfo.InvariantCulture, "{0}%({1})", m5.IntPct, QuotaDataStore.FormatCompactCountdown(m5.ResetTimeUtc, utcNow)) : "--";
            string s7 = m7.Available ? string.Format(CultureInfo.InvariantCulture, "{0}%({1})", m7.IntPct, QuotaDataStore.FormatCompactCountdown(m7.ResetTimeUtc, utcNow)) : "--";
            string tip = string.Format(CultureInfo.InvariantCulture, "{0}\n5h: {1} | 7d: {2}", poolName, s5, s7);
            if (tip.Length > 63) tip = tip.Substring(0, 63);
            if (!string.Equals(_trayIcon.Text, tip, StringComparison.Ordinal))
            {
                _trayIcon.Text = tip;
            }

            string signature = string.Format(CultureInfo.InvariantCulture, "{0}|{1:X8}", badgeText, badgeColor.ToArgb());
            if (string.Equals(signature, _lastTraySignature, StringComparison.Ordinal))
            {
                return;
            }
            _lastTraySignature = signature;

            int iconSize = Math.Max(16, Math.Min(32, SystemInformation.SmallIconSize.Width));
            using (var bmp = new Bitmap(iconSize, iconSize, PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);

                using (GraphicsPath box = WidgetPainter.CreateRoundedRectPath(1f, 1f, iconSize - 2f, iconSize - 2f, iconSize * 0.18f))
                using (var bgBrush = new SolidBrush(badgeColor))
                {
                    g.FillPath(bgBrush, box);
                }

                float fontSize = badgeText.Length >= 3 ? iconSize * 0.44f : iconSize * 0.54f;
                using (var f = new Font("Segoe UI", fontSize, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var sf = new StringFormat())
                using (var textBrush = new SolidBrush(Color.White))
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    g.DrawString(badgeText, f, textBrush, new RectangleF(0, 0.5f, iconSize, iconSize), sf);
                }

                IntPtr nextHIcon = bmp.GetHicon();
                try
                {
                    using (Icon tempIcon = Icon.FromHandle(nextHIcon))
                    {
                        Icon prevIcon = _trayIcon.Icon;
                        _trayIcon.Icon = (Icon)tempIcon.Clone();
                        if (prevIcon != null)
                        {
                            prevIcon.Dispose();
                        }
                    }
                }
                finally
                {
                    TaskbarLocator.DestroyIcon(nextHIcon);
                }
            }
        }

        private void OnMenuOpening(object sender, System.ComponentModel.CancelEventArgs e)
        {
            _menu.Items.Clear();

            QuotaPoolInfo targetPool = QuotaDataStore.ResolveTargetPool(_snapshot, _settings.PinnedPoolKey);
            string poolTitle = targetPool != null ? targetPool.PoolLabel : "等待資料";
            string followText = string.Equals(_settings.PinnedPoolKey, "auto", StringComparison.OrdinalIgnoreCase)
                ? "自動跟隨"
                : "已固定";

            var headerItem = new ToolStripMenuItem(string.Format(CultureInfo.InvariantCulture, "Antigravity 工作列監控 ({0} · {1})", poolTitle, followText));
            headerItem.Enabled = false;
            _menu.Items.Add(headerItem);
            _menu.Items.Add(new ToolStripSeparator());

            var poolMenu = new ToolStripMenuItem("模型池顯示");
            var autoItem = new ToolStripMenuItem("自動跟隨目前模型池 (activePool)");
            autoItem.Checked = string.Equals(_settings.PinnedPoolKey, "auto", StringComparison.OrdinalIgnoreCase);
            autoItem.Click += delegate { UpdatePoolSetting("auto"); };
            poolMenu.DropDownItems.Add(autoItem);

            if (_snapshot != null && _snapshot.Pools != null && _snapshot.Pools.Count > 0)
            {
                poolMenu.DropDownItems.Add(new ToolStripSeparator());
                for (int i = 0; i < _snapshot.Pools.Count; i++)
                {
                    QuotaPoolInfo p = _snapshot.Pools[i];
                    string key = p.PoolKey;
                    var item = new ToolStripMenuItem(p.PoolLabel);
                    item.Checked = string.Equals(_settings.PinnedPoolKey, key, StringComparison.OrdinalIgnoreCase);
                    item.Click += delegate { UpdatePoolSetting(key); };
                    poolMenu.DropDownItems.Add(item);
                }
            }
            _menu.Items.Add(poolMenu);

            var modeMenu = new ToolStripMenuItem("數值口徑");
            var remItem = new ToolStripMenuItem("剩餘額度 % (與膠囊一致)");
            remItem.Checked = !string.Equals(_settings.DisplayMode, "used", StringComparison.OrdinalIgnoreCase);
            remItem.Click += delegate { UpdateDisplayMode("remaining"); };
            var usedItem = new ToolStripMenuItem("已用額度 %");
            usedItem.Checked = string.Equals(_settings.DisplayMode, "used", StringComparison.OrdinalIgnoreCase);
            usedItem.Click += delegate { UpdateDisplayMode("used"); };
            modeMenu.DropDownItems.Add(remItem);
            modeMenu.DropDownItems.Add(usedItem);
            _menu.Items.Add(modeMenu);

            var themeMenu = new ToolStripMenuItem("進度條配色");
            AddThemeMenuItem(themeMenu, "復刻暖橘 (經典)", "terracotta");
            AddThemeMenuItem(themeMenu, "狀態分色 (綠 / 橘 / 紅)", "status");
            AddThemeMenuItem(themeMenu, "Antigravity 天空藍", "blue");
            _menu.Items.Add(themeMenu);

            var layoutMenu = new ToolStripMenuItem("工作列顯示模式");
            AddBarModeMenuItem(layoutMenu, "預設 (顯示雙排進度條)", "auto");
            AddBarModeMenuItem(layoutMenu, "一律顯示雙排進度條", "full");
            AddBarModeMenuItem(layoutMenu, "一律顯示超精簡純文字", "mini");
            AddBarModeMenuItem(layoutMenu, "僅顯示系統匣數字圖示", "trayonly");
            _menu.Items.Add(layoutMenu);

            var posMenu = new ToolStripMenuItem("位置與視窗行為");
            var leftItem = new ToolStripMenuItem("向左微調 24 px");
            leftItem.Click += delegate { AdjustOffsetX(-24); };
            var rightItem = new ToolStripMenuItem("向右微調 24 px");
            rightItem.Click += delegate { AdjustOffsetX(24); };
            var resetItem = new ToolStripMenuItem(string.Format(CultureInfo.InvariantCulture, "重設貼齊系統匣左側 (目前偏移 {0} px)", _settings.OffsetX));
            resetItem.Click += delegate
            {
                _settings.OffsetX = 0;
                QuotaDataStore.SaveSettings(_settings);
                RenderAndSync(true);
            };
            var hintDragItem = new ToolStripMenuItem("提示：也可按住 Alt + 左鍵直接拖曳");
            hintDragItem.Enabled = false;

            var fsItem = new ToolStripMenuItem("全螢幕時自動隱藏");
            fsItem.Checked = _settings.HideOnFullscreen;
            fsItem.Click += delegate
            {
                _settings.HideOnFullscreen = !_settings.HideOnFullscreen;
                QuotaDataStore.SaveSettings(_settings);
                RenderAndSync(true);
            };

            var autoStartItem = new ToolStripMenuItem("Windows 登入時自動啟動");
            autoStartItem.Checked = TaskbarLocator.IsAutoStartEnabled();
            autoStartItem.Click += delegate
            {
                bool target = !TaskbarLocator.IsAutoStartEnabled();
                TaskbarLocator.SetAutoStart(target);
            };

            posMenu.DropDownItems.Add(leftItem);
            posMenu.DropDownItems.Add(rightItem);
            posMenu.DropDownItems.Add(resetItem);
            posMenu.DropDownItems.Add(hintDragItem);
            posMenu.DropDownItems.Add(new ToolStripSeparator());
            posMenu.DropDownItems.Add(fsItem);
            posMenu.DropDownItems.Add(autoStartItem);
            _menu.Items.Add(posMenu);

            _menu.Items.Add(new ToolStripSeparator());

            string webUrl = QuotaDataStore.DiscoverWebMonitorUrl();
            var webItem = new ToolStripMenuItem(webUrl != null ? "開啟完整網頁監控" : "開啟完整網頁監控 (未偵測到監控埠)");
            webItem.Enabled = webUrl != null;
            if (webUrl != null)
            {
                string capturedUrl = webUrl;
                webItem.Click += delegate
                {
                    try { Process.Start(new ProcessStartInfo(capturedUrl) { UseShellExecute = true }); }
                    catch { }
                };
            }
            _menu.Items.Add(webItem);

            var refreshItem = new ToolStripMenuItem("立即重新整理");
            refreshItem.Click += delegate { RefreshDataAndSync(true); };
            _menu.Items.Add(refreshItem);

            _menu.Items.Add(new ToolStripSeparator());
            var exitItem = new ToolStripMenuItem("結束");
            exitItem.Click += delegate { Application.Exit(); };
            _menu.Items.Add(exitItem);
        }

        private void AddThemeMenuItem(ToolStripMenuItem parent, string label, string presetKey)
        {
            var item = new ToolStripMenuItem(label);
            item.Checked = string.Equals(_settings.ThemePreset, presetKey, StringComparison.OrdinalIgnoreCase);
            item.Click += delegate
            {
                _settings.ThemePreset = presetKey;
                QuotaDataStore.SaveSettings(_settings);
                RenderAndSync(true);
            };
            parent.DropDownItems.Add(item);
        }

        private void AddBarModeMenuItem(ToolStripMenuItem parent, string label, string modeKey)
        {
            var item = new ToolStripMenuItem(label);
            item.Checked = string.Equals(_settings.BarMode, modeKey, StringComparison.OrdinalIgnoreCase);
            item.Click += delegate
            {
                _settings.BarMode = modeKey;
                QuotaDataStore.SaveSettings(_settings);
                RenderAndSync(true);
            };
            parent.DropDownItems.Add(item);
        }

        private void UpdatePoolSetting(string poolKey)
        {
            _settings.PinnedPoolKey = poolKey;
            QuotaDataStore.SaveSettings(_settings);
            RenderAndSync(true);
        }

        private void UpdateDisplayMode(string mode)
        {
            _settings.DisplayMode = mode;
            QuotaDataStore.SaveSettings(_settings);
            RefreshDataAndSync(true);
        }

        private void AdjustOffsetX(int delta)
        {
            _settings.OffsetX = Math.Max(-1200, Math.Min(600, _settings.OffsetX + delta));
            QuotaDataStore.SaveSettings(_settings);
            RenderAndSync(true);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _refreshTimer.Stop();
                _refreshTimer.Dispose();
                _trayIcon.Visible = false;
                if (_trayIcon.Icon != null)
                {
                    Icon old = _trayIcon.Icon;
                    _trayIcon.Icon = null;
                    old.Dispose();
                }
                _trayIcon.Dispose();
                _menu.Dispose();
                _popup.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}

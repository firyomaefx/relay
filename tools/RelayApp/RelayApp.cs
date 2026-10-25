using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace RelayLauncher
{
    internal static class Paths
    {
        public static string RepoRoot { get; private set; }
        public static string NodePath { get; private set; }

        public static void Init()
        {
            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            for (int i = 0; i < 8 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir, "package.json")) && Directory.Exists(Path.Combine(dir, "apps")))
                {
                    RepoRoot = dir;
                    break;
                }
                dir = Path.GetDirectoryName(dir);
            }
            if (RepoRoot == null) RepoRoot = Path.GetDirectoryName(Application.ExecutablePath);

            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string candidate = Path.Combine(programFiles, "nodejs", "node.exe");
            if (File.Exists(candidate))
            {
                NodePath = candidate;
                return;
            }
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] entries = pathVar.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string entry in entries)
            {
                try
                {
                    candidate = Path.Combine(entry.Trim(), "node.exe");
                    if (File.Exists(candidate))
                    {
                        NodePath = candidate;
                        return;
                    }
                }
                catch { }
            }
            NodePath = "node";
        }
    }

    internal static class Server
    {
        private const int Port = 4317;

        public static string Url
        {
            get { return "http://127.0.0.1:" + Port; }
        }

        public static string DataDir
        {
            get { return Path.Combine(Paths.RepoRoot, ".data"); }
        }

        public static bool IsHealthy()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Url + "/api/health");
                request.Proxy = null;
                request.Timeout = 900;
                request.ReadWriteTimeout = 900;
                request.KeepAlive = false;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                {
                    return reader.ReadToEnd().IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool EnsureBuilt(out string error)
        {
            error = null;
            string entry = Path.Combine(Paths.RepoRoot, "apps", "web", "dist", "index.js");
            if (File.Exists(entry)) return true;

            int code = Run("cmd.exe", "/c npm install --no-audit --no-fund && npm run build", Paths.RepoRoot, 900000);
            if (code != 0 || !File.Exists(entry))
            {
                error = "The first-time build failed (exit code " + code + "). Open the repo and run \"npm run build\" to see the error.";
                return false;
            }
            return true;
        }

        public static bool Start(out string error)
        {
            error = null;
            try
            {
                string entry = Path.Combine(Paths.RepoRoot, "apps", "web", "dist", "index.js");
                if (!File.Exists(entry))
                {
                    error = "apps/web/dist/index.js is missing.";
                    return false;
                }
                ProcessStartInfo psi = new ProcessStartInfo(Paths.NodePath, "\"" + entry + "\"");
                psi.WorkingDirectory = Paths.RepoRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process process = Process.Start(psi);
                if (process == null)
                {
                    error = "Windows could not start Node.js.";
                    return false;
                }
                Directory.CreateDirectory(DataDir);
                File.WriteAllText(Path.Combine(DataDir, "relay.pid"), process.Id.ToString());
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        public static void Stop()
        {
            try
            {
                string pidFile = Path.Combine(DataDir, "relay.pid");
                if (File.Exists(pidFile))
                {
                    int pid;
                    if (int.TryParse(File.ReadAllText(pidFile).Trim(), out pid))
                    {
                        Run("taskkill", "/PID " + pid + " /T /F", Paths.RepoRoot, 15000);
                    }
                    try { File.Delete(pidFile); } catch { }
                }
            }
            catch { }

            try
            {
                string output = Capture("cmd.exe", "/c netstat -ano -p tcp | findstr :" + Port, Paths.RepoRoot, 8000);
                string[] lines = output.Split('\n');
                foreach (string raw in lines)
                {
                    string line = raw.Trim();
                    if (line.Length == 0) continue;
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    string[] parts = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5) continue;
                    int pid;
                    if (int.TryParse(parts[parts.Length - 1], out pid))
                    {
                        Run("taskkill", "/PID " + pid + " /T /F", Paths.RepoRoot, 15000);
                    }
                }
            }
            catch { }

            // Leave scheduler.lock alone: it may belong to an MCP server process.
            // The lock is self-cleaning when its recorded PID is no longer alive.
        }

        public static void OpenBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
            }
            catch { }
        }

        public static int Run(string file, string arguments, string workingDirectory, int timeoutMs)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
                psi.WorkingDirectory = workingDirectory;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process process = Process.Start(psi);
                if (process == null) return -1;
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    return -2;
                }
                return process.ExitCode;
            }
            catch
            {
                return -1;
            }
        }

        private static string Capture(string file, string arguments, string workingDirectory, int timeoutMs)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
                psi.WorkingDirectory = workingDirectory;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                Process process = Process.Start(psi);
                if (process == null) return "";
                string text = process.StandardOutput.ReadToEnd();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    return text;
                }
                return text;
            }
            catch
            {
                return "";
            }
        }
    }

    internal sealed class RelayForm : Form
    {
        private readonly bool noBrowser;
        private Label statusDot;
        private Label statusText;
        private Label detailLabel;
        private Button openButton;
        private Button stopButton;
        private LinkLabel hideLink;
        private NotifyIcon tray;
        private System.Windows.Forms.Timer pollTimer;
        private bool starting;
        private bool autoOpened;
        private bool exiting;
        private int lastState = -1;

        private static readonly Color Background = Color.FromArgb(11, 10, 18);
        private static readonly Color Muted = Color.FromArgb(161, 161, 170);
        private static readonly Color Accent = Color.FromArgb(167, 139, 250);
        private static readonly Color Green = Color.FromArgb(52, 211, 153);
        private static readonly Color Amber = Color.FromArgb(250, 204, 21);
        private static readonly Color Red = Color.FromArgb(248, 113, 113);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        public RelayForm(bool noBrowser)
        {
            this.noBrowser = noBrowser;
            Text = "Relay";
            ClientSize = new Size(500, 286);
            BackColor = Background;
            ForeColor = Color.FromArgb(245, 243, 255);
            Font = new Font("Segoe UI", 9.5f);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            BuildUi();
            SetupTray();

            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 2000;
            pollTimer.Tick += delegate { RefreshState(); };
            pollTimer.Start();
        }

        private void BuildUi()
        {
            PictureBox logo = new PictureBox();
            logo.Location = new Point(26, 24);
            logo.Size = new Size(52, 52);
            logo.SizeMode = PictureBoxSizeMode.Zoom;
            try { logo.Image = Icon.ToBitmap(); } catch { }
            Controls.Add(logo);

            Label title = new Label();
            title.Text = "Relay";
            title.Font = new Font("Segoe UI", 21f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(245, 243, 255);
            title.AutoSize = true;
            title.Location = new Point(92, 20);
            Controls.Add(title);

            Label subtitle = new Label();
            subtitle.Text = "Publish to X, Threads and TikTok";
            subtitle.ForeColor = Muted;
            subtitle.AutoSize = true;
            subtitle.Location = new Point(96, 56);
            Controls.Add(subtitle);

            statusDot = new Label();
            statusDot.Text = "\u25CF";
            statusDot.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
            statusDot.ForeColor = Amber;
            statusDot.AutoSize = true;
            statusDot.Location = new Point(26, 104);
            Controls.Add(statusDot);

            statusText = new Label();
            statusText.Text = "Starting Relay...";
            statusText.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            statusText.ForeColor = Color.FromArgb(245, 243, 255);
            statusText.AutoSize = true;
            statusText.Location = new Point(50, 107);
            Controls.Add(statusText);

            detailLabel = new Label();
            detailLabel.Text = "Launching the local server. The first run can take a minute.";
            detailLabel.ForeColor = Muted;
            detailLabel.AutoSize = false;
            detailLabel.Size = new Size(446, 44);
            detailLabel.Location = new Point(26, 140);
            Controls.Add(detailLabel);

            openButton = new Button();
            openButton.Text = "Open console";
            openButton.Size = new Size(214, 38);
            openButton.Location = new Point(26, 200);
            openButton.FlatStyle = FlatStyle.Flat;
            openButton.FlatAppearance.BorderSize = 0;
            openButton.BackColor = Accent;
            openButton.ForeColor = Color.FromArgb(20, 16, 34);
            openButton.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            openButton.Cursor = Cursors.Hand;
            openButton.Enabled = false;
            openButton.Click += delegate { OnOpenClicked(); };
            Controls.Add(openButton);

            stopButton = new Button();
            stopButton.Text = "Stop server";
            stopButton.Size = new Size(130, 38);
            stopButton.Location = new Point(250, 200);
            stopButton.FlatStyle = FlatStyle.Flat;
            stopButton.FlatAppearance.BorderColor = Color.FromArgb(60, 54, 84);
            stopButton.BackColor = Color.FromArgb(22, 20, 34);
            stopButton.ForeColor = Color.FromArgb(245, 243, 255);
            stopButton.Cursor = Cursors.Hand;
            stopButton.Click += delegate { StopServer(); };
            Controls.Add(stopButton);

            hideLink = new LinkLabel();
            hideLink.Text = "Hide to tray";
            hideLink.LinkColor = Muted;
            hideLink.ActiveLinkColor = Accent;
            hideLink.AutoSize = true;
            hideLink.Location = new Point(398, 210);
            hideLink.LinkClicked += delegate { HideToTray(); };
            Controls.Add(hideLink);
        }

        private void SetupTray()
        {
            Icon icon = SystemIcons.Application;
            try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            if (icon == null) icon = SystemIcons.Application;

            tray = new NotifyIcon();
            tray.Icon = icon;
            tray.Text = "Relay";
            tray.Visible = true;

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open Relay", null, delegate { OpenConsole(); });
            menu.Items.Add("Stop server", null, delegate { StopServer(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit", null, delegate { ExitApp(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenConsole(); };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int enabled = 1;
                DwmSetWindowAttribute(Handle, 20, ref enabled, 4);
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            StartRelay();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
            }
            base.Dispose(disposing);
        }

        private void StartRelay()
        {
            if (starting) return;
            starting = true;
            lastState = -1;
            SetStatus("Starting Relay...", Amber, "Launching the local server. The first run can take a minute.");
            openButton.Enabled = false;
            openButton.Text = "Starting...";

            ThreadPool.QueueUserWorkItem(delegate
            {
                string error;
                bool built = Server.EnsureBuilt(out error);
                bool started = built && (Server.IsHealthy() || Server.Start(out error));
                bool ok = false;
                for (int i = 0; i < 240 && started; i++)
                {
                    if (Server.IsHealthy())
                    {
                        ok = true;
                        break;
                    }
                    Thread.Sleep(500);
                }
                bool success = ok;
                RelayForm form = this;
                try { form.BeginInvoke(new Action(delegate { form.FinishStart(success, error); })); } catch { }
            });
        }

        private void FinishStart(bool success, string error)
        {
            starting = false;
            if (success)
            {
                lastState = 1;
                SetStatus("Relay is running", Green, "Console: " + Server.Url);
                openButton.Enabled = true;
                openButton.Text = "Open console";
                if (!noBrowser && !autoOpened)
                {
                    autoOpened = true;
                    Server.OpenBrowser();
                    tray.ShowBalloonTip(2500, "Relay is running", "Close this window to keep Relay in the tray. Right-click the tray icon to stop it.", ToolTipIcon.Info);
                }
            }
            else
            {
                lastState = 0;
                SetStatus("Relay could not start", Red, string.IsNullOrEmpty(error) ? "Check the console logs in the .data folder." : error);
                openButton.Enabled = true;
                openButton.Text = "Retry";
            }
        }

        private void RefreshState()
        {
            if (starting) return;
            bool up = Server.IsHealthy();
            int state = up ? 1 : 0;
            if (state == lastState) return;
            lastState = state;
            if (up)
            {
                SetStatus("Relay is running", Green, "Console: " + Server.Url);
                openButton.Enabled = true;
                openButton.Text = "Open console";
            }
            else
            {
                SetStatus("Relay is stopped", Color.FromArgb(148, 148, 160), "Click \"Start Relay\" to launch the console again.");
                openButton.Enabled = true;
                openButton.Text = "Start Relay";
            }
        }

        private void SetStatus(string text, Color color, string detail)
        {
            statusText.Text = text;
            statusDot.ForeColor = color;
            detailLabel.Text = detail;
        }

        private void OnOpenClicked()
        {
            if (Server.IsHealthy())
            {
                Server.OpenBrowser();
                return;
            }
            StartRelay();
        }

        private void StopServer()
        {
            Server.Stop();
            starting = false;
            lastState = 0;
            SetStatus("Relay is stopped", Color.FromArgb(148, 148, 160), "The local server was stopped. Click \"Start Relay\" to launch it again.");
            openButton.Enabled = true;
            openButton.Text = "Start Relay";
        }

        private void OpenConsole()
        {
            if (!Server.IsHealthy())
            {
                Show();
                StartRelay();
                return;
            }
            Server.OpenBrowser();
        }

        private void HideToTray()
        {
            Hide();
            tray.ShowBalloonTip(2000, "Relay", "Relay is still running. Double-click the tray icon to open the console.", ToolTipIcon.Info);
        }

        private void ExitApp()
        {
            Server.Stop();
            exiting = true;
            tray.Visible = false;
            Close();
            Application.Exit();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Paths.Init();

            if (HasArg(args, "--stop"))
            {
                Server.Stop();
                foreach (Process other in Process.GetProcessesByName("Relay"))
                {
                    if (other.Id == Process.GetCurrentProcess().Id) continue;
                    try { other.Kill(); } catch { }
                }
                return;
            }

            bool created;
            Mutex mutex = new Mutex(true, "RelayLauncher_SingleInstance", out created);
            if (!created)
            {
                Server.OpenBrowser();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new RelayForm(HasArg(args, "--no-browser")));
            GC.KeepAlive(mutex);
        }

        private static bool HasArg(string[] args, string name)
        {
            if (args == null) return false;
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
    }
}

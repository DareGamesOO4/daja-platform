using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (Array.IndexOf(args, "--run-worker") >= 0)
        {
            RunWorker();
            return;
        }
        bool background = Array.IndexOf(args, "--background") >= 0;
        bool enableStartup = Array.IndexOf(args, "--enable-startup") >= 0;
        bool ownsInstance;
        using (var instance = new Mutex(true, @"Local\DAJA.ImageWorker.UI", out ownsInstance))
        using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DAJA.ImageWorker.Show"))
        {
            if (enableStartup) Dashboard.SetStartup(true);
            if (!ownsInstance)
            {
                if (!background) show.Set();
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var dashboard = new Dashboard(show))
            {
                if (!background) dashboard.OpenWindow();
                Application.Run();
            }
        }
    }

    private static void RunWorker()
    {
        bool ownsInstance;
        using (var instance = new Mutex(true, @"Local\DAJA.ImageWorker.Process", out ownsInstance))
        {
            if (!ownsInstance) return;
            var folder = AppDomain.CurrentDomain.BaseDirectory;
            var config = Path.Combine(folder, "worker-user.json");
            var status = Path.Combine(folder, "worker-status.json");
            while (File.Exists(config))
            {
                var start = new ProcessStartInfo {
                    FileName = "node.exe", WorkingDirectory = folder, CreateNoWindow = true, UseShellExecute = false,
                    Arguments = "\"" + Path.Combine(folder, "worker.mjs") + "\" run \"" + config + "\" \"" + status + "\""
                };
                try
                {
                    using (var process = Process.Start(start)) process.WaitForExit();
                }
                catch (Win32Exception) { }
                Thread.Sleep(TimeSpan.FromSeconds(15));
            }
        }
    }
}

internal sealed class Dashboard : Form
{
    private const string Preferences = @"Software\DAJA\ImageWorker";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunName = "DAJA Image Worker";
    private static readonly Color Ink = Color.FromArgb(22, 49, 60);
    private static readonly Color Paper = Color.FromArgb(242, 247, 248);
    private static readonly Color Accent = Color.FromArgb(30, 99, 108);
    private readonly NotifyIcon tray;
    private readonly ContextMenuStrip menu;
    private readonly System.Windows.Forms.Timer timer;
    private readonly EventWaitHandle show;
    private readonly Label state;
    private readonly Label detail;
    private readonly Label renderState;
    private readonly Label linkelState;
    private readonly Label pauseState;
    private readonly ComboBox pauseDuration;
    private readonly Button pauseButton;
    private readonly Button resumeButton;
    private readonly ProgressBar progress;
    private readonly TextBox input;
    private readonly TextBox destination;
    private readonly TextBox activity;
    private readonly NumericUpDown quality;
    private readonly Button generate;
    private readonly Button openFolder;
    private readonly string statusFile;
    private string lastFolder;
    private bool quitting;

    internal static void SetStartup(bool enabled)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (enabled) key.SetValue(RunName, "\"" + Application.ExecutablePath + "\" --background");
            else key.DeleteValue(RunName, false);
        }
    }

    public Dashboard(EventWaitHandle showSignal)
    {
        show = showSignal;
        statusFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            @"DajaImageWorker\status\worker-status.json");
        Text = "DAJA · Obrada slika";
        Icon = CreateIcon();
        Font = new Font("Segoe UI", 10);
        ForeColor = Ink;
        BackColor = Paper;
        ClientSize = new Size(650, 550);
        MinimumSize = new Size(620, 560);
        StartPosition = FormStartPosition.CenterScreen;

        var layout = new TableLayoutPanel {
            Dock = DockStyle.Fill, Padding = new Padding(22, 15, 22, 16),
            ColumnCount = 1, RowCount = 11
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int row = 0; row < 10; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(layout);

        var title = new Label { Text = "DAJA  /  Obrada slika", AutoSize = true, Font = new Font("Segoe UI Semibold", 22), Margin = new Padding(0, 0, 0, 12) };
        layout.Controls.Add(title);
        var status = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Top, ColumnCount = 1, BackColor = Ink, Padding = new Padding(12), Margin = new Padding(0, 0, 0, 15) };
        state = new Label { AutoSize = true, ForeColor = Color.FromArgb(247, 223, 155), Font = new Font("Segoe UI Semibold", 12) };
        detail = new Label { AutoSize = true, ForeColor = Color.White, MaximumSize = new Size(540, 0) };
        renderState = new Label { AutoSize = true, ForeColor = Color.White, Text = "Render · stanje nije dostupno", Margin = new Padding(3, 6, 3, 0) };
        linkelState = new Label { AutoSize = true, ForeColor = Color.White, Text = "Linkel · stanje nije dostupno", Margin = new Padding(3, 6, 3, 0) };
        status.Controls.Add(state);
        status.Controls.Add(detail);
        status.Controls.Add(renderState);
        status.Controls.Add(linkelState);
        layout.Controls.Add(status);

        var controls = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = true, Margin = new Padding(0, 0, 0, 10) };
        pauseDuration = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 120 };
        pauseDuration.Items.AddRange(new object[] { "10 minuta", "30 minuta", "1 sat", "2 sata", "4 sata", "8 sati", "Dok ne nastavim" });
        pauseDuration.SelectedIndex = 0;
        pauseButton = new Button { Text = "Pauziraj obradu", AutoSize = true };
        pauseButton.Click += delegate { SetPause(); };
        resumeButton = new Button { Text = "Nastavi obradu", AutoSize = true };
        resumeButton.Click += delegate { SetPause(false); };
        pauseState = new Label { AutoSize = true, Margin = new Padding(4, 7, 0, 0) };
        controls.Controls.Add(pauseDuration); controls.Controls.Add(pauseButton); controls.Controls.Add(resumeButton); controls.Controls.Add(pauseState);
        layout.Controls.Add(controls);
        progress = new ProgressBar { Dock = DockStyle.Top, Height = 14, Maximum = 100, Margin = new Padding(0, 0, 0, 8) };
        layout.Controls.Add(progress);

        var startup = new CheckBox { Text = "Pokreni ikonicu automatski pri prijavi u Windows", AutoSize = true, Margin = new Padding(0, 0, 0, 14) };
        using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
            startup.Checked = key != null && key.GetValue(RunName) != null;
        startup.CheckedChanged += delegate {
            try { SetStartup(startup.Checked); }
            catch (Exception error) { MessageBox.Show(this, error.Message, "Automatsko pokretanje"); }
        };
        layout.Controls.Add(startup);
        layout.Controls.Add(new Label { Text = "Lokalna obrada", AutoSize = true, Font = new Font("Segoe UI Semibold", 13), Margin = new Padding(0, 0, 0, 7) });
        layout.Controls.Add(new Label { Text = "Originalna slika", AutoSize = true, Margin = new Padding(0, 0, 0, 2) });
        input = new TextBox { ReadOnly = true, Dock = DockStyle.Fill };
        layout.Controls.Add(PathRow(input, "Izaberi sliku", ChooseInput));
        layout.Controls.Add(new Label { Text = "Folder za rezultate", AutoSize = true, Margin = new Padding(0, 3, 0, 2) });
        destination = new TextBox { ReadOnly = true, Dock = DockStyle.Fill };
        layout.Controls.Add(PathRow(destination, "Izaberi folder", ChooseDestination));

        var options = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = false, Margin = new Padding(0, 5, 0, 5) };
        options.Controls.Add(new Label { Text = "Kvalitet velikog AVIF-a", AutoSize = true, Margin = new Padding(0, 7, 8, 0) });
        quality = new NumericUpDown { Minimum = 1, Maximum = 100, Width = 65, Margin = new Padding(0, 3, 10, 0) };
        options.Controls.Add(quality);
        generate = new Button { Text = "Obradi sliku", AutoSize = true, BackColor = Accent, ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        generate.Click += async delegate { await ConvertImage(); };
        options.Controls.Add(generate);
        openFolder = new Button { Text = "Otvori rezultat", AutoSize = true, Enabled = false };
        openFolder.Click += delegate { if (Directory.Exists(lastFolder)) Process.Start("explorer.exe", Quote(lastFolder)); };
        options.Controls.Add(openFolder);
        layout.Controls.Add(options);
        layout.Controls.Add(new Label { Text = "Aktivnost", AutoSize = true, Margin = new Padding(0, 7, 0, 3) });
        activity = new TextBox { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical, BackColor = Color.White };
        activity.Text = "Izaberi sliku za lokalnu obradu.";
        layout.Controls.Add(activity);
        using (var key = Registry.CurrentUser.OpenSubKey(Preferences))
        {
            destination.Text = (key == null ? null : key.GetValue("OutputFolder") as string)
                ?? Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
            var savedQuality = key == null ? 95 : Convert.ToInt32(key.GetValue("Quality", 95), CultureInfo.InvariantCulture);
            quality.Value = Math.Min(100, Math.Max(1, savedQuality));
        }
        quality.ValueChanged += delegate { SavePreferences(); };

        menu = new ContextMenuStrip();
        menu.Items.Add("Otvori DAJA", null, delegate { OpenWindow(); });
        menu.Items.Add("Izađi", null, delegate { quitting = true; Application.Exit(); });
        tray = new NotifyIcon { Text = "DAJA · Obrada slika", Icon = Icon, Visible = true, ContextMenuStrip = menu };
        tray.MouseClick += delegate(object sender, MouseEventArgs args) { if (args.Button == MouseButtons.Left) OpenWindow(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (!quitting && args.CloseReason == CloseReason.UserClosing) { args.Cancel = true; Hide(); }
        };
        timer = new System.Windows.Forms.Timer { Interval = 1500 };
        timer.Tick += delegate { if (show.WaitOne(0)) OpenWindow(); ReadWorkerStatus(); };
        timer.Start();
        ReadWorkerStatus();
    }

    public void OpenWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    private void SetPause(bool paused = true)
    {
        var userConfig = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "worker-user.json");
        var path = File.Exists(userConfig)
            ? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "worker-pause.json")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                @"DajaImageWorker\worker-pause.json");
        DateTimeOffset? until = null;
        if (paused && pauseDuration.SelectedIndex >= 0 && pauseDuration.SelectedIndex < 6)
        {
            int[] minutes = { 10, 30, 60, 120, 240, 480 };
            until = DateTimeOffset.UtcNow.AddMinutes(minutes[pauseDuration.SelectedIndex]);
        }
        File.WriteAllText(path, new JavaScriptSerializer().Serialize(new { paused, until = until.HasValue ? until.Value.ToString("o") : null }));
        pauseState.Text = paused ? (until.HasValue ? "Pauzirano do " + until.Value.ToLocalTime().ToString("t") : "Pauzirano dok ne nastaviš") : "Obrada nastavljena";
    }

    private static Control PathRow(TextBox field, string caption, EventHandler action)
    {
        var row = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Top, ColumnCount = 2, Margin = new Padding(0, 0, 0, 4) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.Controls.Add(field);
        var button = new Button { Text = caption, AutoSize = true, Margin = new Padding(4, 0, 0, 0) };
        button.Click += action;
        row.Controls.Add(button);
        return row;
    }

    private void ChooseInput(object sender, EventArgs args)
    {
        using (var picker = new OpenFileDialog { Filter = "Slike|*.jpg;*.jpeg;*.png;*.webp;*.avif;*.tif;*.tiff|Svi fajlovi|*.*" })
            if (picker.ShowDialog(this) == DialogResult.OK) input.Text = picker.FileName;
    }

    private void ChooseDestination(object sender, EventArgs args)
    {
        using (var picker = new FolderBrowserDialog { SelectedPath = destination.Text })
            if (picker.ShowDialog(this) == DialogResult.OK) { destination.Text = picker.SelectedPath; SavePreferences(); }
    }

    private void SavePreferences()
    {
        using (var key = Registry.CurrentUser.CreateSubKey(Preferences))
        {
            key.SetValue("OutputFolder", destination.Text);
            key.SetValue("Quality", (int)quality.Value);
        }
    }

    private async Task ConvertImage()
    {
        if (!File.Exists(input.Text) || !Directory.Exists(destination.Text))
        {
            activity.Text = "Izaberi originalnu sliku i postojeći folder za rezultate.";
            return;
        }
        var output = Path.Combine(destination.Text, Path.GetFileNameWithoutExtension(input.Text) + "-DAJA-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        generate.Enabled = false;
        openFolder.Enabled = false;
        activity.Text = "Sharp obrađuje sliku…";
        try
        {
            var start = new ProcessStartInfo {
                FileName = "node.exe", WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                Arguments = Quote(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "worker.mjs")) + " local " +
                    Quote(input.Text) + " " + Quote(output) + " " + quality.Value.ToString(CultureInfo.InvariantCulture),
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            using (var process = Process.Start(start))
            {
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                var reading = Task.WhenAll(stdout, stderr);
                if (await Task.WhenAny(reading, Task.Delay(TimeSpan.FromSeconds(120))) != reading)
                {
                    if (!process.HasExited) process.Kill();
                    throw new TimeoutException("Isteklo je vreme za lokalnu obradu.");
                }
                await reading;
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException(stderr.Result.Trim());
                lastFolder = output;
                activity.Text = stdout.Result.Replace("\n", Environment.NewLine);
                openFolder.Enabled = true;
            }
        }
        catch (Exception error) { activity.Text = "Obrada nije uspela. " + error.Message; }
        finally { generate.Enabled = true; }
    }

    private void ReadWorkerStatus()
    {
        renderState.Text = "Render · stanje nije dostupno";
        linkelState.Text = "Linkel · stanje nije dostupno";
        var userConfig = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "worker-user.json");
        var activeStatusFile = File.Exists(userConfig)
            ? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "worker-status.json") : statusFile;
        if (!File.Exists(userConfig) && !Directory.Exists(Path.GetDirectoryName(statusFile)))
        {
            state.Text = "Čeka povezivanje sa DAJA serverom";
            detail.Text = "Lokalna obrada je dostupna iz ovog prozora.";
            return;
        }
        try
        {
            using (var file = new FileStream(activeStatusFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(file))
            {
                var snapshot = new JavaScriptSerializer().Deserialize<WorkerStatus>(reader.ReadToEnd());
                DateTimeOffset updated;
                if (!DateTimeOffset.TryParse(snapshot.updated, out updated) || DateTimeOffset.UtcNow - updated > TimeSpan.FromSeconds(30))
                {
                    state.Text = "Pozadinski worker nije aktivan";
                    detail.Text = "Nema svežeg statusa sa ovog računara.";
                    return;
                }
                state.Text = snapshot.phase == "working" ? "Obrada je u toku" :
                    snapshot.phase == "local-paused" ? "Obrada pauzirana" :
                    snapshot.phase == "ready" ? "Povezan · čeka slike" :
                    snapshot.phase == "paused" ? "Povezan · pauziran iz admina" :
                    snapshot.phase == "error" ? "Veza ili obrada imaju problem" : "Povezivanje…";
                DateTimeOffset completed;
                linkelState.Text = "Linkel · " + (snapshot.linkel ?? "stanje nije dostupno");
                var last = DateTimeOffset.TryParse(snapshot.completed, out completed)
                    ? "Poslednja obrada " + completed.ToLocalTime().ToString("g") : "Nema završenih poslova u ovoj sesiji.";
                detail.Text = snapshot.phase == "working" ? (snapshot.productSlug ?? "Slika") + (snapshot.imageIndex.HasValue ? " · slika " + snapshot.imageIndex : "") +
                    " · " + (snapshot.sourceWidth.HasValue ? snapshot.sourceWidth + "×" + snapshot.sourceHeight + " px · " : "") +
                    (snapshot.activity ?? "Obrada slike") + " · " + snapshot.job :
                    snapshot.phase == "error" ? snapshot.error : last;
                if (snapshot.render != null)
                {
                    DateTimeOffset failure;
                    DateTimeOffset success;
                    var failed = DateTimeOffset.TryParse(snapshot.render.renderErrorAt, out failure) &&
                        (!DateTimeOffset.TryParse(snapshot.render.renderCompletedAt, out success) || failure > success);
                    renderState.Text = !snapshot.render.renderOnline ? "Render · nema svežeg signala" :
                        failed ? "Render · poslednja obrada prijavila grešku" :
                        "Render · rezerva 03:00–07:00 (posle 7 dana)";
                }
                progress.Value = Math.Max(0, Math.Min(100, snapshot.progress));
                pauseState.Text = snapshot.phase == "local-paused" ? (snapshot.pauseUntil == null ? "Pauzirano dok ne nastaviš" : "Pauzirano do " + DateTimeOffset.Parse(snapshot.pauseUntil).ToLocalTime().ToString("t")) : "";
            }
        }
        catch (IOException) { state.Text = "Čeka pokretanje workera"; detail.Text = "Status će se pojaviti kada worker krene."; }
        catch (UnauthorizedAccessException) { state.Text = "Status nije dostupan"; detail.Text = "Proveri dozvole Windows workera."; }
        catch (InvalidOperationException) { state.Text = "Status nije dostupan"; detail.Text = "Sačekaj sledeće osvežavanje."; }
        catch (ArgumentException) { state.Text = "Status nije dostupan"; detail.Text = "Sačekaj sledeće osvežavanje."; }
    }

    private static string Quote(string value) { return "\"" + value + "\""; }

    private sealed class WorkerStatus
    {
        public string phase { get; set; }
        public string job { get; set; }
        public string completed { get; set; }
        public string error { get; set; }
        public string updated { get; set; }
        public string linkel { get; set; }
        public string activity { get; set; }
        public string productSlug { get; set; }
        public int? imageIndex { get; set; }
        public int? sourceWidth { get; set; }
        public int? sourceHeight { get; set; }
        public int progress { get; set; }
        public string pauseUntil { get; set; }
        public RenderStatus render { get; set; }
    }

    private sealed class RenderStatus
    {
        public bool renderOnline { get; set; }
        public string renderErrorAt { get; set; }
        public string renderCompletedAt { get; set; }
    }

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    private static Icon CreateIcon()
    {
        using (var bitmap = new Bitmap(32, 32))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var font = new Font("Segoe UI", 20, FontStyle.Bold, GraphicsUnit.Pixel))
        {
            graphics.Clear(Ink);
            TextRenderer.DrawText(graphics, "D", font, new Rectangle(0, 0, 32, 31),
                Color.FromArgb(247, 223, 155), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            var handle = bitmap.GetHicon();
            try { return (Icon)Icon.FromHandle(handle).Clone(); }
            finally { DestroyIcon(handle); }
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (timer != null) timer.Dispose();
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            if (menu != null) menu.Dispose();
            if (Icon != null) Icon.Dispose();
        }
        base.Dispose(disposing);
    }
}

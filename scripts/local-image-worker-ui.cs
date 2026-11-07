using System;
using System.ComponentModel;
using System.Collections.Generic;
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
                    Arguments = "\"" + Path.Combine(folder, "worker.mjs") + "\" run \"" + config + "\" \"" + status +
                        "\" \"" + Path.Combine(folder, "worker-profile.json") + "\""
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
    private static readonly Color Muted = Color.FromArgb(81, 103, 111);
    private readonly NotifyIcon tray;
    private readonly ContextMenuStrip menu;
    private readonly System.Windows.Forms.Timer timer;
    private readonly EventWaitHandle show;
    private readonly Label state;
    private readonly Label detail;
    private readonly TextBox input;
    private readonly TextBox destination;
    private readonly TextBox activity;
    private readonly VariantFields[] variants = new VariantFields[4];
    private readonly Button generate;
    private readonly Button openFolder;
    private readonly string statusFile;
    private readonly string configFile;
    private readonly string profileFile;
    private readonly Label profileStatus;
    private readonly Button pauseWorker;
    private readonly Label queueStatus;
    private readonly ListView queueList;
    private readonly Button prevPage;
    private readonly Button nextPage;
    private readonly Button refreshQueue;
    private readonly Dictionary<string, Bitmap> previews = new Dictionary<string, Bitmap>();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    private bool paused;
    private bool loadingQueue;
    private int page;
    private DateTime refreshAfter;
    private string queueSignature;
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
        var folder = AppDomain.CurrentDomain.BaseDirectory;
        configFile = Path.Combine(folder, "worker-user.json");
        profileFile = Path.Combine(folder, "worker-profile.json");
        statusFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            @"DajaImageWorker\status\worker-status.json");
        Text = "DAJA Studio";
        Icon = CreateIcon();
        Font = new Font("Segoe UI", 10);
        ForeColor = Ink;
        BackColor = Paper;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(1100, 690);
        MinimumSize = new Size(990, 640);
        StartPosition = FormStartPosition.CenterScreen;

        var layout = new TableLayoutPanel {
            Dock = DockStyle.Fill, Padding = new Padding(20, 16, 20, 16), ColumnCount = 2, RowCount = 2
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 56));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 44));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(layout);

        var header = new TableLayoutPanel {
            Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, BackColor = Ink,
            Padding = new Padding(20, 13, 20, 15), Margin = new Padding(0, 0, 0, 12)
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 54));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        var title = Caption("DAJA Studio", 25, Color.White);
        header.Controls.Add(title, 0, 0);
        state = Caption("Povezivanje…", 12, Color.FromArgb(247, 223, 155));
        header.Controls.Add(state, 1, 0);
        header.Controls.Add(Caption("Priprema slika za DAJA Shop", 10, Color.FromArgb(194, 216, 218)), 0, 1);
        detail = new Label { AutoSize = true, MaximumSize = new Size(410, 0), ForeColor = Color.White };
        header.Controls.Add(detail, 1, 1);
        layout.Controls.Add(header, 0, 0);
        layout.SetColumnSpan(header, 2);

        var editor = Surface(new Padding(0, 0, 10, 0));
        for (var row = 0; row < 9; row++) editor.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        editor.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(editor, 0, 1);
        editor.Controls.Add(Caption("Profil obrade", 17, Ink));
        editor.Controls.Add(Caption("Kvalitet i dimenzije podešavaš za svaku verziju.", 10, Muted));
        var settings = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 6, Margin = new Padding(0, 8, 0, 8) };
        foreach (var width in new[] { 29, 13, 12, 15, 13, 18 })
            settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, width));
        var headings = new[] { "Verzija", "Kvalitet", "Effort", "Max px", "Lossless", "Boja" };
        for (var i = 0; i < headings.Length; i++) settings.Controls.Add(Caption(headings[i], 9, Muted), i, 0);
        var labels = new[] { "Veliki AVIF", "Veliki WebP", "Mali AVIF", "Mali WebP" };
        for (var i = 0; i < variants.Length; i++)
            variants[i] = new VariantFields(settings, i + 1, labels[i], i % 2 == 0, i < 2 ? 2048 : 512);
        editor.Controls.Add(settings);

        var actions = Actions();
        var presets = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 128 };
        presets.Items.AddRange(new object[] { "Gotovi profili", "DAJA standard", "Više detalja", "Manji fajlovi" });
        presets.SelectedIndex = 0;
        presets.SelectionChangeCommitted += delegate {
            ApplyPreset(presets.SelectedIndex);
            profileStatus.Text = "Profil je učitan u prozor. Sačuvaj ga za red poslova.";
            presets.SelectedIndex = 0;
        };
        actions.Controls.Add(presets);
        actions.Controls.Add(MakeButton("Sačuvaj profil", delegate { SaveProfile(paused, true); }, true));
        pauseWorker = MakeButton("Pauziraj red", delegate { SaveProfile(!paused, false); });
        actions.Controls.Add(pauseWorker);
        editor.Controls.Add(actions);
        profileStatus = new Label { AutoSize = true, ForeColor = Muted, MaximumSize = new Size(480, 0), Margin = new Padding(0, 4, 0, 9) };
        editor.Controls.Add(profileStatus);

        editor.Controls.Add(Caption("Lokalna proba", 17, Ink));
        input = new TextBox { ReadOnly = true, Dock = DockStyle.Fill, AccessibleName = "Originalna slika" };
        editor.Controls.Add(PathRow(input, "Izaberi sliku", ChooseInput));
        destination = new TextBox { ReadOnly = true, Dock = DockStyle.Fill, AccessibleName = "Folder za rezultate" };
        editor.Controls.Add(PathRow(destination, "Izaberi folder", ChooseDestination));
        var localActions = Actions();
        generate = MakeButton("Obradi sliku", async delegate { await ConvertImage(); }, true);
        openFolder = MakeButton("Otvori rezultat", delegate {
            if (Directory.Exists(lastFolder)) Process.Start("explorer.exe", Quote(lastFolder));
        });
        openFolder.Enabled = false;
        localActions.Controls.Add(generate);
        localActions.Controls.Add(openFolder);
        editor.Controls.Add(localActions);
        activity = new TextBox {
            Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical,
            BackColor = Color.White, MinimumSize = new Size(0, 78), Text = "Izaberi ili prevuci sliku za lokalnu probu.",
            AccessibleName = "Rezultati lokalne obrade"
        };
        editor.Controls.Add(activity);
        AllowDrop = true;
        DragEnter += delegate(object sender, DragEventArgs args) {
            if (args.Data.GetDataPresent(DataFormats.FileDrop)) args.Effect = DragDropEffects.Copy;
        };
        DragDrop += delegate(object sender, DragEventArgs args) {
            var files = args.Data.GetData(DataFormats.FileDrop) as string[];
            if (files != null && files.Length > 0 && File.Exists(files[0])) input.Text = files[0];
        };

        var queue = Surface(new Padding(0));
        for (var row = 0; row < 2; row++) queue.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        queue.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        queue.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        queue.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(queue, 1, 1);
        queue.Controls.Add(Caption("Red poslova", 17, Ink));
        queueStatus = new Label { AutoSize = true, ForeColor = Muted, Margin = new Padding(0, 3, 0, 8) };
        queue.Controls.Add(queueStatus);
        queueList = new ListView {
            Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = false,
            HeaderStyle = ColumnHeaderStyle.Nonclickable, ShowItemToolTips = true, HideSelection = false,
            BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(0, 0, 0, 6)
        };
        queueList.Columns.Add("Sat / fotografija", 220);
        queueList.Columns.Add("Status", 116);
        queueList.Resize += delegate {
            if (queueList.ClientSize.Width > 180) queueList.Columns[0].Width = queueList.ClientSize.Width - queueList.Columns[1].Width - 20;
        };
        queue.Controls.Add(queueList);
        var paging = Actions();
        prevPage = MakeButton("Prethodna", async delegate { await LoadQueue(page - 1); });
        nextPage = MakeButton("Sledeća", async delegate { await LoadQueue(page + 1); });
        refreshQueue = MakeButton("Osveži", async delegate { await LoadQueue(page); });
        prevPage.Enabled = nextPage.Enabled = false;
        paging.Controls.Add(prevPage);
        paging.Controls.Add(nextPage);
        paging.Controls.Add(refreshQueue);
        queue.Controls.Add(paging);

        var startup = new CheckBox { Text = "Prikaži ikonicu pri prijavi u Windows", AutoSize = true, Margin = new Padding(0, 6, 0, 0) };
        using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
            startup.Checked = key != null && key.GetValue(RunName) != null;
        startup.CheckedChanged += delegate {
            try { SetStartup(startup.Checked); }
            catch (Exception error) { MessageBox.Show(this, error.Message, "Automatsko pokretanje"); }
        };
        queue.Controls.Add(startup);
        using (var key = Registry.CurrentUser.OpenSubKey(Preferences))
            destination.Text = (key == null ? null : key.GetValue("OutputFolder") as string)
                ?? Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
        LoadProfile();
        menu = new ContextMenuStrip();
        menu.Items.Add("Otvori DAJA", null, delegate { OpenWindow(); });
        menu.Items.Add("Izađi", null, delegate { quitting = true; Application.Exit(); });
        tray = new NotifyIcon { Text = "DAJA · Obrada slika", Icon = Icon, Visible = true, ContextMenuStrip = menu };
        tray.MouseClick += delegate(object sender, MouseEventArgs args) { if (args.Button == MouseButtons.Left) OpenWindow(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (!quitting && args.CloseReason == CloseReason.UserClosing) { args.Cancel = true; Hide(); }
        };
        timer = new System.Windows.Forms.Timer { Interval = 1500 };
        timer.Tick += async delegate {
            if (show.WaitOne(0)) OpenWindow();
            ReadWorkerStatus();
            if (Visible && WindowState != FormWindowState.Minimized && DateTime.UtcNow >= refreshAfter) await LoadQueue(page);
        };
        timer.Start();
        ReadWorkerStatus();
    }

    public void OpenWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        refreshAfter = DateTime.MinValue;
    }

    private static Label Caption(string text, float size, Color color)
    {
        return new Label { Text = text, AutoSize = true, ForeColor = color, Font = new Font("Segoe UI", size, FontStyle.Bold) };
    }

    private static TableLayoutPanel Surface(Padding margin)
    {
        var surface = new TableLayoutPanel {
            Dock = DockStyle.Fill, BackColor = Color.White, ColumnCount = 1, Padding = new Padding(14), Margin = margin
        };
        surface.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return surface;
    }

    private static FlowLayoutPanel Actions()
    {
        return new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Top, WrapContents = true, Margin = new Padding(0) };
    }

    private static Button MakeButton(string text, EventHandler click, bool primary = false)
    {
        var button = new Button {
            Text = text, AutoSize = true, Padding = new Padding(6, 2, 6, 2), FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Accent : Color.White, ForeColor = primary ? Color.White : Ink,
            Margin = new Padding(0, 0, 6, 4)
        };
        button.FlatAppearance.BorderColor = primary ? Accent : Color.FromArgb(202, 216, 220);
        button.Click += click;
        return button;
    }

    private static Control PathRow(TextBox field, string caption, EventHandler action)
    {
        var row = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Top, ColumnCount = 2, Margin = new Padding(0, 0, 0, 4) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.Controls.Add(field);
        var button = MakeButton(caption, action);
        button.Margin = new Padding(4, 0, 0, 0);
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
        }
    }

    private sealed class VariantSettings
    {
        public int quality { get; set; }
        public int effort { get; set; }
        public int size { get; set; }
        public bool lossless { get; set; }
        public string chromaSubsampling { get; set; }
        public bool smartSubsample { get; set; }
    }

    private sealed class WorkerProfile
    {
        public bool paused { get; set; }
        public VariantSettings avif { get; set; }
        public VariantSettings webp { get; set; }
        public VariantSettings avifThumb { get; set; }
        public VariantSettings webpThumb { get; set; }

        public VariantSettings[] Outputs() { return new[] { avif, webp, avifThumb, webpThumb }; }
    }

    private sealed class VariantFields
    {
        private readonly NumericUpDown quality;
        private readonly NumericUpDown effort;
        private readonly NumericUpDown size;
        private readonly CheckBox lossless;
        private readonly ComboBox color;
        private readonly bool avif;

        public VariantFields(TableLayoutPanel table, int row, string label, bool isAvif, int maximum)
        {
            avif = isAvif;
            var name = Caption(label, 10, Ink);
            name.Anchor = AnchorStyles.Left;
            table.Controls.Add(name, 0, row);
            quality = Number(label + " kvalitet", 1, 100);
            effort = Number(label + " effort", 0, avif ? 9 : 6);
            size = Number(label + " maksimalna dimenzija", 1, maximum);
            lossless = new CheckBox { AutoSize = true, Anchor = AnchorStyles.None, AccessibleName = label + " lossless" };
            color = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, AccessibleName = label + " boja" };
            color.Items.AddRange(avif ? new object[] { "4:4:4", "4:2:0" } : new object[] { "Smart", "Obična" });
            lossless.CheckedChanged += delegate { quality.Enabled = color.Enabled = !lossless.Checked; };
            table.Controls.Add(quality, 1, row);
            table.Controls.Add(effort, 2, row);
            table.Controls.Add(size, 3, row);
            table.Controls.Add(lossless, 4, row);
            table.Controls.Add(color, 5, row);
        }

        private static NumericUpDown Number(string name, int min, int max)
        {
            return new NumericUpDown { Minimum = min, Maximum = max, Dock = DockStyle.Fill, AccessibleName = name };
        }

        public void Set(VariantSettings value)
        {
            quality.Value = Math.Max(quality.Minimum, Math.Min(quality.Maximum, value.quality));
            effort.Value = Math.Max(effort.Minimum, Math.Min(effort.Maximum, value.effort));
            size.Value = Math.Max(size.Minimum, Math.Min(size.Maximum, value.size));
            color.SelectedIndex = (avif ? value.chromaSubsampling != "4:2:0" : value.smartSubsample) ? 0 : 1;
            lossless.Checked = value.lossless;
        }

        public VariantSettings Get()
        {
            return new VariantSettings {
                quality = (int)quality.Value, effort = (int)effort.Value, size = (int)size.Value, lossless = lossless.Checked,
                chromaSubsampling = avif && !lossless.Checked && color.SelectedIndex == 1 ? "4:2:0" : "4:4:4",
                smartSubsample = color.SelectedIndex == 0
            };
        }
    }

    private WorkerProfile savedProfile;

    private void ApplyPreset(int preset)
    {
        var quality = preset == 2 ? new[] { 98, 92, 85, 85 }
            : preset == 3 ? new[] { 75, 72, 58, 65 } : new[] { 95, 75, 65, 75 };
        for (var i = 0; i < variants.Length; i++)
            variants[i].Set(new VariantSettings {
                quality = quality[i], effort = preset == 2 ? 5 : 4, size = i < 2 ? 2048 : 512,
                chromaSubsampling = preset == 3 ? "4:2:0" : "4:4:4", smartSubsample = true
            });
    }

    private WorkerProfile ReadEditor()
    {
        return new WorkerProfile {
            avif = variants[0].Get(), webp = variants[1].Get(), avifThumb = variants[2].Get(), webpThumb = variants[3].Get()
        };
    }

    private void LoadProfile()
    {
        ApplyPreset(1);
        savedProfile = ReadEditor();
        profileStatus.Text = "Sačuvani profil važi od sledeće slike u redu.";
        try
        {
            if (File.Exists(profileFile))
            {
                var profile = json.Deserialize<WorkerProfile>(File.ReadAllText(profileFile));
                var outputs = profile.Outputs();
                if (Array.Exists(outputs, output => output == null)) throw new FormatException();
                for (var i = 0; i < variants.Length; i++) variants[i].Set(outputs[i]);
                paused = profile.paused;
                savedProfile = ReadEditor();
            }
            else
            {
                using (var key = Registry.CurrentUser.OpenSubKey(Preferences))
                {
                    var oldQuality = key == null ? null : key.GetValue("Quality");
                    if (oldQuality is int)
                    {
                        var local = savedProfile.avif;
                        local.quality = (int)oldQuality;
                        variants[0].Set(local);
                        savedProfile = new WorkerProfile { avif = new VariantSettings {
                            quality = 95, effort = 4, size = 2048, chromaSubsampling = "4:4:4"
                        }, webp = savedProfile.webp, avifThumb = savedProfile.avifThumb, webpThumb = savedProfile.webpThumb };
                    }
                }
            }
        }
        catch (Exception) { profileStatus.Text = "Profil nije učitan. Sačuvaj nova podešavanja za red."; }
        pauseWorker.Enabled = File.Exists(configFile);
        pauseWorker.Text = paused ? "Nastavi red" : "Pauziraj red";
    }

    private void SaveProfile(bool pause, bool includeEditor)
    {
        var profile = includeEditor ? ReadEditor() : savedProfile;
        var previousPause = profile.paused;
        profile.paused = pause;
        var temporary = profileFile + ".tmp";
        try
        {
            File.WriteAllText(temporary, json.Serialize(profile), new UTF8Encoding(false));
            if (File.Exists(profileFile)) File.Replace(temporary, profileFile, null);
            else File.Move(temporary, profileFile);
            savedProfile = profile;
            paused = pause;
            pauseWorker.Text = paused ? "Nastavi red" : "Pauziraj red";
            profileStatus.Text = paused ? "Red je pauziran. Slika u obradi će se završiti." :
                "Sačuvani profil važi od sledeće slike u redu.";
        }
        catch (IOException) { profile.paused = previousPause; profileStatus.Text = "Profil nije sačuvan. Pokušaj ponovo."; }
        catch (UnauthorizedAccessException) { profile.paused = previousPause; profileStatus.Text = "Nema dozvole za čuvanje profila."; }
    }

    private static string Base64(string text) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(text)); }

    private static async Task<string> RunNode(string arguments, int seconds)
    {
        var folder = AppDomain.CurrentDomain.BaseDirectory;
        var start = new ProcessStartInfo {
            FileName = "node.exe", WorkingDirectory = folder,
            Arguments = Quote(Path.Combine(folder, "worker.mjs")) + " " + arguments,
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using (var process = Process.Start(start))
        {
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            var exited = Task.Run(delegate { return process.WaitForExit(seconds * 1000); });
            var result = Task.WhenAll(stdout, stderr, exited);
            using (var timeout = new CancellationTokenSource())
            {
                if (await Task.WhenAny(result, Task.Delay(TimeSpan.FromSeconds(seconds), timeout.Token)) != result || !await exited)
                {
                    if (!process.HasExited) process.Kill();
                    throw new TimeoutException("Isteklo je vreme za odgovor.");
                }
                timeout.Cancel();
                await result;
            }
            if (process.ExitCode != 0) throw new InvalidOperationException(stderr.Result.Trim());
            return stdout.Result;
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
            var result = await RunNode("local-profile " + Quote(input.Text) + " " + Quote(output) + " " +
                Base64(json.Serialize(ReadEditor())), 120);
            lastFolder = output;
            activity.Text = result.Trim().Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            openFolder.Enabled = true;
        }
        catch (Exception error) { activity.Text = "Obrada nije uspela. " + error.Message; }
        finally { generate.Enabled = true; }
    }

    private sealed class QueueItem
    {
        public string id { get; set; }
        public string slug { get; set; }
        public string image { get; set; }
        public int attempts { get; set; }
        public long bytes { get; set; }
        public string state { get; set; }
        public string key { get; set; }
        public string thumbnail { get; set; }
    }

    private sealed class QueueSnapshot
    {
        public int total { get; set; }
        public QueueItem[] items { get; set; }
    }

    private async Task LoadQueue(int targetPage)
    {
        if (loadingQueue || targetPage < 0 || targetPage > 10000) return;
        if (!File.Exists(configFile))
        {
            queueStatus.Text = "Poveži ovaj računar da vidiš red poslova.";
            refreshAfter = DateTime.UtcNow.AddSeconds(15);
            return;
        }
        loadingQueue = true;
        prevPage.Enabled = nextPage.Enabled = refreshQueue.Enabled = false;
        if (queueList.Items.Count == 0) queueStatus.Text = "Učitavam red poslova…";
        try
        {
            var keys = new List<string>(previews.Keys);
            var result = await RunNode("queue " + Quote(configFile) + " " + targetPage.ToString(CultureInfo.InvariantCulture) +
                " " + Base64(json.Serialize(keys)), 42);
            if (IsDisposed) return;
            var snapshot = json.Deserialize<QueueSnapshot>(result);
            if (targetPage > 0 && snapshot.items.Length == 0)
            {
                page = targetPage - 1;
                RenderQueue(snapshot.items);
                queueStatus.Text = "Učitavam prethodnu stranu…";
                return;
            }
            page = targetPage;
            RenderQueue(snapshot.items);
            queueStatus.Text = snapshot.total == 0 ? "Nema slika na čekanju." :
                String.Format("{0} u redu  ·  {1}–{2} od {0}", snapshot.total, page * 8 + 1, page * 8 + snapshot.items.Length);
            nextPage.Enabled = (page + 1) * 8 < snapshot.total && page < 10000;
        }
        catch (Exception error)
        {
            if (IsDisposed) return;
            queueStatus.Text = error.Message.Contains("HTTP 404") ? "Red će biti dostupan posle ažuriranja servera." :
                queueList.Items.Count == 0 ? "Red trenutno nije dostupan. Pokušaj ponovo." :
                "Prikazan je poslednji učitani red.";
        }
        finally
        {
            loadingQueue = false;
            refreshAfter = DateTime.UtcNow.AddSeconds(queueStatus.Text == "Učitavam prethodnu stranu…" ? 0 : 15);
            if (!IsDisposed)
            {
                prevPage.Enabled = page > 0;
                refreshQueue.Enabled = true;
            }
        }
    }

    private void RenderQueue(QueueItem[] items)
    {
        var keys = new HashSet<string>(Array.ConvertAll(items, item => item.key));
        foreach (var key in new List<string>(previews.Keys))
        {
            if (keys.Contains(key)) continue;
            previews[key].Dispose();
            previews.Remove(key);
        }
        foreach (var item in items)
        {
            if (String.IsNullOrEmpty(item.thumbnail) || previews.ContainsKey(item.key)) continue;
            using (var stream = new MemoryStream(Convert.FromBase64String(item.thumbnail)))
            using (var photo = Image.FromStream(stream))
            {
                var canvas = new Bitmap(56, 56);
                using (var graphics = Graphics.FromImage(canvas))
                {
                    graphics.Clear(Color.White);
                    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    var scale = Math.Min(56.0 / photo.Width, 56.0 / photo.Height);
                    var width = Math.Max(1, (int)Math.Round(photo.Width * scale));
                    var height = Math.Max(1, (int)Math.Round(photo.Height * scale));
                    graphics.DrawImage(photo, (56 - width) / 2, (56 - height) / 2, width, height);
                }
                previews.Add(item.key, canvas);
            }
        }
        var signature = String.Join("|", Array.ConvertAll(items, item =>
            item.key + ":" + item.state + ":" + item.attempts + ":" + previews.ContainsKey(item.key)));
        if (signature == queueSignature) return;
        queueSignature = signature;
        var selected = queueList.SelectedItems.Count > 0 ? queueList.SelectedItems[0].Name : null;
        var previous = queueList.SmallImageList;
        var images = new ImageList { ColorDepth = ColorDepth.Depth32Bit, ImageSize = new Size(56, 56) };
        using (var blank = new Bitmap(56, 56))
        {
            images.Images.Add(blank);
            queueList.BeginUpdate();
            try
            {
                queueList.Items.Clear();
                foreach (var item in items)
                {
                    Bitmap preview;
                    var index = 0;
                    if (previews.TryGetValue(item.key, out preview))
                    {
                        index = images.Images.Count;
                        images.Images.Add(preview);
                    }
                    var name = (item.slug ?? item.id).Replace('-', ' ') +
                        (String.IsNullOrEmpty(item.image) ? "" : "  /  " + item.image);
                    var row = new ListViewItem(name, index) { Name = item.key };
                    row.SubItems.Add(item.state == "active" ? "U obradi" : item.state == "paused" ? "Zaustavljeno" :
                        item.state == "fallback" ? "Čeka Render" : item.state == "retry" ? "Ponovni pokušaj" : "Na čekanju");
                    row.ToolTipText = name + Environment.NewLine + (item.bytes / 1024.0).ToString("N1") +
                        " KiB · Pokušaji: " + item.attempts;
                    queueList.Items.Add(row);
                    row.Selected = item.key == selected;
                }
                queueList.SmallImageList = images;
                // Materialize the image list before any cached bitmaps can be removed on refresh.
                var handle = images.Handle;
            }
            finally { queueList.EndUpdate(); }
        }
        if (previous != null) previous.Dispose();
    }

    private void ReadWorkerStatus()
    {
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
                    snapshot.phase == "paused" ? "Red je pauziran" :
                    snapshot.phase == "ready" ? "Povezan · čeka slike" :
                    snapshot.phase == "error" ? "Veza ili obrada imaju problem" : "Povezivanje…";
                DateTimeOffset completed;
                var last = DateTimeOffset.TryParse(snapshot.completed, out completed)
                    ? "Poslednja obrada " + completed.ToLocalTime().ToString("g") : "Nema završenih poslova u ovoj sesiji.";
                detail.Text = snapshot.phase == "working" ? "Posao " + snapshot.job :
                    snapshot.phase == "error" ? snapshot.error : last;
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
            if (queueList != null && queueList.SmallImageList != null) queueList.SmallImageList.Dispose();
            foreach (var preview in previews.Values) preview.Dispose();
            if (Icon != null) Icon.Dispose();
        }
        base.Dispose(disposing);
    }
}

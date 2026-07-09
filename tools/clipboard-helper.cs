using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ClipboardHelper
{
    private const uint INPUT_KEYBOARD = 1;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_C = 0x43;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint CF_UNICODETEXT = 13;

    private const int INITIAL_DELAY_MS = 25;
    private const int POLL_INTERVAL_MS = 10;
    private const int MAX_WAIT_MS = 250;

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        var sw = Stopwatch.StartNew();

        uint sequenceBefore = 0;
        uint sequenceAfter = 0;
        string previousText = "";
        string text = "";
        string error = "";
        bool changed = false;
        bool ok = false;
        bool inputOk = false;
        string inputMethod = "";
        uint sendInputSent = 0;
        int sendInputLastError = 0;
        int pollTimeMs = 0;

        try
        {
            sequenceBefore = GetClipboardSequenceNumber();
            previousText = ReadClipboardTextSafe();

            // Give the target app a tiny moment to finalize the mouse selection after WM_LBUTTONUP.
            Thread.Sleep(INITIAL_DELAY_MS);

            inputOk = TrySendCtrlC(out inputMethod, out sendInputSent, out sendInputLastError);

            // Do not fail immediately when SendInput reports 0. We may have already used keybd_event fallback,
            // and the only truth that matters for this provider is whether the clipboard sequence changed.
            uint lastSeq = sequenceBefore;
            for (int elapsed = 0; elapsed <= MAX_WAIT_MS; elapsed += POLL_INTERVAL_MS)
            {
                sequenceAfter = GetClipboardSequenceNumber();

                if (sequenceAfter != sequenceBefore)
                {
                    changed = true;
                    pollTimeMs = elapsed;
                    break;
                }

                if (elapsed == MAX_WAIT_MS)
                {
                    pollTimeMs = elapsed;
                    break;
                }

                Thread.Sleep(POLL_INTERVAL_MS);
                lastSeq = sequenceAfter;
            }

            if (changed)
            {
                // Some applications update the sequence before the text handle is immediately readable.
                for (int i = 0; i < 10; i++)
                {
                    text = ReadClipboardTextSafe();
                    if (!String.IsNullOrEmpty(text))
                    {
                        break;
                    }
                    Thread.Sleep(10);
                }

                if (String.IsNullOrEmpty(text))
                {
                    error = "clipboard_empty";
                }
                else
                {
                    ok = true;
                    error = "";
                }
            }
            else
            {
                error = inputOk ? "clipboard_not_changed" : "input_failed_clipboard_not_changed";
            }
        }
        catch (Exception ex)
        {
            error = "exception:" + ex.GetType().Name + ":" + ex.Message;
        }
        finally
        {
            sw.Stop();
            if (sequenceAfter == 0)
            {
                sequenceAfter = GetClipboardSequenceNumber();
            }

            double confidence = ok ? (text == previousText ? 0.75 : 0.85) : 0.0;

            var sb = new StringBuilder();
            sb.Append("{");
            Add(sb, "ok", ok); sb.Append(",");
            Add(sb, "text", ok ? text : ""); sb.Append(",");
            Add(sb, "fullText", ok ? text : ""); sb.Append(",");
            Add(sb, "source", "clipboard"); sb.Append(",");
            Add(sb, "confidence", confidence); sb.Append(",");
            Add(sb, "changed", changed); sb.Append(",");
            Add(sb, "sequenceBefore", sequenceBefore); sb.Append(",");
            Add(sb, "sequenceAfter", sequenceAfter); sb.Append(",");
            Add(sb, "pollTimeMs", pollTimeMs); sb.Append(",");
            Add(sb, "durationMs", sw.ElapsedMilliseconds); sb.Append(",");
            Add(sb, "method", "clipboard-v2-sendinput-sequence"); sb.Append(",");
            Add(sb, "error", ok ? "" : error); sb.Append(",");
            Add(sb, "textLen", ok ? text.Length : 0); sb.Append(",");
            Add(sb, "previousTextLen", previousText == null ? 0 : previousText.Length); sb.Append(",");
            Add(sb, "inputOk", inputOk); sb.Append(",");
            Add(sb, "inputMethod", inputMethod); sb.Append(",");
            Add(sb, "sendInputSent", sendInputSent); sb.Append(",");
            Add(sb, "sendInputLastError", sendInputLastError);
            sb.Append("}");

            Console.WriteLine(sb.ToString());
        }

        // Always return 0 when we successfully emitted JSON.
        // The Electron side should decide validity from ok/changed/error, not from process exit code.
        return 0;
    }

    private static bool TrySendCtrlC(out string inputMethod, out uint sendInputSent, out int sendInputLastError)
    {
        inputMethod = "sendinput";
        sendInputLastError = 0;

        INPUT[] inputs = new INPUT[4];

        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki = new KEYBDINPUT { wVk = VK_CONTROL, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = IntPtr.Zero };

        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki = new KEYBDINPUT { wVk = VK_C, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = IntPtr.Zero };

        inputs[2].type = INPUT_KEYBOARD;
        inputs[2].U.ki = new KEYBDINPUT { wVk = VK_C, wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero };

        inputs[3].type = INPUT_KEYBOARD;
        inputs[3].U.ki = new KEYBDINPUT { wVk = VK_CONTROL, wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero };

        sendInputSent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sendInputSent == inputs.Length)
        {
            Thread.Sleep(10);
            return true;
        }

        sendInputLastError = Marshal.GetLastWin32Error();

        // Fallback. keybd_event is deprecated, but it is still a useful fallback when SendInput returns 0
        // because of structure-size/UIPI/driver quirks. It returns void, so we verify success by sequence change later.
        inputMethod = "keybd_event_fallback";
        keybd_event((byte)VK_CONTROL, 0, 0, UIntPtr.Zero);
        Thread.Sleep(2);
        keybd_event((byte)VK_C, 0, 0, UIntPtr.Zero);
        Thread.Sleep(2);
        keybd_event((byte)VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(2);
        keybd_event((byte)VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(10);

        return true;
    }

    private static string ReadClipboardTextSafe()
    {
        for (int i = 0; i < 8; i++)
        {
            try
            {
                string s = ReadClipboardTextOnce();
                return s ?? "";
            }
            catch
            {
                Thread.Sleep(5);
            }
        }

        return "";
    }

    private static string ReadClipboardTextOnce()
    {
        if (!OpenClipboard(IntPtr.Zero))
        {
            return "";
        }

        try
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT))
            {
                return "";
            }

            IntPtr handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero)
            {
                return "";
            }

            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero)
            {
                return "";
            }

            try
            {
                string text = Marshal.PtrToStringUni(pointer);
                return text ?? "";
            }
            finally
            {
                GlobalUnlock(handle);
            }
        }
        finally
        {
            CloseClipboard();
        }
    }

    private static void Add(StringBuilder sb, string key, string value)
    {
        sb.Append('"').Append(JsonEscape(key)).Append("\":\"").Append(JsonEscape(value ?? "")).Append('"');
    }

    private static void Add(StringBuilder sb, string key, bool value)
    {
        sb.Append('"').Append(JsonEscape(key)).Append("\":").Append(value ? "true" : "false");
    }

    private static void Add(StringBuilder sb, string key, int value)
    {
        sb.Append('"').Append(JsonEscape(key)).Append("\":").Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static void Add(StringBuilder sb, string key, long value)
    {
        sb.Append('"').Append(JsonEscape(key)).Append("\":").Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static void Add(StringBuilder sb, string key, uint value)
    {
        sb.Append('"').Append(JsonEscape(key)).Append("\":").Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static void Add(StringBuilder sb, string key, double value)
    {
        sb.Append('"').Append(JsonEscape(key)).Append("\":").Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static string JsonEscape(string s)
    {
        if (String.IsNullOrEmpty(s))
        {
            return "";
        }

        var sb = new StringBuilder(s.Length + 16);
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        return sb.ToString();
    }
}

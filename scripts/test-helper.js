// Compile the production restore methods against fake Win32 windows and a virtual
// clock. No desktop windows are opened, moved or minimized by these tests.
// Run on Windows with: node scripts/test-helper.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const csc = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find(p => fs.existsSync(p));
if (!csc) throw new Error('Tests require the Windows .NET Framework C# compiler');

const source = fs.readFileSync(path.join(__dirname, '..', 'native', 'WinHelper.cs'), 'utf8');
function method(name) {
  const start = source.search(new RegExp('    static [^\\n]+\\b' + name + '\\('));
  if (start < 0) throw new Error('Missing production method: ' + name);
  const open = source.indexOf('{', start);
  // Production method braces are balanced (including those in comments/strings).
  let depth = 1, end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error('Unbalanced method: ' + name);
  return source.slice(start, end);
}
const methods = ['Restore', 'ApplyRestore', 'WantsSettle', 'IsEmuHawk',
  'IsLuaConsole', 'IsJunkTitle', 'GetAllProcessNames', 'ParseTargets',
  'ExtractStr', 'ExtractInt'].map(method).join('\n')
  .replaceAll('DateTime.Now', 'Now').replaceAll('Thread.Sleep(', 'Advance(');

const harness = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
class HelperTests {
    struct WinInfo { public string process, title; public int x,y,w,h; public bool minimized; }
    struct RECT { public int L,T,R,B; }
    struct WINDOWPLACEMENT { public int length; public RECT normalPos; }
    class Settling { public IntPtr h; public WinInfo t; public DateTime placedAt; }
    class Window { public string title, process; public int appears; public bool minimized; }
    const int SETTLE_POLL_MS = 100;
    static int elapsed;
    static DateTime Now { get { return new DateTime(2020,1,1).AddMilliseconds(elapsed); } }
    static Dictionary<IntPtr,Window> windows = new Dictionary<IntPtr,Window>();
    static List<string> calls = new List<string>();
    static void Advance(int ms) { elapsed += ms; }
    static bool IsWindow(IntPtr h) { return windows.ContainsKey(h); }
    static string GetTitle(IntPtr h) { return windows[h].title; }
    static bool IsIconic(IntPtr h) { return windows[h].minimized; }
    static bool ShowWindow(IntPtr h, int cmd) { calls.Add("show:"+h+":"+cmd); return true; }
    static bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool repaint) { calls.Add("move:"+h); return true; }
    static uint GetWindowThreadProcessId(IntPtr h,out uint pid) { pid=(uint)h.ToInt32(); return 1; }
    static bool GetWindowPlacement(IntPtr h,ref WINDOWPLACEMENT wp) { wp.normalPos.R=800; wp.normalPos.B=600; return true; }
    static List<IntPtr> GetAllHandles() {
        var handles = new List<IntPtr>();
        foreach (var w in windows) if (elapsed >= w.Value.appears) handles.Add(w.Key);
        return handles;
    }
    static Dictionary<int,string> GetTargetPids(string[] names) {
        var result = new Dictionary<int,string>();
        foreach (var w in windows) result.Add(w.Key.ToInt32(),w.Value.process);
        return result;
    }
    // Settling itself is unchanged by this fix; these tests cover matching and initial placement.
    static void Settle(List<Settling> settling) { settling.Clear(); }
    ${methods}
    static void Reset() { elapsed=0; windows.Clear(); calls.Clear(); }
    static IntPtr Add(int id,string title,string process,int appears) {
        var h = new IntPtr(id);
        windows.Add(h,new Window { title=title,process=process,appears=appears }); return h;
    }
    static WinInfo Target(string title,string process,bool minimized) {
        return new WinInfo { title=title,process=process,minimized=minimized,w=800,h=600 };
    }
    static void Check(bool ok,string name) {
        if (!ok) throw new Exception(name+"; calls: "+string.Join(",",calls.ToArray()));
        Console.WriteLine("PASS "+name);
    }
    static void Layout(string file, bool includeMain) {
        File.WriteAllText(file,"[{\\"process\\":\\"EmuHawk\\",\\"title\\":\\"Lua Console\\",\\"minimized\\":true}"+
            (includeMain ? ",{\\"process\\":\\"EmuHawk\\",\\"title\\":\\"old ROM - BizHawk\\",\\"minimized\\":false}" : "")+"]");
    }
    static void Main(string[] args) {
        string file=args[0];
        Reset(); var main=Add(1,"EmuHawk","EmuHawk",0);
        ApplyRestore(main,Target("Lua Console","EmuHawk",true));
        Check(calls.Count==0 && elapsed==5000,"timeout never minimizes main window");

        Reset(); main=Add(1,"ROM - BizHawk","EmuHawk",0);
        ApplyRestore(main,Target("ROM - BizHawk","EmuHawk",true));
        Check(calls.Count==0 && elapsed==0,"saved minimized main window is left alone");

        Reset(); var lua=Add(2,"Lua Console","EmuHawk",0);
        ApplyRestore(lua,Target("Lua Console","EmuHawk",true));
        Check(calls.Count==1 && calls[0]=="show:2:6","identified console is minimized");
        calls.Clear(); ApplyRestore(lua,Target("Lua Console","EmuHawk",false));
        Check(calls.Count==0,"visible console is left alone");

        Reset(); ApplyRestore(new IntPtr(99),Target("Lua Console","EmuHawk",true));
        Check(calls.Count==0,"destroyed handle is left alone");

        Reset(); main=Add(1,"ROM - BizHawk","emuhawk",0);
        ApplyRestore(main,Target("ROM - BizHawk","emuhawk",false));
        Check(calls.Count==0 && !WantsSettle(Target("ROM - BizHawk","emuhawk",false)),
            "EmuHawk protections are case insensitive");

        Reset(); Add(1,"EmuHawk","EmuHawk",0); Add(2,"Lua Console","EmuHawk",500);
        Layout(file,true); Restore(file);
        Check(calls.Count==1 && calls[0]=="show:2:6","delayed console never steals startup main window");

        Reset(); Add(1,"EmuHawk","EmuHawk",0); Layout(file,true); Restore(file);
        Check(calls.Count==0,"Lua disabled: stale console target leaves main window alone");

        Reset(); Add(1,"new ROM - BizHawk","EmuHawk",0); Add(2,"Lua Console","EmuHawk",500);
        Layout(file,true); Restore(file);
        Check(calls.Count==1 && calls[0]=="show:2:6","ROM title change still matches main and console separately");

        Reset(); Add(3,"New timer title","Timer",0);
        File.WriteAllText(file,"[{\\"process\\":\\"Timer\\",\\"title\\":\\"Old timer title\\",\\"minimized\\":false}]");
        Restore(file);
        Check(calls.Count==2 && calls[0]=="show:3:9" && calls[1]=="move:3",
            "other apps retain process fallback and placement");
    }
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-helper-test-'));
try {
  const cs = path.join(dir, 'HelperTests.cs');
  const exe = path.join(dir, 'HelperTests.exe');
  fs.writeFileSync(cs, harness);
  execFileSync(csc, ['/nologo', '/warn:0', '/out:' + exe, cs], { stdio: 'inherit' });
  execFileSync(exe, [path.join(dir, 'layout.json')], { stdio: 'inherit' });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

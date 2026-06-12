/*
 * maintctl — agent-side maintenance & dépannage.
 *
 * Actions reçues du serveur :
 *   - 'clean'   : nettoyage temp/browser/dism/profiles (DelProf2)
 *   - 'devList' : énumère les périphériques via Get-PnpDevice
 *
 * Note Duktape : child.exitCode jamais mis à jour → on attache un handler
 * 'exit' et un timeout par tâche.
 */

"use strict";

var mesh = null;

function dbg(m) {
    // Écrit à un chemin connu et fixe (et pas via createWriteStream qui
    // n'est pas dispo dans Duktape). Append manuel via readFileSync+writeFileSync.
    try {
        var fs = require('fs');
        var p = 'C:\\Windows\\Temp\\maintctl-agent.log';
        var prev = '';
        try { prev = fs.readFileSync(p).toString(); } catch (_) {}
        if (prev.length > 200000) prev = prev.slice(-100000); // rotation simple
        var line = new Date().toISOString() + ' ' + m + '\r\n';
        fs.writeFileSync(p, prev + line);
    } catch (e) {}
}

function reply(payload) {
    var msg = { action: 'plugin', plugin: 'maintctl' };
    Object.keys(payload).forEach(function (k) { msg[k] = payload[k]; });
    try {
        if (mesh && typeof mesh.SendCommand === 'function') mesh.SendCommand(msg);
        else require('MeshAgent').SendCommand(JSON.stringify(msg));
    } catch (e) { dbg('reply error: ' + e); }
}

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    var fnname = args.pluginaction || (args._ && args._[1]);
    try {
        switch (fnname) {
            case 'ping':
                reply({ pluginaction: 'pong', dispatchId: args.dispatchId, agent: process.platform });
                return 'pong';
            case 'clean':
                doClean(args);
                return 'clean started';
            case 'devList':
                doDevList(args);
                return 'devList started';
            case 'devDetails':
                doDevDetails(args);
                return 'devDetails started';
            case 'devAction':
                doDevAction(args);
                return 'devAction started';
            case 'driverInstall':
                doDriverInstall(args);
                return 'driverInstall started';
            case 'eventList':
                doEventList(args);
                return 'eventList started';
            case 'regEnumKeys':    regRunEnumKeys(args); return 'regEnumKeys started';
            case 'regEnumValues':  regRunPs(args, regPsEnumValues(args.path)); return 'regEnumValues started';
            case 'regReadValue':   regRunPs(args, regPsReadValue(args.path, args.name)); return 'regReadValue started';
            case 'regWriteValue':  regRunPs(args, regPsWriteValue(args.path, args.name, args.type, args.data)); return 'regWriteValue started';
            case 'regDeleteValue': regRunPs(args, regPsDeleteValue(args.path, args.name)); return 'regDeleteValue started';
            case 'regDeleteKey':   regRunPs(args, regPsDeleteKey(args.path)); return 'regDeleteKey started';
            case 'regCreateKey':   regRunPs(args, regPsCreateKey(args.path)); return 'regCreateKey started';
            case 'examLock':       doExamLock(args); return 'examLock started';
            case 'examUnlock':     doExamUnlock(args); return 'examUnlock started';
            case 'examStatus':     doExamStatus(args); return 'examStatus started';
            default:
                // Répond toujours pour que le serveur ne reste pas en attente.
                try { reply({ pluginaction: 'unknownAction', dispatchId: args && args.dispatchId, ok: false, error: 'action inconnue côté agent: ' + fnname + ' (module peut-être obsolète, redémarre l\'agent)' }); } catch (e) {}
                return 'maintctl: action inconnue ' + fnname;
        }
    } catch (e) {
        dbg('consoleaction error: ' + e);
        reply({ pluginaction: 'cleanComplete', dispatchId: args && args.dispatchId, ok: false, error: String(e) });
        return 'error ' + e;
    }
}

module.exports = { consoleaction: consoleaction };

// --- PowerShell scripts par tâche ---

var PS_TEMP = ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$paths = @("$env:TEMP","C:\\Windows\\Temp","C:\\Windows\\Prefetch","C:\\Windows\\SoftwareDistribution\\Download");'
    + '$total = 0;'
    + 'foreach ($p in $paths) {'
    + '  if (Test-Path $p) {'
    + '    $sz = (Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum;'
    + '    if ($sz) { $total += $sz }'
    + '    Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object {'
    + '      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue'
    + '    };'
    + '    Write-Host ("cleaned: " + $p)'
    + '  } else { Write-Host ("skip (missing): " + $p) }'
    + '}'
    + 'Write-Host ("RESULT:" + $total + ":ok")';

var PS_BROWSER = ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$users = Get-ChildItem "C:\\Users" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @("Default","Default User","Public","All Users") };'
    + '$rel = @('
    + '  "AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache",'
    + '  "AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache",'
    + '  "AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache",'
    + '  "AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Code Cache",'
    + '  "AppData\\Local\\Mozilla\\Firefox\\Profiles"'
    + ');'
    + '$total = 0;'
    + 'foreach ($u in $users) {'
    + '  foreach ($r in $rel) {'
    + '    $p = Join-Path $u.FullName $r;'
    + '    if (Test-Path $p) {'
    + '      if ($r -like "*Firefox*") {'
    + '        Get-ChildItem $p -Directory -ErrorAction SilentlyContinue | ForEach-Object {'
    + '          $c1 = Join-Path $_.FullName "cache2";'
    + '          $c2 = Join-Path $_.FullName "startupCache";'
    + '          foreach ($c in @($c1,$c2)) {'
    + '            if (Test-Path $c) {'
    + '              $sz = (Get-ChildItem $c -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum;'
    + '              if ($sz) { $total += $sz }'
    + '              Remove-Item $c -Recurse -Force -ErrorAction SilentlyContinue'
    + '            }'
    + '          }'
    + '        }'
    + '      } else {'
    + '        $sz = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum;'
    + '        if ($sz) { $total += $sz }'
    + '        Get-ChildItem $p -Force -ErrorAction SilentlyContinue | ForEach-Object {'
    + '          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue'
    + '        }'
    + '      }'
    + '      Write-Host ("cleaned: " + $p)'
    + '    }'
    + '  }'
    + '}'
    + 'Write-Host ("RESULT:" + $total + ":ok")';

var PS_DISM = ''
    + '$ErrorActionPreference = "SilentlyContinue";'
    + '$before = (Get-PSDrive C).Free;'
    + 'Write-Host "DISM /Online /Cleanup-Image /StartComponentCleanup ...";'
    + 'Start-Process -FilePath "Dism.exe" -ArgumentList "/Online","/Cleanup-Image","/StartComponentCleanup","/Quiet" -Wait -NoNewWindow;'
    + 'if (Test-Path "C:\\Windows.old") {'
    + '  Write-Host "Removing C:\\Windows.old";'
    + '  takeown /F "C:\\Windows.old" /R /D Y | Out-Null;'
    + '  icacls "C:\\Windows.old" /grant administrators:F /T /C | Out-Null;'
    + '  Remove-Item "C:\\Windows.old" -Recurse -Force -ErrorAction SilentlyContinue'
    + '}'
    + 'Write-Host "vssadmin delete shadows /for=C: /oldest";'
    + 'cmd /c "vssadmin delete shadows /for=C: /oldest /quiet" 2>&1 | Out-Null;'
    + '$after = (Get-PSDrive C).Free;'
    + '$freed = $after - $before;'
    + 'if ($freed -lt 0) { $freed = 0 }'
    + 'Write-Host ("RESULT:" + $freed + ":ok")';

// PnP devices : on écrit le JSON dans un fichier passé en arg ($args[0]) pour
// éviter le buffering stdout sur de gros payloads. Status est castée en
// string (enum sinon).
function buildPsDevList(outPath) {
    return ''
        + '$ErrorActionPreference = "SilentlyContinue";'
        + 'try {'
        + '  $devs = Get-PnpDevice | ForEach-Object {'
        + '    [PSCustomObject]@{'
        + '      Status = [string]$_.Status;'
        + '      Class = [string]$_.Class;'
        + '      FriendlyName = [string]$_.FriendlyName;'
        + '      InstanceId = [string]$_.InstanceId;'
        + '      Problem = [int]$_.Problem;'
        + '      ProblemDescription = [string]$_.ProblemDescription;'
        + '      Manufacturer = [string]$_.Manufacturer;'
        + '    }'
        + '  };'
        + '  $json = $devs | ConvertTo-Json -Compress;'
        + '  $utf8NoBom = New-Object System.Text.UTF8Encoding($false);'
        + '  [System.IO.File]::WriteAllText(\'' + outPath.replace(/'/g, "''") + '\', $json, $utf8NoBom);'
        + '  Write-Host "OK";'
        + '} catch { Write-Host ("ERR: " + $_.Exception.Message); exit 1 }';
}

// Liste des comptes à PRÉSERVER, passée à DelProf2 via /ed:<name>.
// Pas d'espace (execFile ne quote pas) → "Default*" wildcard + skip des
// vrais comptes système. Win >= Vista n'a plus de profil "All Users"
// ni "Default User".
var PROFILE_SKIP = [
    'Administrator', 'Administrateur', 'admin',
    'Default*', 'Public',
    'DefaultAppPool', 'IUSR', 'IWAM',
    'systemprofile', 'LocalService', 'NetworkService',
    'defaultuser0', 'WDAGUtilityAccount',
    'maintenance'
];

function buildDelprof2Args(days) {
    var args = ['/u', '/i', '/d:' + (parseInt(days, 10) || 90)];
    for (var i = 0; i < PROFILE_SKIP.length; i++) {
        args.push('/ed:' + PROFILE_SKIP[i]);
    }
    return args;
}

// Download via PowerShell HttpWebRequest (.NET bas niveau).
// - WebClient.DownloadFile : pas de Timeout exposé → hang infini possible.
// - curl.exe Win10 19042 : version 7.55 buggée, -k ne bypass pas SEC_E_UNTRUSTED_ROOT
//   (fix curl 7.61+, donc inutilisable ici).
// HttpWebRequest expose Timeout + ReadWriteTimeout ET respecte le callback
// ServerCertificateValidationCallback = { $true } qui ignore le cert MC.
function downloadFile(url, dest, cb) {
    dbg('downloadFile start url=' + url + ' dest=' + dest);
    var fs = require('fs');
    var cp = require('child_process');
    var done = false;
    function finish(err) {
        if (done) return;
        done = true;
        cb(err || null);
    }
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var script = ''
        + '$ErrorActionPreference = "Stop";'
        + 'try {'
        + '  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls11 -bor [System.Net.SecurityProtocolType]::Tls;'
        + '  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true };'
        + '  $req = [System.Net.HttpWebRequest]::Create(\'' + url.replace(/'/g, "''") + '\');'
        + '  $req.Method = "GET";'
        + '  $req.Timeout = 30000;'           // connect/headers 30s
        + '  $req.ReadWriteTimeout = 60000;'  // stream 60s entre 2 reads
        + '  $req.AllowAutoRedirect = $true;'
        + '  $resp = $req.GetResponse();'
        + '  $stream = $resp.GetResponseStream();'
        + '  $fileStream = [System.IO.File]::Create(\'' + dest.replace(/'/g, "''") + '\');'
        + '  $stream.CopyTo($fileStream);'
        + '  $fileStream.Close();'
        + '  $stream.Close();'
        + '  $resp.Close();'
        + '  Write-Host "OK";'
        + '} catch {'
        + '  Write-Host ("ERR: " + $_.Exception.Message);'
        + '  if ($_.Exception.InnerException) { Write-Host ("INNER: " + $_.Exception.InnerException.Message) }'
        + '  exit 1;'
        + '}';
    var ps1 = dest + '.dl.ps1';
    try { fs.writeFileSync(ps1, script); }
    catch (e) { return finish(new Error('write ps1: ' + e)); }
    var child;
    try {
        child = cp.execFile(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', ps1]);
    } catch (e) {
        try { fs.unlinkSync(ps1); } catch (_) {}
        return finish(new Error('spawn ps download: ' + e));
    }
    var log = '';
    if (child.stdout) child.stdout.on('data', function (d) { log += d.toString(); });
    if (child.stderr) child.stderr.on('data', function (d) { log += d.toString(); });
    child.on('exit', function (code) {
        dbg('downloadFile PS exited code=' + code + ' log=' + log.trim().slice(0, 300));
        try { fs.unlinkSync(ps1); } catch (_) {}
        if (!fs.existsSync(dest)) return finish(new Error('PS download: ' + (log.trim() || 'pas de fichier (code ' + code + ')')));
        var st;
        try { st = fs.statSync(dest); } catch (_) { return finish(new Error('stat dest failed')); }
        if (!st.size) {
            try { fs.unlinkSync(dest); } catch (_) {}
            return finish(new Error('PS downloaded empty: ' + log.trim()));
        }
        dbg('downloadFile OK size=' + st.size);
        finish(null);
    });
    // Watchdog Node 150s (filet : PS a déjà Timeout=30s + ReadWriteTimeout=60s)
    setTimeout(function () {
        if (done) return;
        dbg('downloadFile TIMEOUT 150s — kill PS');
        try { child.kill(); } catch (_) {}
        try { fs.unlinkSync(ps1); } catch (_) {}
        finish(new Error('download timeout 150s'));
    }, 150000);
}

// Exécute DelProf2.exe via un wrapper PowerShell qui utilise
// Start-Process -Wait -WindowStyle Hidden -PassThru. Le lancement direct
// par cp.execFile faisait que l'event 'exit' ne se déclenchait jamais
// dans Duktape (DelProf2 ne ferme pas stdio proprement même avec /u).
// On lit l'exit code via -PassThru, et le delta de place libre sur C:.
function runDelprof2(exePath, days, timeoutMs, onDone) {
    dbg('runDelprof2 start exe=' + exePath + ' days=' + days);
    var fs = require('fs');
    var cp = require('child_process');
    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

    // Args DelProf2 : /u = unattended (pas de prompts), /i = ignore errors,
    // /d:N = profils inactifs >N jours, /ed:nom = exclure (préserver).
    // PAS /q : on veut l'output pour debug. /q = quiet + unattended ; /u
    // = unattended sans cacher l'output.
    var args = ['/u', '/i', '/d:' + (parseInt(days, 10) || 90)];
    PROFILE_SKIP.forEach(function (n) { args.push('/ed:' + n); });

    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var ps1 = tmpRoot + '\\maintctl_delprof_' + Date.now() + '.ps1';
    var outTxt = tmpRoot + '\\maintctl_delprof_out.txt';
    var errTxt = tmpRoot + '\\maintctl_delprof_err.txt';
    var psArgsLit2 = args.map(function (a) { return "'" + a.replace(/'/g, "''") + "'"; }).join(',');
    var script = ''
        + '$ErrorActionPreference = "Stop";'
        + 'try {'
        + '  $before = (Get-PSDrive C).Free;'
        + '  $p = Start-Process -FilePath \'' + exePath.replace(/'/g, "''") + '\''
        + '    -ArgumentList @(' + psArgsLit2 + ')'
        + '    -Wait -WindowStyle Hidden -PassThru'
        + '    -RedirectStandardOutput \'' + outTxt.replace(/'/g, "''") + '\''
        + '    -RedirectStandardError \'' + errTxt.replace(/'/g, "''") + '\';'
        + '  $after = (Get-PSDrive C).Free;'
        + '  $freed = [int64]($after - $before); if ($freed -lt 0) { $freed = 0 }'
        + '  $stdout = if (Test-Path \'' + outTxt.replace(/'/g, "''") + '\') { Get-Content \'' + outTxt.replace(/'/g, "''") + '\' -Raw } else { "" }'
        + '  $stderr = if (Test-Path \'' + errTxt.replace(/'/g, "''") + '\') { Get-Content \'' + errTxt.replace(/'/g, "''") + '\' -Raw } else { "" }'
        + '  Write-Host ("MAINTCTL_EXIT:" + [int]$p.ExitCode);'
        + '  Write-Host ("MAINTCTL_FREED:" + $freed);'
        + '  Write-Host "----- DelProf2 stdout -----";'
        + '  if ($stdout) { Write-Host $stdout }'
        + '  if ($stderr) { Write-Host "----- DelProf2 stderr -----"; Write-Host $stderr }'
        + '  Remove-Item \'' + outTxt.replace(/'/g, "''") + '\' -ErrorAction SilentlyContinue;'
        + '  Remove-Item \'' + errTxt.replace(/'/g, "''") + '\' -ErrorAction SilentlyContinue;'
        + '} catch {'
        + '  Write-Host ("MAINTCTL_ERR:" + $_.Exception.Message);'
        + '  exit 1;'
        + '}';

    try { fs.writeFileSync(ps1, script); }
    catch (e) { return onDone(false, 0, 0, 'write ps1: ' + e); }

    var child;
    try {
        child = cp.execFile(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', ps1]);
    } catch (e) {
        try { fs.unlinkSync(ps1); } catch (_) {}
        return onDone(false, 0, 0, 'spawn ps: ' + e);
    }

    var log = '';
    var done = false;
    if (child.stdout) child.stdout.on('data', function (d) { log += d.toString(); });
    if (child.stderr) child.stderr.on('data', function (d) { log += d.toString(); });

    function finish() {
        if (done) return;
        done = true;
        try { fs.unlinkSync(ps1); } catch (_) {}
        var exitMatch = log.match(/MAINTCTL_EXIT:(-?\d+)/);
        var freedMatch = log.match(/MAINTCTL_FREED:(\d+)/);
        var exitCode = exitMatch ? parseInt(exitMatch[1], 10) : -1;
        var freed = freedMatch ? parseInt(freedMatch[1], 10) : 0;
        var ok = (exitCode === 0);
        var removed = (log.match(/Deleted profile:/gi) || []).length;
        dbg('runDelprof2 finish ok=' + ok + ' exitCode=' + exitCode + ' freed=' + freed + ' removed=' + removed + ' logLen=' + log.length);
        dbg('runDelprof2 FULL LOG:\r\n' + log);
        onDone(ok, freed, removed, log);
    }
    child.on('exit', function () { dbg('runDelprof2 child exited'); finish(); });
    setTimeout(function () {
        if (done) return;
        dbg('runDelprof2 TIMEOUT after ' + Math.round(timeoutMs / 1000) + 's');
        try { child.kill(); } catch (_) {}
        log += '\nMAINTCTL_ERR: timeout après ' + Math.round(timeoutMs / 1000) + 's';
        finish();
    }, timeoutMs);
}

function runPowerShell(script, timeoutMs, onDone) {
    var fs = require('fs');
    var cp = require('child_process');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var ps1 = tmpRoot + '\\maintctl_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.ps1';
    var log = '';
    var done = false;
    var bytes = 0;
    var note = '';

    try { fs.writeFileSync(ps1, script); }
    catch (e) { onDone(false, 0, '', 'write ps1 failed: ' + e); return; }

    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var child;
    try {
        child = cp.execFile(psExe, [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive',
            '-File', ps1
        ]);
    } catch (e) { onDone(false, 0, '', 'spawn failed: ' + e); return; }

    if (child.stdout) {
        child.stdout.on('data', function (d) {
            var s = d.toString();
            log += s;
            var lines = s.split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(/^RESULT:(\d+):(.*)$/);
                if (m) { bytes = parseInt(m[1], 10) || 0; note = m[2] || ''; }
            }
        });
    }
    if (child.stderr) {
        child.stderr.on('data', function (d) { log += d.toString(); });
    }

    function finish(ok, err) {
        if (done) return;
        done = true;
        try { fs.unlinkSync(ps1); } catch (_) {}
        onDone(ok, bytes, log, note || (err || ''));
    }

    child.on('exit', function () { finish(true, ''); });

    setTimeout(function () {
        if (done) return;
        try { child.kill(); } catch (_) {}
        finish(false, 'timeout');
    }, timeoutMs);
}

// Nettoyage natif PowerShell via Win32_UserProfile (LastUseTime fiable),
// sans dépendance à DelProf2. DelProf2 utilisait un timestamp interne
// foireux (LocalProfileUnloadTime du registre) qui se met à jour à chaque
// chargement de hive même sans logon, → faisait apparaître les profils
// comme "récents" alors que LastUseTime disait 2022.
function buildPsProfileClean(days, excludeList) {
    var exclLit = excludeList.map(function (n) {
        return "'" + n.replace(/'/g, "''") + "'";
    }).join(',');
    return ''
        + '$ErrorActionPreference = "SilentlyContinue";'
        + 'try {'
        + '  $cutoff = (Get-Date).AddDays(-' + (parseInt(days, 10) || 90) + ');'
        + '  $excl = @(' + exclLit + ');'
        + '  $before = (Get-PSDrive C).Free;'
        + '  $deleted = 0; $errors = 0;'
        + '  $profiles = Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop;'
        + '  foreach ($p in $profiles) {'
        + '    if ($p.Special) { continue }'
        + '    if ($p.Loaded)  { Write-Host ("SKIP loaded: " + $p.LocalPath); continue }'
        + '    if (-not $p.LocalPath) { continue }'
        + '    if (-not (Test-Path $p.LocalPath)) { continue }'
        + '    $name = Split-Path -Leaf $p.LocalPath;'
        + '    $match = $false;'
        + '    foreach ($e in $excl) {'
        + '      if ($e -like $name) { $match = $true; break }'
        + '      if ($name -eq $e)   { $match = $true; break }'
        + '    }'
        + '    if ($match) { Write-Host ("SKIP excluded: " + $p.LocalPath); continue }'
        // Vraie "dernière activité" : max des LastWriteTime du dossier
        // profil + sous-dossiers utilisateur (Documents/Desktop/etc.).
        // Tested : Win32_UserProfile.LastUseTime ET NTUSER.DAT sont touchés
        // par Windows au boot (eleve.elib avait LastUse + NTUSER.DAT à
        // 15:01:45 sur un poste sans logon depuis 2022). Les dossiers eux
        // ne sont pas touchés au boot — c'est ce que montre l'Explorateur.
        + '    $candidates = @($p.LocalPath, '
        + '      (Join-Path $p.LocalPath "Documents"),'
        + '      (Join-Path $p.LocalPath "Desktop"),'
        + '      (Join-Path $p.LocalPath "Downloads"),'
        + '      (Join-Path $p.LocalPath "Pictures"),'
        + '      (Join-Path $p.LocalPath "AppData\\Roaming"));'
        + '    $dates = @();'
        + '    foreach ($c in $candidates) {'
        + '      if (Test-Path $c) {'
        + '        try { $dates += (Get-Item $c -Force).LastWriteTime } catch {}'
        + '      }'
        + '    }'
        + '    if ($dates.Count -gt 0) {'
        + '      $activity = ($dates | Measure-Object -Maximum).Maximum;'
        + '    } else {'
        + '      $activity = $p.LastUseTime;'
        + '    }'
        + '    if (-not $activity -or $activity -gt $cutoff) {'
        + '      Write-Host ("SKIP recent: " + $p.LocalPath + " (activity: " + $activity + ")");'
        + '      continue;'
        + '    }'
        + '    try {'
        + '      Write-Host ("DELETE: " + $p.LocalPath + " (activity: " + $activity + ")");'
        + '      Remove-CimInstance -InputObject $p -ErrorAction Stop;'
        + '      $deleted++;'
        + '    } catch {'
        + '      Write-Host ("ERR delete " + $p.LocalPath + ": " + $_.Exception.Message);'
        + '      $errors++;'
        + '    }'
        + '  }'
        + '  $after = (Get-PSDrive C).Free;'
        + '  $freed = [int64]($after - $before); if ($freed -lt 0) { $freed = 0 }'
        + '  Write-Host ("MAINTCTL_DELETED:" + $deleted);'
        + '  Write-Host ("MAINTCTL_ERRORS:" + $errors);'
        + '  Write-Host ("MAINTCTL_FREED:" + $freed);'
        + '  Write-Host ("MAINTCTL_EXIT:0");'
        + '} catch {'
        + '  Write-Host ("MAINTCTL_ERR:" + $_.Exception.Message);'
        + '  Write-Host ("MAINTCTL_EXIT:1");'
        + '  exit 1;'
        + '}';
}

function doProfilesTask(data, profileDays, cb) {
    dbg('doProfilesTask (native) start days=' + profileDays);
    var script = buildPsProfileClean(profileDays, PROFILE_SKIP);
    runPowerShell(script, 30 * 60 * 1000, function (ok, _bytes, log) {
        var deletedM = (log || '').match(/MAINTCTL_DELETED:(\d+)/);
        var errorsM = (log || '').match(/MAINTCTL_ERRORS:(\d+)/);
        var freedM = (log || '').match(/MAINTCTL_FREED:(\d+)/);
        var exitM = (log || '').match(/MAINTCTL_EXIT:(-?\d+)/);
        var deleted = deletedM ? parseInt(deletedM[1], 10) : 0;
        var errors = errorsM ? parseInt(errorsM[1], 10) : 0;
        var freed = freedM ? parseInt(freedM[1], 10) : 0;
        var exitCode = exitM ? parseInt(exitM[1], 10) : -1;
        var success = ok && exitCode === 0;
        dbg('doProfilesTask DONE ok=' + success + ' deleted=' + deleted + ' errors=' + errors + ' freed=' + freed);
        dbg('doProfilesTask FULL LOG:\r\n' + (log || ''));
        cb(success, freed, deleted, log);
    });
}

function doClean(data) {
    dbg('doClean platform=' + process.platform + ' tasksType=' + (typeof data.tasks) + ' tasks=' + JSON.stringify(data.tasks) + ' did=' + (data.dispatchId || '(none)') + ' hasUrl=' + (!!data.delprof2Url));
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'cleanComplete', dispatchId: data.dispatchId, ok: false, error: 'maintctl: Windows only' });
        return;
    }
    var tasks = (data.tasks && data.tasks.length) ? data.tasks : ['temp'];
    var profileDays = data.profileDays || 90;
    var results = {};
    var idx = 0;

    function next() {
        if (idx >= tasks.length) {
            reply({
                pluginaction: 'cleanComplete',
                dispatchId: data.dispatchId,
                ok: true,
                results: results
            });
            return;
        }
        var t = tasks[idx++];
        if (t === 'profiles') {
            return doProfilesTask(data, profileDays, function (ok, bytes, removed, log) {
                var note = (removed != null) ? String(removed) : '';
                results[t] = { ok: ok, bytes: bytes, note: note, logTail: (log || '').slice(-1500) };
                reply({
                    pluginaction: 'cleanProgress', dispatchId: data.dispatchId,
                    task: t, ok: ok, bytes: bytes, note: note
                });
                next();
            });
        }
        var script = '', timeout = 5 * 60 * 1000;
        switch (t) {
            case 'temp':     script = PS_TEMP; break;
            case 'browser':  script = PS_BROWSER; timeout = 10 * 60 * 1000; break;
            case 'dism':     script = PS_DISM; timeout = 30 * 60 * 1000; break;
            default:
                results[t] = { ok: false, bytes: 0, note: 'unknown task' };
                next(); return;
        }
        runPowerShell(script, timeout, function (ok, bytes, log, note) {
            results[t] = { ok: ok, bytes: bytes, note: note, logTail: (log || '').slice(-1500) };
            reply({
                pluginaction: 'cleanProgress',
                dispatchId: data.dispatchId,
                task: t,
                ok: ok,
                bytes: bytes,
                note: note
            });
            next();
        });
    }
    next();
}

// Détails d'un device : Hardware IDs, version pilote, fournisseur, date, service.
function buildPsDevDetails(instanceId, outPath) {
    var idEsc = instanceId.replace(/'/g, "''");
    return ''
        + '$ErrorActionPreference = "SilentlyContinue";'
        + 'try {'
        + '  $id = \'' + idEsc + '\';'
        + '  $d = Get-PnpDevice -InstanceId $id;'
        + '  $props = Get-PnpDeviceProperty -InstanceId $id -ErrorAction SilentlyContinue;'
        + '  function P($k) { ($props | Where-Object { $_.KeyName -eq $k } | Select-Object -First 1).Data }'
        + '  $hwIds = @(P "DEVPKEY_Device_HardwareIds");'
        + '  $compatIds = @(P "DEVPKEY_Device_CompatibleIds");'
        + '  $obj = [PSCustomObject]@{'
        + '    InstanceId = [string]$d.InstanceId;'
        + '    FriendlyName = [string]$d.FriendlyName;'
        + '    Class = [string]$d.Class;'
        + '    Status = [string]$d.Status;'
        + '    Problem = [int]$d.Problem;'
        + '    ProblemDescription = [string]$d.ProblemDescription;'
        + '    Manufacturer = [string]$d.Manufacturer;'
        + '    HardwareIds = @($hwIds | ForEach-Object { [string]$_ });'
        + '    CompatibleIds = @($compatIds | ForEach-Object { [string]$_ });'
        + '    Service = [string](P "DEVPKEY_Device_Service");'
        + '    DriverVersion = [string](P "DEVPKEY_Device_DriverVersion");'
        + '    DriverProvider = [string](P "DEVPKEY_Device_DriverProvider");'
        + '    DriverDate = [string](P "DEVPKEY_Device_DriverDate");'
        + '    DriverDesc = [string](P "DEVPKEY_Device_DriverDesc");'
        + '    DriverInfPath = [string](P "DEVPKEY_Device_DriverInfPath");'
        + '    LocationInfo = [string](P "DEVPKEY_Device_LocationInfo");'
        + '    PdoName = [string](P "DEVPKEY_Device_PDOName");'
        + '  };'
        + '  $json = $obj | ConvertTo-Json -Compress -Depth 4;'
        + '  $utf8NoBom = New-Object System.Text.UTF8Encoding($false);'
        + '  [System.IO.File]::WriteAllText(\'' + outPath.replace(/'/g, "''") + '\', $json, $utf8NoBom);'
        + '  Write-Host "OK";'
        + '} catch { Write-Host ("ERR: " + $_.Exception.Message); exit 1 }';
}

function doDevDetails(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'devDetailsResult', dispatchId: data.dispatchId, ok: false, error: 'maintctl: Windows only' });
        return;
    }
    var instanceId = data.instanceId || '';
    if (!instanceId) {
        reply({ pluginaction: 'devDetailsResult', dispatchId: data.dispatchId, ok: false, error: 'instanceId requis' });
        return;
    }
    var fs = require('fs');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var outPath = tmpRoot + '\\maintctl_dd_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.json';
    runPowerShell(buildPsDevDetails(instanceId, outPath), 60 * 1000, function (ok, _bytes, log) {
        var raw = '';
        var err = '';
        try {
            if (fs.existsSync(outPath)) {
                raw = fs.readFileSync(outPath).toString();
                try { fs.unlinkSync(outPath); } catch (_) {}
            } else {
                err = 'fichier JSON pas généré (PS log: ' + (log || '').slice(-300).trim() + ')';
            }
        } catch (e) { err = 'lecture: ' + e; }
        reply({
            pluginaction: 'devDetailsResult',
            dispatchId: data.dispatchId,
            ok: ok && !err,
            error: err || undefined,
            detailsJson: raw,
            logTail: (!ok || err) ? (log || '').slice(-1000) : ''
        });
    });
}

// Actions agir-vite sur un device.
// action ∈ { 'scan', 'enable', 'disable', 'remove' }
function buildPsDevAction(instanceId, action) {
    var idEsc = instanceId.replace(/'/g, "''");
    var body;
    switch (action) {
        case 'scan':
            body = 'pnputil /scan-devices 2>&1 | Out-String | Write-Host';
            break;
        case 'enable':
            body = 'Enable-PnpDevice -InstanceId \'' + idEsc + '\' -Confirm:$false -ErrorAction Stop; Write-Host "enabled"';
            break;
        case 'disable':
            body = 'Disable-PnpDevice -InstanceId \'' + idEsc + '\' -Confirm:$false -ErrorAction Stop; Write-Host "disabled"';
            break;
        case 'remove':
            body = 'pnputil /remove-device "' + idEsc.replace(/"/g, '""') + '" 2>&1 | Out-String | Write-Host';
            break;
        default:
            body = 'Write-Host ("unknown action")';
    }
    return ''
        + '$ErrorActionPreference = "Stop";'
        + 'try { ' + body + ' }'
        + 'catch { Write-Host ("ERR: " + $_.Exception.Message); exit 1 }';
}

function doDevAction(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'devActionResult', dispatchId: data.dispatchId, ok: false, error: 'maintctl: Windows only' });
        return;
    }
    var action = data.devAction || '';
    var instanceId = data.instanceId || '';
    if (['scan','enable','disable','remove'].indexOf(action) < 0) {
        reply({ pluginaction: 'devActionResult', dispatchId: data.dispatchId, ok: false, error: 'action invalide' });
        return;
    }
    if (action !== 'scan' && !instanceId) {
        reply({ pluginaction: 'devActionResult', dispatchId: data.dispatchId, ok: false, error: 'instanceId requis' });
        return;
    }
    runPowerShell(buildPsDevAction(instanceId, action), 90 * 1000, function (ok, _bytes, log) {
        reply({
            pluginaction: 'devActionResult',
            dispatchId: data.dispatchId,
            ok: ok,
            action: action,
            instanceId: instanceId,
            logTail: (log || '').slice(-1500)
        });
    });
}

// Installation d'un pack driver (.zip contenant un ou plusieurs .inf).
// Flow : download zip → Expand-Archive → pnputil /add-driver *.inf /install /subdirs.
// Le succès est jugé sur $LASTEXITCODE :
//   0    = ERROR_SUCCESS
//   3010 = ERROR_SUCCESS_REBOOT_REQUIRED (toujours OK, reboot requis)
//   259  = ERROR_NO_MORE_ITEMS (rien à installer) → on remonte ok=false
// Bloc PS commun : itère les .inf un par un et écrit la progression dans progressFile
// (lu côté JS pour remonter à MC pendant que pnputil tourne).
// Itérer permet : (a) progress lisible, (b) si un .inf échoue, les suivants continuent.
function buildPsInstallLoop(dirE, progressE) {
    return ''
        + '  $progress = \'' + progressE + '\';'
        + '  "extract: scanning .inf" | Out-File -FilePath $progress -Encoding ASCII -Force;'
        + '  $infs = @(Get-ChildItem -Path \'' + dirE + '\' -Filter *.inf -Recurse -ErrorAction SilentlyContinue);'
        + '  Write-Host ("MAINTCTL_INFS:" + $infs.Count);'
        + '  if ($infs.Count -eq 0) { "done: aucun .inf detecte" | Out-File -FilePath $progress -Encoding ASCII -Force; Write-Host "MAINTCTL_EXIT:259"; exit 0 }'
        + '  $installed = 0; $errors = 0; $reboot = $false; $i = 0;'
        + '  foreach ($inf in $infs) {'
        + '    $i++;'
        + '    ("install: " + $i + "/" + $infs.Count + " " + $inf.Name) | Out-File -FilePath $progress -Encoding ASCII -Force;'
        + '    $out = & pnputil.exe /add-driver $inf.FullName /install 2>&1 | Out-String;'
        + '    $c = $LASTEXITCODE;'
        + '    if (([regex]::Matches($out, "(?i)oem\\d+\\.inf")).Count -gt 0) { $installed++ }'
        + '    if ($c -eq 3010) { $reboot = $true }'
        + '    elseif ($c -ne 0 -and $c -ne 259) { $errors++ }'
        + '  }'
        + '  ("done: " + $installed + " installe(s), " + $errors + " erreur(s)") | Out-File -FilePath $progress -Encoding ASCII -Force;'
        + '  Write-Host ("MAINTCTL_INSTALLED:" + $installed);'
        + '  Write-Host ("MAINTCTL_ERRORS:" + $errors);'
        + '  $exitCode = 0; if ($reboot) { $exitCode = 3010 }'
        + '  Write-Host ("MAINTCTL_EXIT:" + $exitCode);';
}

function buildPsDriverInstall(zipPath, extractDir) {
    var zipE = zipPath.replace(/'/g, "''");
    var dirE = extractDir.replace(/'/g, "''");
    var progressE = (extractDir + '\\_maintctl_progress.txt').replace(/'/g, "''");
    return ''
        + '$ErrorActionPreference = "Stop";'
        + 'try {'
        + '  if (-not (Test-Path \'' + zipE + '\')) { throw "zip introuvable" }'
        + '  if (Test-Path \'' + dirE + '\') { Remove-Item \'' + dirE + '\' -Recurse -Force -ErrorAction SilentlyContinue }'
        + '  New-Item -ItemType Directory -Path \'' + dirE + '\' -Force | Out-Null;'
        + '  $progress = \'' + progressE + '\';'
        + '  "extract: starting" | Out-File -FilePath $progress -Encoding ASCII -Force;'
        + '  $tar = "$env:SystemRoot\\System32\\tar.exe";'
        + '  $useTar = Test-Path $tar;'
        + '  Write-Host ("MAINTCTL_EXTRACT:" + $(if ($useTar) { "tar" } else { "expand-archive" }));'
        + '  $t0 = Get-Date;'
        + '  if ($useTar) {'
        + '    Push-Location \'' + dirE + '\';'
        + '    try { & $tar -xf \'' + zipE + '\'; if ($LASTEXITCODE -ne 0) { throw "tar code $LASTEXITCODE" } } finally { Pop-Location }'
        + '  } else {'
        + '    Expand-Archive -LiteralPath \'' + zipE + '\' -DestinationPath \'' + dirE + '\' -Force;'
        + '  }'
        + '  Write-Host ("MAINTCTL_EXTRACT_SEC:" + [int]((Get-Date) - $t0).TotalSeconds);'
        + buildPsInstallLoop(dirE, progressE)
        + '} catch { Write-Host ("ERR: " + $_.Exception.Message); Write-Host "MAINTCTL_EXIT:1"; exit 1 }';
}

// pnputil sur un dossier déjà extrait (pas de Expand-Archive).
function buildPsDriverInstallDir(extractDir) {
    var dirE = extractDir.replace(/'/g, "''");
    var progressE = (extractDir + '\\_maintctl_progress.txt').replace(/'/g, "''");
    return ''
        + '$ErrorActionPreference = "Stop";'
        + 'try {'
        + buildPsInstallLoop(dirE, progressE)
        + '} catch { Write-Host ("ERR: " + $_.Exception.Message); Write-Host "MAINTCTL_EXIT:1"; exit 1 }';
}

// Télécharge tous les fichiers du pack en série dans extractDir.
function downloadPackFiles(files, extractDir, onProgress, onDone) {
    var fs = require('fs');
    try { if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir); }
    catch (e) { return onDone(new Error('mkdir extract: ' + e.message)); }
    var i = 0;
    function next() {
        if (i >= files.length) return onDone(null);
        var f = files[i++];
        if (!f || !f.name || !f.url) return onDone(new Error('fichier invalide dans la liste'));
        if (!/^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+$/.test(f.name)) return onDone(new Error('nom fichier suspect: ' + f.name));
        onProgress && onProgress(i, files.length, f.name);
        downloadFile(f.url, extractDir + '\\' + f.name, function (err) {
            if (err) return onDone(new Error('download ' + f.name + ': ' + err.message));
            next();
        });
    }
    next();
}

function doDriverInstall(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'driverInstallComplete', dispatchId: data.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var fs = require('fs');
    var url = data.driverUrl || '';
    var files = data.driverFiles || null;
    if (!url && !(files && files.length)) {
        reply({ pluginaction: 'driverInstallComplete', dispatchId: data.dispatchId, ok: false, error: 'driverUrl ou driverFiles requis' });
        return;
    }
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var ts = Date.now() + '_' + Math.floor(Math.random() * 1e9);
    var extractDir = tmpRoot + '\\maintctl_drv_' + ts;

    // Janitor : si un install précédent a planté (poste éteint, agent crashé),
    // les dossiers maintctl_drv_* restent dans %TEMP%. On nettoie ceux > 2h
    // avant de démarrer le nouveau, pour ne pas saturer le disque.
    try {
        var STALE_MS = 2 * 60 * 60 * 1000;
        var entries = fs.readdirSync(tmpRoot);
        entries.forEach(function (name) {
            if (!/^maintctl_drv_/.test(name)) return;
            var full = tmpRoot + '\\' + name;
            try {
                var st = fs.statSync(full);
                if (!st.isDirectory()) return;
                if ((Date.now() - st.mtimeMs) < STALE_MS) return;
                require('child_process').execFile(
                    (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\cmd.exe',
                    ['/c', 'rmdir', '/S', '/Q', full]
                );
            } catch (_) {}
        });
    } catch (_) {}

    function runInstall(script, cleanupExtras) {
        // Polling du fichier de progression écrit par PowerShell.
        // Permet de remonter "install: 12/45 NomDriver.inf" en temps réel,
        // et donne un état frais à MC dès que le MeshAgent récupère sa WS
        // (perte typique pendant l'install d'un pilote réseau).
        var progressFile = extractDir + '\\_maintctl_progress.txt';
        var lastSent = '';
        var pollTimer = setInterval(function () {
            try {
                var p = fs.readFileSync(progressFile, 'utf8');
                if (p) { p = p.replace(/[\r\n]+$/, ''); }
                if (p && p !== lastSent) {
                    lastSent = p;
                    reply({ pluginaction: 'driverInstallProgress', dispatchId: data.dispatchId, step: p });
                }
            } catch (_) {}
        }, 4000);

        runPowerShell(script, 30 * 60 * 1000, function (ok, _bytes, log) {
            try { clearInterval(pollTimer); } catch (_) {}
            (cleanupExtras || []).forEach(function (p) { try { fs.unlinkSync(p); } catch (_) {} });
            var installed = 0, errors = 0, code = -1;
            var m1 = (log || '').match(/MAINTCTL_INSTALLED:(\d+)/);
            if (m1) installed = parseInt(m1[1], 10) || 0;
            var mE = (log || '').match(/MAINTCTL_ERRORS:(\d+)/);
            if (mE) errors = parseInt(mE[1], 10) || 0;
            var m2 = (log || '').match(/MAINTCTL_EXIT:(-?\d+)/);
            if (m2) code = parseInt(m2[1], 10);
            var reboot = (code === 3010);
            var success = ok && (code === 0 || code === 3010) && installed > 0;
            var errMsg = '';
            if (!ok) errMsg = 'PowerShell échoué (timeout ?)';
            else if (code === 259) errMsg = 'Aucun .inf détecté dans le pack';
            else if (installed === 0) errMsg = 'pnputil n\'a publié aucun pilote (code ' + code + ')';
            else if (errors > 0) errMsg = errors + ' .inf en erreur (' + installed + ' installés)';
            // Cleanup : toujours sur succès, sinon on garde extractDir pour debug RDP
            if (success) {
                try {
                    require('child_process').execFile(
                        (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\cmd.exe',
                        ['/c', 'rmdir', '/S', '/Q', extractDir]
                    );
                } catch (_) {}
            }
            // Renvoi répété : si la WS MC est coupée (installation pilote réseau),
            // SendCommand est silencieusement perdu. On réémet le résultat à intervalles
            // pendant ~10 min — quand l'agent récupère sa WS, MC reçoit le complete.
            // Idempotent côté serveur (dispatchId fixe, écrit dans results[nodeId]).
            var finalPayload = {
                pluginaction: 'driverInstallComplete',
                dispatchId: data.dispatchId,
                ok: success,
                installed: installed,
                errors: errors,
                rebootRequired: reboot,
                error: success ? undefined : errMsg,
                logTail: (log || '').slice(-3000)
            };
            var attempts = 0;
            (function tick() {
                reply(finalPayload);
                attempts++;
                if (attempts < 20) setTimeout(tick, 30000); // 20 × 30s = 10 min
            })();
        });
    }

    if (files && files.length) {
        // Mode pack : N fichiers à télécharger directement dans extractDir
        reply({ pluginaction: 'driverInstallProgress', dispatchId: data.dispatchId, step: 'download 0/' + files.length });
        downloadPackFiles(files, extractDir, function (i, n, name) {
            reply({ pluginaction: 'driverInstallProgress', dispatchId: data.dispatchId, step: 'download ' + i + '/' + n + ' (' + name + ')' });
        }, function (err) {
            if (err) {
                reply({ pluginaction: 'driverInstallComplete', dispatchId: data.dispatchId, ok: false, error: err.message });
                return;
            }
            reply({ pluginaction: 'driverInstallProgress', dispatchId: data.dispatchId, step: 'install' });
            runInstall(buildPsDriverInstallDir(extractDir), []);
        });
        return;
    }

    // Mode legacy : un .zip
    var zipPath = tmpRoot + '\\maintctl_drv_' + ts + '.zip';
    reply({ pluginaction: 'driverInstallProgress', dispatchId: data.dispatchId, step: 'download' });
    downloadFile(url, zipPath, function (err) {
        if (err) {
            reply({ pluginaction: 'driverInstallComplete', dispatchId: data.dispatchId, ok: false, error: 'download: ' + err.message });
            return;
        }
        reply({ pluginaction: 'driverInstallProgress', dispatchId: data.dispatchId, step: 'extract + install (peut prendre 5-15 min sur gros pack)' });
        runInstall(buildPsDriverInstall(zipPath, extractDir), [zipPath]);
    });
}

// Récupère les events Windows System+Application (Critical + Error) sur
// les derniers N jours, max ~500 events. Pour dépannage rapide : BSOD,
// erreurs disque, drivers en échec, services qui plantent.
function buildPsEventList(outPath, days, maxEvents) {
    var outE = outPath.replace(/'/g, "''");
    return ''
        + '$ErrorActionPreference = "SilentlyContinue";'
        + 'try {'
        + '  $start = (Get-Date).AddDays(-' + days + ');'
        + '  $evts = Get-WinEvent -FilterHashtable @{'
        + '    LogName = @("System","Application");'
        + '    Level = @(1,2,3);'  // Critical, Error, Warning (filtré côté serveur)
        + '    StartTime = $start;'
        + '  } -MaxEvents ' + maxEvents + ' -ErrorAction SilentlyContinue;'
        + '  $out = $evts | ForEach-Object {'
        + '    $msg = if ($_.Message) { ($_.Message -replace "\\s+"," ").Trim() } else { "" };'
        + '    if ($msg.Length -gt 400) { $msg = $msg.Substring(0,400) + "..." }'
        + '    [PSCustomObject]@{'
        + '      t = $_.TimeCreated.ToUniversalTime().ToString("o");'
        + '      l = [string]$_.LogName;'
        + '      lv = [int]$_.Level;'
        + '      src = [string]$_.ProviderName;'
        + '      id = [int]$_.Id;'
        + '      m = $msg;'
        + '    }'
        + '  };'
        + '  $json = $out | ConvertTo-Json -Compress;'
        + '  if ($null -eq $json) { $json = "[]" }'
        + '  $utf8NoBom = New-Object System.Text.UTF8Encoding($false);'
        + '  [System.IO.File]::WriteAllText(\'' + outE + '\', $json, $utf8NoBom);'
        + '  Write-Host "OK";'
        + '} catch { Write-Host ("ERR: " + $_.Exception.Message); exit 1 }';
}

function doEventList(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'eventListResult', dispatchId: data.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var fs = require('fs');
    var days = Math.max(1, Math.min(30, parseInt(data.days, 10) || 7));
    var maxEvents = Math.max(50, Math.min(2000, parseInt(data.maxEvents, 10) || 500));
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var outPath = tmpRoot + '\\maintctl_evt_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.json';
    var script = buildPsEventList(outPath, days, maxEvents);
    runPowerShell(script, 120 * 1000, function (ok, _bytes, log) {
        var raw = '';
        var err = '';
        try {
            if (fs.existsSync(outPath)) {
                raw = fs.readFileSync(outPath).toString();
                try { fs.unlinkSync(outPath); } catch (_) {}
            } else {
                err = 'fichier JSON pas généré (PS log: ' + (log || '').slice(-300).trim() + ')';
            }
        } catch (e) {
            err = 'lecture JSON: ' + e;
        }
        reply({
            pluginaction: 'eventListResult',
            dispatchId: data.dispatchId,
            ok: ok && !err,
            error: err || undefined,
            eventsJson: raw,
            logTail: (!ok || err) ? (log || '').slice(-1000) : ''
        });
    });
}

function doDevList(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'devListResult', dispatchId: data.dispatchId, ok: false, error: 'maintctl: Windows only' });
        return;
    }
    var fs = require('fs');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var outPath = tmpRoot + '\\maintctl_dev_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.json';
    var script = buildPsDevList(outPath);
    runPowerShell(script, 120 * 1000, function (ok, _bytes, log) {
        var raw = '';
        var err = '';
        try {
            if (fs.existsSync(outPath)) {
                raw = fs.readFileSync(outPath).toString();
                try { fs.unlinkSync(outPath); } catch (_) {}
            } else {
                err = 'fichier JSON pas généré (PS log: ' + (log || '').slice(-300).trim() + ')';
            }
        } catch (e) {
            err = 'lecture fichier JSON: ' + e;
        }
        reply({
            pluginaction: 'devListResult',
            dispatchId: data.dispatchId,
            ok: ok && !err,
            error: err || undefined,
            devicesJson: raw,
            logTail: (!ok || err) ? (log || '').slice(-1000) : ''
        });
    });
}

// ============================================================
// Registre (ex-regctl) — édition de registre Windows via PowerShell.
// Toutes les ops répondent { pluginaction:'regResult', dispatchId, ok, data|error }.
// ============================================================

function regPsWrap(body) {
    return [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'try {',
        body,
        '} catch {',
        '  $e = @{ __error = $_.Exception.Message } | ConvertTo-Json -Compress',
        '  Write-Output $e',
        '}'
    ].join('\r\n');
}

function regNormalizePath(p) {
    var map = {
        HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER',
        HKCR: 'HKEY_CLASSES_ROOT', HKU: 'HKEY_USERS', HKCC: 'HKEY_CURRENT_CONFIG',
    };
    var s = String(p).replace(/\//g, '\\');
    var m = s.match(/^([A-Z]+)(\\.*)?$/);
    if (m && map[m[1]]) s = map[m[1]] + (m[2] || '');
    return s;
}
function regPsPath(p) { return 'Registry::' + regNormalizePath(p); }

function regEscapePs(s) {
    return String(s).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
}

function regPsEnumValues(p) {
    return regPsWrap([
        '$p = "' + regEscapePs(regPsPath(p)) + '"',
        '$item = Get-Item -Path $p -ErrorAction Stop',
        '$valNames = $item.GetValueNames()',
        '$list = @()',
        'foreach ($n in $valNames) {',
        '  $kind = $item.GetValueKind($n).ToString()',
        '  $raw  = $item.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
        '  $data = $null',
        '  switch ($kind) {',
        '    "Binary"     { $data = ($raw | ForEach-Object { $_.ToString("X2") }) -join "" }',
        '    "DWord"      { $data = [string]$raw }',
        '    "QWord"      { $data = [string]$raw }',
        '    "MultiString"{ $data = @($raw) }',
        '    default      { $data = [string]$raw }',
        '  }',
        '  $list += @{ name = $n; type = $kind; data = $data }',
        '}',
        '$out = @{ values = $list } | ConvertTo-Json -Compress -Depth 6',
        'Write-Output $out',
    ].join('\r\n'));
}

function regPsReadValue(p, name) {
    return regPsWrap([
        '$p = "' + regEscapePs(regPsPath(p)) + '"',
        '$n = "' + regEscapePs(name) + '"',
        '$item = Get-Item -Path $p -ErrorAction Stop',
        '$kind = $item.GetValueKind($n).ToString()',
        '$raw  = $item.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
        'switch ($kind) {',
        '  "Binary"     { $d = ($raw | ForEach-Object { $_.ToString("X2") }) -join "" }',
        '  "DWord"      { $d = [string]$raw }',
        '  "QWord"      { $d = [string]$raw }',
        '  "MultiString"{ $d = @($raw) }',
        '  default      { $d = [string]$raw }',
        '}',
        '$out = @{ name = $n; type = $kind; data = $d } | ConvertTo-Json -Compress -Depth 6',
        'Write-Output $out',
    ].join('\r\n'));
}

function regPsWriteValue(p, name, type, data) {
    var body;
    var typeNorm = String(type || 'String');
    // Compat templates : REG_DWORD / REG_SZ / etc.
    var aliases = {
        REG_SZ: 'String', REG_EXPAND_SZ: 'ExpandString', REG_BINARY: 'Binary',
        REG_DWORD: 'DWord', REG_QWORD: 'QWord', REG_MULTI_SZ: 'MultiString',
    };
    if (aliases[typeNorm]) typeNorm = aliases[typeNorm];
    if (typeNorm === 'Binary') {
        body = [
            '$hex = "' + regEscapePs(String(data).replace(/[^0-9a-fA-F]/g, '')) + '"',
            '$bytes = New-Object byte[] ($hex.Length / 2)',
            'for ($i=0; $i -lt $hex.Length; $i += 2) { $bytes[$i/2] = [Convert]::ToByte($hex.Substring($i,2),16) }',
            'New-ItemProperty -Path $p -Name $n -PropertyType Binary -Value $bytes -Force | Out-Null',
        ].join('\r\n');
    } else if (typeNorm === 'DWord' || typeNorm === 'QWord') {
        body = 'New-ItemProperty -Path $p -Name $n -PropertyType ' + typeNorm + ' -Value ([Int64]"' + regEscapePs(String(data)) + '") -Force | Out-Null';
    } else if (typeNorm === 'MultiString') {
        var lines = Array.isArray(data) ? data : String(data).split(/\r?\n/);
        var quoted = lines.map(function (l) { return '"' + regEscapePs(l) + '"'; }).join(',');
        body = 'New-ItemProperty -Path $p -Name $n -PropertyType MultiString -Value @(' + quoted + ') -Force | Out-Null';
    } else {
        body = 'New-ItemProperty -Path $p -Name $n -PropertyType ' + typeNorm + ' -Value "' + regEscapePs(String(data)) + '" -Force | Out-Null';
    }
    return regPsWrap([
        '$p = "' + regEscapePs(regPsPath(p)) + '"',
        '$n = "' + regEscapePs(name) + '"',
        'if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }',
        body,
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}

function regPsDeleteValue(p, name) {
    return regPsWrap([
        '$p = "' + regEscapePs(regPsPath(p)) + '"',
        '$n = "' + regEscapePs(name) + '"',
        'Remove-ItemProperty -Path $p -Name $n -Force -ErrorAction Stop',
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}
function regPsDeleteKey(p) {
    return regPsWrap([
        '$p = "' + regEscapePs(regPsPath(p)) + '"',
        'Remove-Item -Path $p -Recurse -Force -ErrorAction Stop',
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}
function regPsCreateKey(p) {
    return regPsWrap([
        '$p = "' + regEscapePs(regPsPath(p)) + '"',
        'New-Item -Path $p -Force | Out-Null',
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}

// enumKeys via reg.exe (cold-start PS = 1-2s, reg.exe < 200ms).
function regRunEnumKeys(args) {
    var dispatchId = args.dispatchId;
    var cp = require('child_process');
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var cmdExe = windir + '\\System32\\cmd.exe';
    var rPath = regNormalizePath(args.path);
    var child;
    try {
        child = cp.execFile(cmdExe, ['/c', 'reg query "' + rPath.replace(/"/g, '\\"') + '"']);
    } catch (e) {
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'spawn reg: ' + e });
        return;
    }
    var stdout = '', stderr = '';
    try {
        if (child.stdout) child.stdout.on('data', function (c) { stdout += String(c); });
        if (child.stderr) child.stderr.on('data', function (c) { stderr += String(c); });
    } catch (e) {}
    var finished = false;
    child.on('exit', function (code) {
        if (finished) return; finished = true;
        var lines = stdout.split(/\r?\n/);
        var keys = [];
        var prefix = rPath;
        lines.forEach(function (l) {
            if (!l || l.charAt(0) === ' ' || l.charAt(0) === '\t') return;
            if (l.indexOf(prefix) === 0) {
                var rest = l.substring(prefix.length);
                if (rest.charAt(0) === '\\') rest = rest.substring(1);
                if (rest.length > 0) keys.push(rest);
            }
        });
        if (code !== 0 && keys.length === 0 && stderr) {
            reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: stderr.trim().slice(0, 300) });
            return;
        }
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: true, data: { keys: keys } });
    });
    setTimeout(function () {
        if (finished) return; finished = true;
        try { child.kill(); } catch (e) {}
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'reg timeout' });
    }, 15 * 1000);
}

function regRunPs(args, script) {
    var dispatchId = args.dispatchId;
    var cp = require('child_process');
    var fs = require('fs');
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var psExe = windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var tmpDir = process.env.TEMP || 'C:\\Windows\\Temp';
    var psPath = tmpDir + '\\maintctl_reg_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.ps1';
    try { fs.writeFileSync(psPath, script); }
    catch (e) {
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'write ps1: ' + e });
        return;
    }
    var psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath];
    var child;
    try { child = cp.execFile(psExe, psArgs); }
    catch (e) {
        try { fs.unlinkSync(psPath); } catch (e2) {}
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'spawn: ' + e });
        return;
    }
    var stdout = '', stderr = '';
    try {
        if (child.stdout) child.stdout.on('data', function (c) { stdout += String(c); });
        if (child.stderr) child.stderr.on('data', function (c) { stderr += String(c); });
    } catch (e) {}
    var finished = false;
    child.on('exit', function (code) {
        if (finished) return; finished = true;
        try { fs.unlinkSync(psPath); } catch (e) {}
        var line = stdout.trim();
        if (!line) {
            reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'aucune sortie' + (stderr ? ' (' + stderr.slice(0, 200) + ')' : '') + ' exit=' + code });
            return;
        }
        var lines = line.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
        var last = lines[lines.length - 1];
        var parsed = null;
        try { parsed = JSON.parse(last); }
        catch (e) {
            reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'JSON invalide: ' + last.slice(0, 200) });
            return;
        }
        if (parsed && parsed.__error) {
            reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: parsed.__error });
            return;
        }
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: true, data: parsed });
    });
    setTimeout(function () {
        if (finished) return; finished = true;
        try { child.kill(); } catch (e) {}
        try { fs.unlinkSync(psPath); } catch (e) {}
        reply({ pluginaction: 'regResult', dispatchId: dispatchId, ok: false, error: 'timeout' });
    }, 60 * 1000);
}

// ============================================================
// EXAM MODE — coupure internet par règles Windows Firewall
// ============================================================
//
// Stratégie :
//   - une règle "block outbound any" nommée MAINTCTL_EXAM_BLOCK_ALL
//   - des règles "allow outbound" MAINTCTL_EXAM_ALLOW_* (MC, DNS, LAN, custom)
//   - Windows Firewall : Allow l'emporte sur Block quand les deux matchent,
//     donc la whitelist passe et le reste est bloqué.
//   - une tâche planifiée MAINTCTL_EXAM_UNLOCK déclenche le déverrouillage
//     automatique au bout de durationMin (filet de sécurité si on oublie).
//
// IMPORTANT : on whitelist TOUJOURS les serveurs MeshCentral fournis par
// le serveur, sinon plus moyen de débloquer à distance.

function jsArrayToPsList(arr) {
    if (!arr || !arr.length) return '@()';
    var quoted = arr.map(function (x) { return "'" + String(x).replace(/'/g, "''") + "'"; });
    return '@(' + quoted.join(',') + ')';
}

function buildExamLockScript(args) {
    var mcHosts = Array.isArray(args.mcHosts) ? args.mcHosts : [];
    var customAllow = Array.isArray(args.customAllow) ? args.customAllow : [];
    var allowLan = !!args.allowLan;
    var allowDns = (args.allowDns !== false); // par défaut oui
    var durationMin = parseInt(args.durationMin, 10) || 120;

    return ''
        + '$ErrorActionPreference = "Continue";'
        + '$prefix = "MAINTCTL_EXAM_";'
        // Nettoyage tâche planifiée précédente (les règles seront purgées plus bas)
        + 'schtasks /Delete /TN "MAINTCTL_EXAM_UNLOCK" /F 2>$null | Out-Null;'
        + ''
        + '$allow = New-Object System.Collections.Generic.List[string];'
        // MC hosts (résolution DNS)
        + '$mcHosts = ' + jsArrayToPsList(mcHosts) + ';'
        + 'foreach ($h in $mcHosts) {'
        + '  try {'
        + '    if ($h -match "^[\\d\\.]+$") { $allow.Add($h) }'
        + '    else {'
        + '      $ips = Resolve-DnsName -Name $h -Type A -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress} | Select-Object -ExpandProperty IPAddress;'
        + '      foreach ($ip in $ips) { $allow.Add($ip) }'
        + '    }'
        + '  } catch {}'
        + '}'
        // DNS locaux
        + (allowDns
            ? '$dns = Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -and $_ -ne "127.0.0.1" } | Sort-Object -Unique;'
            + 'foreach ($d in $dns) { $allow.Add($d) }'
            : '')
        // LAN local : on calcule le subnet CIDR
        + (allowLan
            ? '$nets = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne "WellKnown" -and $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" };'
            + 'foreach ($n in $nets) {'
            + '  $ipBytes = [System.Net.IPAddress]::Parse($n.IPAddress).GetAddressBytes();'
            + '  $mask = [uint32]0xFFFFFFFF -shl (32 - $n.PrefixLength);'
            + '  $maskBytes = @( ($mask -shr 24) -band 0xFF, ($mask -shr 16) -band 0xFF, ($mask -shr 8) -band 0xFF, $mask -band 0xFF );'
            + '  $netBytes = @(); for ($i=0; $i -lt 4; $i++) { $netBytes += ($ipBytes[$i] -band $maskBytes[$i]) }'
            + '  $cidr = ($netBytes -join ".") + "/" + $n.PrefixLength;'
            + '  $allow.Add($cidr)'
            + '}'
            : '')
        // Custom (IP, CIDR, hostnames)
        + '$custom = ' + jsArrayToPsList(customAllow) + ';'
        + 'foreach ($c in $custom) {'
        + '  if ($c -match "^[\\d\\.]+(/\\d+)?$") { $allow.Add($c) }'
        + '  else {'
        + '    try {'
        + '      $ips = Resolve-DnsName -Name $c -Type A -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress} | Select-Object -ExpandProperty IPAddress;'
        + '      foreach ($ip in $ips) { $allow.Add($ip) }'
        + '    } catch {}'
        + '  }'
        + '}'
        + '$allowUnique = $allow | Sort-Object -Unique;'
        // On utilise netsh (instantané) au lieu de New-NetFirewallRule (charge le module NetSecurity, 10-30s).
        // Nettoyage préventif (silencieux si la règle n'existe pas)
        + '1..50 | ForEach-Object { & netsh advfirewall firewall delete rule name=($prefix + "ALLOW_" + $_) 2>$null | Out-Null };'
        + '& netsh advfirewall firewall delete rule name=($prefix + "ALLOW_LOOPBACK") 2>$null | Out-Null;'
        + '& netsh advfirewall firewall delete rule name=($prefix + "BLOCK_ALL") 2>$null | Out-Null;'
        // Crée allow rules
        + '$i = 0;'
        + 'foreach ($a in $allowUnique) {'
        + '  $i++;'
        + '  $n = $prefix + "ALLOW_" + $i;'
        + '  & netsh advfirewall firewall add rule name="$n" dir=out action=allow remoteip="$a" profile=any | Out-Null'
        + '}'
        // Allow loopback explicitement
        + '& netsh advfirewall firewall add rule name=($prefix + "ALLOW_LOOPBACK") dir=out action=allow remoteip=127.0.0.0/8 profile=any | Out-Null;'
        // Bloc all outbound
        + '& netsh advfirewall firewall add rule name=($prefix + "BLOCK_ALL") dir=out action=block remoteip=any profile=any | Out-Null;'
        // Tâche planifiée auto-unlock
        + '$dur = ' + durationMin + ';'
        + '$at = (Get-Date).AddMinutes($dur);'
        + '$atStr = $at.ToString("HH:mm");'
        + '$atDate = $at.ToString("dd/MM/yyyy");'
        + '$cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \\"$p=\'MAINTCTL_EXAM_\'; 1..50 | ForEach-Object { & netsh advfirewall firewall delete rule name=($p + \'ALLOW_\' + $_) | Out-Null }; & netsh advfirewall firewall delete rule name=($p + \'ALLOW_LOOPBACK\') | Out-Null; & netsh advfirewall firewall delete rule name=($p + \'BLOCK_ALL\') | Out-Null; schtasks /Delete /TN MAINTCTL_EXAM_UNLOCK /F\\"";'
        + 'schtasks /Create /TN "MAINTCTL_EXAM_UNLOCK" /TR $cmd /SC ONCE /ST $atStr /SD $atDate /RU SYSTEM /F 2>$null | Out-Null;'
        // Sortie
        + '$count = ($allowUnique | Measure-Object).Count;'
        + 'Write-Host ("RESULT:" + $count + ":locked until " + $at.ToString("yyyy-MM-ddTHH:mm:ss"))';
}

function doExamLock(args) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'examLockResult', dispatchId: args.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var script = buildExamLockScript(args);
    runPowerShell(script, 60 * 1000, function (ok, bytes, log, note) {
        var until = null;
        var m = note && note.match(/locked until (.+)/);
        if (m) until = m[1];
        reply({
            pluginaction: 'examLockResult',
            dispatchId: args.dispatchId,
            ok: ok,
            allowCount: bytes,
            until: until,
            log: (log || '').slice(-2000),
        });
    });
}

function doExamUnlock(args) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'examUnlockResult', dispatchId: args.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var script = ''
        + '$ErrorActionPreference = "Continue";'
        + '$prefix = "MAINTCTL_EXAM_";'
        + '1..50 | ForEach-Object { & netsh advfirewall firewall delete rule name=($prefix + "ALLOW_" + $_) 2>$null | Out-Null };'
        + '& netsh advfirewall firewall delete rule name=($prefix + "ALLOW_LOOPBACK") 2>$null | Out-Null;'
        + '& netsh advfirewall firewall delete rule name=($prefix + "BLOCK_ALL") 2>$null | Out-Null;'
        + 'schtasks /Delete /TN "MAINTCTL_EXAM_UNLOCK" /F 2>$null | Out-Null;'
        + 'Write-Host "RESULT:0:unlocked"';
    runPowerShell(script, 30 * 1000, function (ok, bytes, log, note) {
        reply({
            pluginaction: 'examUnlockResult',
            dispatchId: args.dispatchId,
            ok: ok,
            log: (log || '').slice(-1000),
        });
    });
}

function doExamStatus(args) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'examStatusResult', dispatchId: args.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var script = ''
        + '$ErrorActionPreference = "Continue";'
        + '$out = & netsh advfirewall firewall show rule name=all 2>$null;'
        + '$count = ($out | Select-String "MAINTCTL_EXAM_").Count;'
        + '$until = "";'
        + 'try {'
        + '  $t = schtasks /Query /TN "MAINTCTL_EXAM_UNLOCK" /FO CSV /V 2>$null | ConvertFrom-Csv | Select-Object -First 1;'
        + '  if ($t) { $until = $t."Next Run Time" }'
        + '} catch {}'
        + 'Write-Host ("RESULT:" + $count + ":" + $until)';
    runPowerShell(script, 15 * 1000, function (ok, bytes, log, note) {
        reply({
            pluginaction: 'examStatusResult',
            dispatchId: args.dispatchId,
            ok: ok,
            locked: bytes > 0,
            ruleCount: bytes,
            until: note || '',
        });
    });
}

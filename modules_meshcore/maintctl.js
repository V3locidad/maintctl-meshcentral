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
var duplicateWatcher = null;
var duplicateWatcherEnabled = false;
var duplicateWatcherRestartTimer = null;
var duplicateWatcherBuffer = '';
var duplicateWatcherGeneration = 0;
var maintctlTempCleanupAt = 0;

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

function cleanupMaintctlTempArtifacts(force) {
    if (process.platform !== 'win32') return 0;
    var now = Date.now();
    // Une seule analyse toutes les dix minutes suffit. Le premier appel après
    // le chargement du module est toujours exécuté.
    if (!force && maintctlTempCleanupAt && (now - maintctlTempCleanupAt) < 10 * 60 * 1000) return 0;
    maintctlTempCleanupAt = now;

    var fs = require('fs');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var removed = 0;
    var staleAfterMs = 60 * 60 * 1000;
    var names;
    try { names = fs.readdirSync(tmpRoot); }
    catch (e) { dbg('temp cleanup listing: ' + e); return 0; }

    for (var i = 0; i < names.length; i++) {
        var name = String(names[i] || '');
        // Correspond uniquement aux artefacts temporaires propres au plugin.
        // maintctl-agent.log et maintctl-logon-watch.ps1 sont volontairement
        // exclus : le premier est rotatif, le second alimente le watcher actif.
        var match = name.match(/^maintctl_(?:guard_|delprof_|dd_|evt_|dev_|reg_|drv_)?(\d{12,})(?:_\d+)?\.(?:ps1|txt|json|zip)$/i);
        var fixed = /^maintctl_delprof_(?:out|err)\.txt$/i.test(name);
        if (!match && !fixed) continue;

        var full = tmpRoot + '\\' + name;
        var fileTime = match ? (parseInt(match[1], 10) || 0) : 0;
        try {
            var stat = fs.statSync(full);
            if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) continue;
            if (!fileTime && stat) {
                if (typeof stat.mtimeMs === 'number') fileTime = stat.mtimeMs;
                else if (stat.mtime && typeof stat.mtime.getTime === 'function') fileTime = stat.mtime.getTime();
                else if (stat.mtime) fileTime = new Date(stat.mtime).getTime();
            }
            if (!fileTime || (now - fileTime) < staleAfterMs) continue;
            fs.unlinkSync(full);
            removed++;
        } catch (e2) {
            // Un fichier encore utilisé est simplement conservé pour le
            // prochain passage ; aucune autre donnée du dossier n'est touchée.
        }
    }
    if (removed > 0) dbg('temp cleanup: ' + removed + ' artefact(s) maintctl supprimé(s)');
    return removed;
}

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    cleanupMaintctlTempArtifacts(false);
    var fnname = args.pluginaction || (args._ && args._[1]);
    dbg('consoleaction: fnname=' + fnname + ', dispatchId=' + (args && args.dispatchId));
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
            case 'duplicateSessionWatchStart': startDuplicateSessionWatcher(args); return 'duplicateSessionWatchStart started';
            case 'duplicateSessionWatchStop':  stopDuplicateSessionWatcher(args, true); return 'duplicateSessionWatchStop done';
            case 'duplicateSessionGuard':  doDuplicateSessionGuard(args); return 'duplicateSessionGuard started';
            case 'duplicateSessionLogoff': doDuplicateSessionLogoff(args); return 'duplicateSessionLogoff started';
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

function runPowerShell(script, timeoutMs, onDone, resultFile) {
    var fs = require('fs');
    var cp = require('child_process');
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var ps1 = tmpRoot + '\\maintctl_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.ps1';
    var log = '';
    var done = false;
    var bytes = 0;
    var note = '';
    var resultPollTimer = null;

    function parseResultText(text) {
        var found = false;
        var resultRe = /(?:^|\r?\n)RESULT:(\d+):([^\r\n]*)/g;
        var resultMatch;
        while ((resultMatch = resultRe.exec(String(text || ''))) !== null) {
            bytes = parseInt(resultMatch[1], 10) || 0;
            note = resultMatch[2] || '';
            found = true;
        }
        return found;
    }

    if (resultFile) { try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch (_) {} }

    try { fs.writeFileSync(ps1, script); }
    catch (e) { onDone(false, 0, '', 'write ps1 failed: ' + e); return; }

    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var child;
    try {
        child = cp.execFile(psExe, [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive',
            '-File', ps1
        ]);
    } catch (e) {
        try { fs.unlinkSync(ps1); } catch (_) {}
        onDone(false, 0, '', 'spawn failed: ' + e);
        return;
    }

    if (child.stdout) {
        child.stdout.on('data', function (d) {
            var s = d.toString();
            log += s;
            parseResultText(s);
        });
    }
    if (child.stderr) {
        child.stderr.on('data', function (d) { log += d.toString(); });
    }

    function finish(ok, err) {
        if (done) return;
        done = true;
        // Une ligne stdout peut être coupée entre deux événements 'data'.
        // Refaire le parsing sur le journal complet évite de perdre IDYES (6)
        // et de traiter par erreur le choix « Oui » comme un refus.
        parseResultText(log);
        if (resultPollTimer) { try { clearInterval(resultPollTimer); } catch (_) {} }
        try { fs.unlinkSync(ps1); } catch (_) {}
        if (resultFile) { try { fs.unlinkSync(resultFile); } catch (_) {} }
        onDone(ok, bytes, log, note || (err || ''));
    }

    child.on('exit', function () { finish(true, ''); });
    child.on('error', function (e) { finish(false, 'process error: ' + e); });

    // MeshAgent/Duktape ne remonte pas toujours immédiatement l'événement
    // 'exit' d'un PowerShell resté longtemps bloqué dans WTSSendMessage.
    // Le dialogue écrit donc aussi sa décision dans un fichier ASCII ; sa
    // présence déclenche la réponse au serveur sans dépendre de stdout/exit.
    if (resultFile) {
        resultPollTimer = setInterval(function () {
            if (done) return;
            try {
                if (!fs.existsSync(resultFile)) return;
                var resultText = fs.readFileSync(resultFile).toString();
                if (parseResultText(resultText)) finish(true, '');
            } catch (e) { dbg('runPowerShell result file: ' + e); }
        }, 250);
    }

    setTimeout(function () {
        if (done) return;
        try { child.kill(); } catch (_) {}
        finish(false, 'timeout');
    }, timeoutMs);
}

// --- Détection temps réel des ouvertures/fermetures de session Windows ---

function buildDuplicateWatcherScript() {
    // EventLogWatcher pousse les nouveaux événements Security sans polling.
    // Le filtre ne conserve que les sessions interactives ; les logons réseau,
    // services et tâches planifiées ne doivent jamais déclencher un blocage.
    return [
        '$ErrorActionPreference = "Stop"',
        '$queryText = "*[System[(EventID=4624 or EventID=4634)]]"',
        '$query = New-Object System.Diagnostics.Eventing.Reader.EventLogQuery("Security", [System.Diagnostics.Eventing.Reader.PathType]::LogName, $queryText)',
        '$watcher = New-Object System.Diagnostics.Eventing.Reader.EventLogWatcher($query)',
        '$handler = {',
        '  param($sender, $eventArgs)',
        '  $record = $null',
        '  try {',
        '    if ($eventArgs.EventException) { throw $eventArgs.EventException }',
        '    $record = $eventArgs.EventRecord',
        '    if ($null -eq $record) { return }',
        '    [xml]$xml = $record.ToXml()',
        '    $fields = @{}',
        '    foreach ($item in $xml.Event.EventData.Data) {',
        '      $name = [string]$item.Name',
        '      if ($name) { $fields[$name] = [string]$item."#text" }',
        '    }',
        '    $eventId = [int]$record.Id',
        '    $logonType = 0',
        '    [void][int]::TryParse([string]$fields["LogonType"], [ref]$logonType)',
        '    if (@(2, 10, 11, 12) -notcontains $logonType) { return }',
        '    $payload = [ordered]@{',
        '      eventId = $eventId',
        '      logonType = $logonType',
        '      username = [string]$fields["TargetUserName"]',
        '      domain = [string]$fields["TargetDomainName"]',
        '      logonId = [string]$fields["TargetLogonId"]',
        '      recordId = [long]$record.RecordId',
        '      time = $record.TimeCreated.ToUniversalTime().ToString("o")',
        '    }',
        '    $json = $payload | ConvertTo-Json -Compress',
        '    [Console]::Out.WriteLine("MAINTCTL_EVENT:" + $json)',
        '    [Console]::Out.Flush()',
        '  } catch {',
        '    [Console]::Error.WriteLine("maintctl watcher event: " + $_.Exception.Message)',
        '  } finally {',
        '    if ($null -ne $record) { $record.Dispose() }',
        '  }',
        '}',
        '$subscription = Register-ObjectEvent -InputObject $watcher -EventName EventRecordWritten -Action $handler',
        '$watcher.Enabled = $true',
        '[Console]::Out.WriteLine("MAINTCTL_READY")',
        '[Console]::Out.Flush()',
        'try { while ($true) { Start-Sleep -Seconds 3600 } } finally {',
        '  $watcher.Enabled = $false',
        '  Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue',
        '  $watcher.Dispose()',
        '}',
    ].join('\r\n');
}

function duplicateAllLocalUsers() {
    var out = [];
    var seen = {};
    try {
        var sessions = require('kvm-helper').users();
        for (var key in sessions) {
            var session = sessions[key];
            if (!session || session.SessionId == null || !session.Username) continue;
            var account = (session.Domain ? session.Domain + '\\' : '') + session.Username;
            var userKey = duplicateUserKey(account);
            if (!userKey || userKey.charAt(userKey.length - 1) === '$' || seen[userKey]) continue;
            seen[userKey] = true;
            out.push(account);
        }
    } catch (e) { dbg('duplicateAllLocalUsers: ' + e); }
    return out;
}

function sendDuplicateSessionSnapshot(delay) {
    setTimeout(function () {
        reply({
            pluginaction: 'duplicateSessionSnapshot',
            users: duplicateAllLocalUsers(),
            time: Date.now(),
        });
    }, Math.max(0, parseInt(delay, 10) || 0));
}

function handleDuplicateWatcherLine(line) {
    line = String(line || '').trim();
    if (!line) return;
    if (line === 'MAINTCTL_READY') {
        reply({ pluginaction: 'duplicateSessionWatchStatus', ok: true, running: true });
        sendDuplicateSessionSnapshot(0);
        return;
    }
    if (line.indexOf('MAINTCTL_EVENT:') !== 0) return;
    try {
        var event = JSON.parse(line.substring('MAINTCTL_EVENT:'.length));
        reply({
            pluginaction: 'duplicateSessionEvent',
            eventId: parseInt(event.eventId, 10) || 0,
            logonType: parseInt(event.logonType, 10) || 0,
            username: String(event.username || ''),
            domain: String(event.domain || ''),
            logonId: String(event.logonId || ''),
            recordId: String(event.recordId || ''),
            eventTime: String(event.time || ''),
        });
        // Après un logoff, le snapshot retire rapidement la réservation.
        // Après un logon, il confirme l'inventaire remonté immédiatement.
        sendDuplicateSessionSnapshot((parseInt(event.eventId, 10) === 4634) ? 750 : 1500);
    } catch (e) { dbg('duplicate watcher JSON: ' + e + ' line=' + line.slice(0, 500)); }
}

function spawnDuplicateSessionWatcher() {
    if (!duplicateWatcherEnabled || duplicateWatcher || process.platform !== 'win32') return;
    var fs = require('fs');
    var cp = require('child_process');
    var psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var ps1 = (process.env.SystemRoot || 'C:\\Windows') + '\\Temp\\maintctl-logon-watch.ps1';
    var generation = ++duplicateWatcherGeneration;
    duplicateWatcherBuffer = '';
    try { fs.writeFileSync(ps1, buildDuplicateWatcherScript()); }
    catch (e) {
        dbg('duplicate watcher write: ' + e);
        reply({ pluginaction: 'duplicateSessionWatchStatus', ok: false, running: false, error: 'écriture watcher: ' + String(e) });
        return;
    }
    try {
        duplicateWatcher = cp.execFile(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', ps1]);
    } catch (e2) {
        duplicateWatcher = null;
        dbg('duplicate watcher spawn: ' + e2);
        reply({ pluginaction: 'duplicateSessionWatchStatus', ok: false, running: false, error: 'démarrage watcher: ' + String(e2) });
        return;
    }
    if (duplicateWatcher.stdout) {
        duplicateWatcher.stdout.on('data', function (data) {
            duplicateWatcherBuffer += data.toString();
            if (duplicateWatcherBuffer.length > 65536) duplicateWatcherBuffer = duplicateWatcherBuffer.slice(-32768);
            var parts = duplicateWatcherBuffer.split(/\r?\n/);
            duplicateWatcherBuffer = parts.pop();
            for (var i = 0; i < parts.length; i++) handleDuplicateWatcherLine(parts[i]);
        });
    }
    if (duplicateWatcher.stderr) {
        duplicateWatcher.stderr.on('data', function (data) { dbg('duplicate watcher stderr: ' + data.toString().slice(-2000)); });
    }
    duplicateWatcher.on('exit', function () {
        if (generation !== duplicateWatcherGeneration) return;
        duplicateWatcher = null;
        reply({ pluginaction: 'duplicateSessionWatchStatus', ok: false, running: false, error: 'surveillance du journal arrêtée' });
        if (duplicateWatcherEnabled) {
            duplicateWatcherRestartTimer = setTimeout(function () {
                duplicateWatcherRestartTimer = null;
                spawnDuplicateSessionWatcher();
            }, 10000);
        }
    });
}

function startDuplicateSessionWatcher(args) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'duplicateSessionWatchStatus', dispatchId: args && args.dispatchId, ok: false, running: false, error: 'Windows only' });
        return;
    }
    duplicateWatcherEnabled = true;
    if (duplicateWatcherRestartTimer) {
        try { clearTimeout(duplicateWatcherRestartTimer); } catch (_) {}
        duplicateWatcherRestartTimer = null;
    }
    if (duplicateWatcher) {
        reply({ pluginaction: 'duplicateSessionWatchStatus', dispatchId: args && args.dispatchId, ok: true, running: true });
        sendDuplicateSessionSnapshot(0);
        return;
    }
    spawnDuplicateSessionWatcher();
}

function stopDuplicateSessionWatcher(args, notify) {
    duplicateWatcherEnabled = false;
    duplicateWatcherGeneration++;
    if (duplicateWatcherRestartTimer) {
        try { clearTimeout(duplicateWatcherRestartTimer); } catch (_) {}
        duplicateWatcherRestartTimer = null;
    }
    var child = duplicateWatcher;
    duplicateWatcher = null;
    if (child) { try { child.kill(); } catch (_) {} }
    if (notify) {
        reply({ pluginaction: 'duplicateSessionWatchStatus', dispatchId: args && args.dispatchId, ok: true, running: false });
    }
}

// --- Protection contre les connexions simultanées sur plusieurs postes ---

function duplicateUserKey(value) {
    var text = String(value || '').trim().toLowerCase();
    var slash = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    if (slash >= 0) text = text.substring(slash + 1);
    var at = text.indexOf('@');
    if (at > 0) text = text.substring(0, at);
    return text;
}

function duplicateLocalSessions(username) {
    var wanted = duplicateUserKey(username);
    var out = [];
    try {
        var sessions = require('kvm-helper').users();
        for (var key in sessions) {
            var session = sessions[key];
            if (!session || session.SessionId == null || !session.Username) continue;
            var account = (session.Domain ? session.Domain + '\\' : '') + session.Username;
            if (duplicateUserKey(account) !== wanted) continue;
            out.push({
                id: parseInt(session.SessionId, 10),
                state: String(session.State || '').toLowerCase(),
            });
        }
    } catch (e) { dbg('duplicateLocalSessions: ' + e); }
    out = out.filter(function (session) { return !isNaN(session.id); });
    out.sort(function (a, b) {
        var aa = (a.state === 'active' || a.state === 'connected') ? 0 : 1;
        var bb = (b.state === 'active' || b.state === 'connected') ? 0 : 1;
        return aa - bb;
    });
    return out;
}

function waitDuplicateSessions(username, attempts, callback, intervalMs, requireReady) {
    var sessions = duplicateLocalSessions(username);
    var ready = sessions.filter(function (session) {
        return session.state === 'active' || session.state === 'connected';
    });
    if ((sessions.length && (!requireReady || ready.length)) || attempts <= 0) {
        return callback(ready.length ? ready : sessions);
    }
    setTimeout(function () { waitDuplicateSessions(username, attempts - 1, callback, intervalMs, requireReady); }, intervalMs || 500);
}

function duplicatePsLiteral(value) {
    return "'" + String(value || '').replace(/[\r\n\u0000-\u001f]/g, ' ').replace(/'/g, "''") + "'";
}

function duplicateUtf8Base64(value) {
    var input = String(value || '');
    var bytes = [];
    for (var i = 0; i < input.length; i++) {
        var code = input.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < input.length) {
            var low = input.charCodeAt(i + 1);
            if (low >= 0xDC00 && low <= 0xDFFF) {
                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                i++;
            }
        }
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) {
            bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        } else {
            bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
    }
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var p = 0; p < bytes.length; p += 3) {
        var b1 = bytes[p];
        var has2 = p + 1 < bytes.length;
        var has3 = p + 2 < bytes.length;
        var b2 = has2 ? bytes[p + 1] : 0;
        var b3 = has3 ? bytes[p + 2] : 0;
        out += alphabet.charAt(b1 >> 2);
        out += alphabet.charAt(((b1 & 3) << 4) | (b2 >> 4));
        out += has2 ? alphabet.charAt(((b2 & 15) << 2) | (b3 >> 6)) : '=';
        out += has3 ? alphabet.charAt(b3 & 63) : '=';
    }
    return out;
}

function duplicatePsUtf8(value) {
    // L'expression PowerShell reste 100 % ASCII. Les accents sont reconstruits
    // au runtime et ne dépendent donc ni de la page de codes ni du BOM pris en
    // charge par l'implémentation fs embarquée dans MeshAgent.
    return '[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' + duplicatePsLiteral(duplicateUtf8Base64(value)) + '))';
}

function duplicateWtsType(includeLogoff) {
    return ''
        + '$source = @"\r\n'
        + 'using System;\r\n'
        + 'using System.Runtime.InteropServices;\r\n'
        + 'public static class MaintctlWts {\r\n'
        + '  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]\r\n'
        + '  public static extern bool WTSSendMessageW(IntPtr server, int sessionId, string title, int titleBytes, string message, int messageBytes, int style, int timeout, out int response, bool wait);\r\n'
        + (includeLogoff
            ? '  [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSLogoffSession(IntPtr server, int sessionId, bool wait);\r\n'
            : '')
        + '}\r\n'
        + '"@\r\n'
        + 'Add-Type -TypeDefinition $source -ErrorAction Stop;';
}

function buildDuplicateGuardScript(sessionId, title, message, yesNo, timeoutSeconds, resultFile) {
    var style = (yesNo ? 4 : 0) + 48 + 65536 + 262144; // Yes/No ou OK, warning, foreground, topmost
    return ''
        + '$ErrorActionPreference = "Stop";'
        + duplicateWtsType(false)
        + '$title = ' + duplicatePsUtf8(title) + ';'
        + '$message = ' + duplicatePsUtf8(message) + ';'
        + '$response = 0;'
        + '$ok = [MaintctlWts]::WTSSendMessageW([IntPtr]::Zero,' + parseInt(sessionId, 10) + ',$title,[Text.Encoding]::Unicode.GetByteCount($title),$message,[Text.Encoding]::Unicode.GetByteCount($message),' + style + ',' + parseInt(timeoutSeconds, 10) + ',[ref]$response,$true);'
        + '$closed = 0;'
        + '$resultLine = "RESULT:" + $response + ":closed=" + $closed + ";prompt=" + $(if ($ok) { "ok" } else { "failed" });'
        + (resultFile
            ? '[IO.File]::WriteAllText(' + duplicatePsLiteral(resultFile) + ',$resultLine,[Text.Encoding]::ASCII);'
            : '')
        + 'Write-Host $resultLine;';
}

function runDuplicateSessionDialog(sessionId, title, message, yesNo, timeoutSeconds, onDone) {
    var done = false;
    var safetyTimer = null;

    function finish(ok, response, note) {
        if (done) return;
        done = true;
        if (safetyTimer) { try { clearTimeout(safetyTimer); } catch (_) {} }
        onDone(ok, response || 0, note || '');
    }

    try {
        // Le module natif de MeshAgent crée la fenêtre dans la session Windows
        // désignée (child-container avec uid=sessionId). Contrairement à un
        // PowerShell lancé par le service, la boîte appartient donc réellement
        // au bureau interactif de l'utilisateur.
        var dialog = require('message-box').create(
            title,
            message,
            timeoutSeconds,
            yesNo ? null : 1,
            parseInt(sessionId, 10)
        );
        if (!dialog || typeof dialog.then !== 'function') {
            throw new Error('message-box.create n\'a pas retourné de promesse');
        }

        dialog.then(function () {
            // message-box résout la promesse pour Oui (IDYES=6) ou OK (IDOK=1).
            finish(true, yesNo ? 6 : 1, 'dialogue MeshAgent affiché');
        }, function (reason) {
            var response = parseInt(reason, 10);
            // Pour une boîte Oui/Non, le module rejette volontairement avec
            // IDNO=7. Ce n'est pas une erreur d'affichage mais le choix Non.
            if (yesNo && response === 7) {
                finish(true, 7, 'dialogue MeshAgent affiché');
                return;
            }
            finish(false, 0, 'dialogue MeshAgent: ' + String(reason || 'échec inconnu'));
        });

        // Le délai interne commence lorsque le child-container est prêt. Ce
        // filet couvre aussi un enfant qui ne parviendrait jamais à cet état.
        safetyTimer = setTimeout(function () {
            try { if (dialog && typeof dialog.close === 'function') dialog.close(); } catch (_) {}
            finish(false, 0, 'dialogue MeshAgent: délai dépassé');
        }, (timeoutSeconds + 15) * 1000);
    } catch (e) {
        finish(false, 0, 'dialogue MeshAgent: ' + e);
    }
}

function doDuplicateSessionGuard(args) {
    dbg('duplicateSessionGuard: mode=' + String(args && args.mode) + ', user=' + String(args && args.username) + ', dispatchId=' + String(args && args.dispatchId));
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'duplicateSessionGuardResult', dispatchId: args.dispatchId, ok: false, error: 'Windows only', decision: 'deny' });
        return;
    }
    // L'événement 4624 arrive avant que le bureau WTS soit toujours prêt à
    // recevoir WTSSendMessage. Attendre l'état Active/Connected évite que le
    // dialogue soit envoyé trop tôt et disparaisse sans jamais être affiché.
    waitDuplicateSessions(args.username, 80, function (sessions) {
        if (!sessions.length) {
            reply({ pluginaction: 'duplicateSessionGuardResult', dispatchId: args.dispatchId, ok: false, error: 'session Windows introuvable', decision: 'deny' });
            return;
        }
        var locations = Array.isArray(args.locations) ? args.locations : [];
        var where = locations.length ? locations.join(' ; ') : 'un autre poste';
        var promptMode = args.mode === 'prompt';
        var message = promptMode
            ? 'Le compte ' + args.username + ' est d\u00e9j\u00e0 connect\u00e9 sur :\r\n\r\n' + where + '\r\n\r\nSouhaitez-vous fermer la session distante et continuer sur ce poste ?\r\n\r\nOui : fermer la session distante\r\nNon : annuler cette nouvelle connexion'
            : 'Connexion refus\u00e9e.\r\n\r\nLe compte ' + args.username + ' est d\u00e9j\u00e0 connect\u00e9 sur :\r\n\r\n' + where + '\r\n\r\nCette nouvelle session va \u00eatre ferm\u00e9e.';
        var timeout = promptMode
            ? Math.max(15, Math.min(120, parseInt(args.promptTimeoutSeconds, 10) || 45))
            : 5;
        runDuplicateSessionDialog(sessions[0].id, 'Connexion d\u00e9j\u00e0 ouverte', message, promptMode, timeout, function (ok, response, note) {
            dbg('duplicateSessionGuard result: ok=' + ok + ', response=' + response + ', note=' + note);
            var promptSucceeded = !!ok;
            var accepted = promptMode && promptSucceeded && response === 6; // IDYES
            if (accepted) {
                reply({
                    pluginaction: 'duplicateSessionGuardResult',
                    dispatchId: args.dispatchId,
                    ok: true,
                    decision: 'replace',
                    response: response || 0,
                    localClosed: false,
                    logTail: note || '',
                });
                return;
            }
            reply({
                pluginaction: 'duplicateSessionGuardResult',
                dispatchId: args.dispatchId,
                ok: promptSucceeded,
                decision: 'deny',
                response: response || 0,
                localClosed: false,
                closed: 0,
                error: promptSucceeded ? null : (note || 'dialogue Windows impossible'),
                logTail: note || '',
            });
        });
    }, 250, true);
}

function buildDuplicateLogoffScript(sessionIds, title, message, warningSeconds) {
    var ids = sessionIds.map(function (id) { return parseInt(id, 10); }).filter(function (id) { return !isNaN(id); });
    return ''
        + '$ErrorActionPreference = "Stop";'
        + duplicateWtsType(true)
        + '$title = ' + duplicatePsUtf8(title) + ';'
        + '$message = ' + duplicatePsUtf8(message) + ';'
        + '$closed = 0;'
        + '$ids = @(' + ids.join(',') + ');'
        + 'foreach ($id in $ids) {'
        + (warningSeconds > 0
            ? '  $response = 0; [void][MaintctlWts]::WTSSendMessageW([IntPtr]::Zero,$id,$title,[Text.Encoding]::Unicode.GetByteCount($title),$message,[Text.Encoding]::Unicode.GetByteCount($message),327728,' + parseInt(warningSeconds, 10) + ',[ref]$response,$true);'
            : '')
        + '  $wtsDone = [MaintctlWts]::WTSLogoffSession([IntPtr]::Zero,$id,$true);'
        + '  $logoffExe = Join-Path $env:SystemRoot "System32\\logoff.exe";'
        + '  & $logoffExe $id 2>$null;'
        + '  $cliDone = ($LASTEXITCODE -eq 0);'
        + '  $resetDone = $false;'
        + '  if (-not ($wtsDone -or $cliDone)) {'
        + '    $resetExe = Join-Path $env:SystemRoot "System32\\rwinsta.exe";'
        + '    & $resetExe $id 2>$null;'
        + '    $resetDone = ($LASTEXITCODE -eq 0);'
        + '  }'
        + '  $done = $wtsDone -or $cliDone -or $resetDone;'
        + '  if ($done) { $closed++ }'
        + '}'
        + 'Write-Host ("RESULT:" + $closed + ":logoff");';
}

function executeDuplicateLogoff(sessions, message, warning, callback) {
    var script = buildDuplicateLogoffScript(
        sessions.map(function (session) { return session.id; }),
        'Fermeture de session',
        message || 'Cette session Windows va être fermée.',
        warning
    );
    runPowerShell(script, (30 + warning * sessions.length) * 1000, function (ok, closed, log, note) {
        callback(!!(ok && closed > 0), closed || 0, log || '', closed > 0 ? null : (note || 'WTSLogoffSession et logoff.exe ont échoué'));
    });
}

function doDuplicateSessionLogoff(args) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'duplicateSessionLogoffResult', dispatchId: args.dispatchId, ok: false, error: 'Windows only', closed: 0 });
        return;
    }
    waitDuplicateSessions(args.username, args.immediate ? 50 : 6, function (sessions) {
        if (!sessions.length) {
            reply({ pluginaction: 'duplicateSessionLogoffResult', dispatchId: args.dispatchId, ok: false, error: 'session Windows introuvable', closed: 0 });
            return;
        }
        var warning = Math.max(0, Math.min(30, parseInt(args.warningSeconds, 10) || 0));
        executeDuplicateLogoff(sessions, args.message || 'Cette session Windows va être fermée.', warning, function (ok, closed, log, error) {
            reply({
                pluginaction: 'duplicateSessionLogoffResult',
                dispatchId: args.dispatchId,
                ok: ok,
                closed: closed || 0,
                error: error,
                logTail: (log || '').slice(-1000),
            });
        });
    }, args.immediate ? 100 : 500);
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
    dbg('examLock: entered (dispatchId=' + (args && args.dispatchId) + ', platform=' + process.platform + ')');
    if (process.platform !== 'win32') {
        dbg('examLock: not windows, replying error');
        reply({ pluginaction: 'examLockResult', dispatchId: args.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var script;
    try { script = buildExamLockScript(args); }
    catch (e) {
        dbg('examLock: buildExamLockScript threw: ' + e);
        reply({ pluginaction: 'examLockResult', dispatchId: args.dispatchId, ok: false, error: 'buildScript: ' + e });
        return;
    }
    dbg('examLock: script built (' + script.length + ' chars), invoking runPowerShell');
    try {
        runPowerShell(script, 50 * 1000, function (ok, bytes, log, note) {
            dbg('examLock: runPowerShell callback fired (ok=' + ok + ', bytes=' + bytes + ', note=' + (note || '').slice(0, 200) + ')');
            var until = null;
            var m = note && note.match(/locked until (.+)/);
            if (m) until = m[1];
            try {
                reply({
                    pluginaction: 'examLockResult',
                    dispatchId: args.dispatchId,
                    ok: ok,
                    allowCount: bytes,
                    until: until,
                    log: (log || '').slice(-2000),
                });
                dbg('examLock: reply sent');
            } catch (e) { dbg('examLock: reply threw: ' + e); }
        });
        dbg('examLock: runPowerShell returned (waiting for callback)');
    } catch (e) {
        dbg('examLock: runPowerShell threw synchronously: ' + e);
        reply({ pluginaction: 'examLockResult', dispatchId: args.dispatchId, ok: false, error: 'runPS sync: ' + e });
    }
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

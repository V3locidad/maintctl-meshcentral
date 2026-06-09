/*
 * maintctl — server-side plugin.
 *
 * Liste les postes, dispatche actions 'clean' et 'devList' à des agents
 * Windows, expose résultats remontés via serveraction.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_MAX = 200;
const RUN_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DOWNLOAD_TTL_MS = 30 * 60 * 1000; // 30 min
const DEV_TTL_MS = 5 * 60 * 1000; // 5 min de cache
const EVT_TTL_MS = 5 * 60 * 1000; // 5 min de cache events

const pendingDispatches = {};      // dispatchId -> { kind, runId|nodeId, expires }
const downloadTokens = {};         // token -> { kind, payload, expires }
const uploadTokens = {};           // token -> { kind:'driver', filename, expires }

// driversDir vient de maintctl-config.json (mêmes principes que softctl :
// NFS/SMB monté côté serveur MC, on scanne pour les .zip). Fallback : dossier
// drivers/ embarqué dans le plugin si pas de config.
function loadDriversDir() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'maintctl-config.json'), 'utf8'));
        if (cfg && cfg.driversDir) return cfg.driversDir;
    } catch (e) {}
    return path.join(__dirname, 'drivers');
}
const serverState = { baseUrl: '' };
const runs = {};                   // runId -> run cleanup
const devCache = {};               // nodeId -> { devices, lastCheck }
const evtCache = {};               // nodeId -> { events, summary, lastCheck }
const evtWaiters = {};             // dispatchId -> { res, expires }
const devPendingWaiters = {};      // dispatchId -> { res, expires }
const devDetailsWaiters = {};      // dispatchId -> { res, expires }
const devActionWaiters = {};       // dispatchId -> { res, expires }

// Registre (ex-regctl) : dispatch + long-polling.
//   regPending[id] = true tant qu'on attend l'agent
//   regWaiters[id] = liste de { res, timer } pour long-poll
//   regResults[id] = résultat stocké si arrivé avant le poll
const regPending = {};
const regWaiters = {};
const regResults = {};
const REG_RESULT_TTL_MS = 60 * 1000;
setInterval(function () {
    const now = Date.now();
    Object.keys(regResults).forEach((k) => {
        if (now - regResults[k].time > REG_RESULT_TTL_MS) delete regResults[k];
    });
}, 60 * 1000);

const AGENT_TYPE = {
    1: 'Windows', 2: 'Windows', 3: 'Windows', 4: 'Windows', 5: 'Windows',
    6: 'Linux', 9: 'Linux', 13: 'Linux', 25: 'Linux',
    7: 'macOS', 16: 'macOS', 29: 'macOS',
    11: 'Android', 12: 'iOS',
};

// Dérive un libellé court "Marque Modèle" depuis un doc sysinfo MeshCentral.
// Tente plusieurs emplacements connus selon la version MC et l'OS.
function deriveModel(sys) {
    if (!sys) return '';
    const hw = sys.hardware || {};
    let manuf = '', product = '';
    // 1) Windows WMI Win32_ComputerSystem (chemin MC le plus courant)
    const cs = hw.windows && (Array.isArray(hw.windows.computerSystem) ? hw.windows.computerSystem[0] : hw.windows.computerSystem);
    if (cs) { manuf = cs.Manufacturer || ''; product = cs.Model || ''; }
    // 2) DMI/SMBIOS via identifiers (cross-OS)
    if (!product) {
        const id = hw.identifiers || {};
        manuf = manuf || id.system_manufacturer || id.board_vendor || id.bios_vendor || '';
        product = id.system_product_name || id.product_name || id.board_name || '';
    }
    manuf = String(manuf || '').trim();
    product = String(product || '').trim();
    // Nettoyage : retire suffixes bruyants
    product = product.replace(/\s+(Desktop Mini PC|Mini Tower|Desktop|Tower|PC|Workstation)$/i, '').trim();
    // Si le produit commence déjà par la marque, on évite la duplication
    const manufShort = manuf.replace(/\s+(Inc\.?|Corp\.?|Computer|Computers|Co\.?|Ltd\.?)$/i, '').trim();
    if (!manufShort) return product;
    if (!product) return manufShort;
    if (product.toLowerCase().indexOf(manufShort.toLowerCase()) === 0) return product;
    return (manufShort + ' ' + product).trim();
}

// Trouve récursivement la valeur d'une clé (recherche case-insensitive) dans
// un objet potentiellement profond. Utile car les versions MC rangent les
// disques logiques et le LastBoot à des emplacements variés.
function deepFindKey(obj, wantedLc, visited, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
    visited = visited || new Set();
    if (visited.has(obj)) return undefined;
    visited.add(obj);
    for (const k in obj) {
        if (k.toLowerCase() === wantedLc) {
            return obj[k];
        }
    }
    for (const k in obj) {
        const v = obj[k];
        if (v && typeof v === 'object') {
            const r = deepFindKey(v, wantedLc, visited, (depth || 0) + 1);
            if (r !== undefined) return r;
        }
    }
    return undefined;
}

// Récupère TOUS les objets qui ressemblent à un disque logique (ont DeviceID/
// Caption/Name + Size/FreeSpace) en parcourant l'arbre.
function deepFindLogicalDisks(obj, out, visited, depth) {
    out = out || [];
    if (!obj || typeof obj !== 'object' || depth > 8) return out;
    visited = visited || new Set();
    if (visited.has(obj)) return out;
    visited.add(obj);
    if (Array.isArray(obj)) {
        obj.forEach((it) => deepFindLogicalDisks(it, out, visited, (depth || 0) + 1));
        return out;
    }
    // Critère : objet qui a au moins un identifiant + une taille
    const idLike = ['DeviceID','Caption','Name','DriveLetter'].find((k) => k in obj);
    const sizeLike = ['Size','Capacity','Total','TotalBytes'].find((k) => k in obj);
    const freeLike = ['FreeSpace','Free','AvailableBytes','CapacityRemaining'].find((k) => k in obj);
    if (idLike && (sizeLike || freeLike)) {
        out.push(obj);
    }
    Object.keys(obj).forEach((k) => {
        if (obj[k] && typeof obj[k] === 'object') {
            deepFindLogicalDisks(obj[k], out, visited, (depth || 0) + 1);
        }
    });
    return out;
}

function pickFirst(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
        if (obj[keys[i]] != null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return undefined;
}

// Extrait les métriques santé (disque C: + dernier boot) depuis un doc
// sysinfo MeshCentral. Recherche récursive, robuste aux variations de structure.
function deriveHealth(sys) {
    const out = { diskFreeGB: null, diskTotalGB: null, diskFreePct: null, lastBoot: null, uptimeDays: null };
    if (!sys) return out;
    // --- Disque C: ---
    // Path principal observé sur MC : hardware.windows.volumes = objet keyé
    // par lettre, ex { "C": { type, size, sizeremaining }, "D": {...} }.
    // Fallback : recherche récursive de tout objet ressemblant à un volume
    // (avec DeviceID/Caption/Name + Size/FreeSpace).
    let total = 0, free = 0;
    const winVols = sys.hardware && sys.hardware.windows && sys.hardware.windows.volumes;
    if (winVols && typeof winVols === 'object' && !Array.isArray(winVols)) {
        const cKey = Object.keys(winVols).find((k) => k.toUpperCase() === 'C');
        if (cKey) {
            const v = winVols[cKey] || {};
            total = Number(pickFirst(v, ['size','Size','total','Total','Capacity']) || 0);
            free = Number(pickFirst(v, ['sizeremaining','SizeRemaining','freeSpace','FreeSpace','Free','AvailableBytes']) || 0);
        }
    }
    if (!total) {
        const disks = deepFindLogicalDisks(sys);
        let c = null;
        for (let i = 0; i < disks.length; i++) {
            const d = disks[i];
            const id = String(pickFirst(d, ['DeviceID','Caption','Name','DriveLetter']) || '').toUpperCase();
            if (id.indexOf('C:') === 0 || id === 'C') { c = d; break; }
        }
        if (c) {
            free = Number(pickFirst(c, ['FreeSpace','Free','AvailableBytes','CapacityRemaining']) || 0);
            total = Number(pickFirst(c, ['Size','Capacity','Total','TotalBytes']) || 0);
        }
    }
    if (total > 0) {
        out.diskFreeGB = +(free / 1073741824).toFixed(1);
        out.diskTotalGB = +(total / 1073741824).toFixed(1);
        out.diskFreePct = Math.round((free / total) * 100);
    }
    // --- LastBootUpTime / dernier boot ---
    let lb = deepFindKey(sys, 'lastbootuptime')
          || deepFindKey(sys, 'lastboot')
          || deepFindKey(sys, 'bootuptime');
    if (lb) {
        let bootMs = null;
        if (typeof lb === 'number') bootMs = lb < 1e12 ? lb * 1000 : lb;
        else if (typeof lb === 'string') {
            // Format WMI CIM_DATETIME : YYYYMMDDHHMMSS.mmmmmm±UUU
            const m = lb.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
            if (m) {
                bootMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
            } else {
                const t = Date.parse(lb);
                if (!isNaN(t)) bootMs = t;
            }
        }
        if (bootMs) {
            out.lastBoot = bootMs;
            out.uptimeDays = +((Date.now() - bootMs) / 86400000).toFixed(1);
        }
    }
    return out;
}


// Seuils d'alerte santé. Surchargables dans maintctl-config.json sous "health".
function loadHealthConfig() {
    const defaults = {
        diskCriticalGB: 2,   // disque libre < 2 Go = critique
        diskWarnGB: 10,      // < 10 Go = warning
        uptimeWarnDays: 21,  // pas redémarré depuis 21 jours = warning
        uptimeCriticalDays: 45,
    };
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'maintctl-config.json'), 'utf8'));
        if (cfg && cfg.health) Object.assign(defaults, cfg.health);
    } catch (_) {}
    return defaults;
}

function evalAlerts(health, online, cfg) {
    const alerts = [];
    if (!online) return alerts; // pas d'alerte sur poste éteint (peut être normal hors cours)
    if (health.diskFreeGB != null) {
        if (health.diskFreeGB < cfg.diskCriticalGB) {
            alerts.push({ level: 'critical', code: 'disk', message: 'Disque C: presque plein (' + health.diskFreeGB + ' Go libres)' });
        } else if (health.diskFreeGB < cfg.diskWarnGB) {
            alerts.push({ level: 'warning', code: 'disk', message: 'Disque C: bas (' + health.diskFreeGB + ' Go libres)' });
        }
    }
    if (health.uptimeDays != null) {
        if (health.uptimeDays > cfg.uptimeCriticalDays) {
            alerts.push({ level: 'critical', code: 'uptime', message: 'Pas redémarré depuis ' + Math.round(health.uptimeDays) + ' jours' });
        } else if (health.uptimeDays > cfg.uptimeWarnDays) {
            alerts.push({ level: 'warning', code: 'uptime', message: 'Pas redémarré depuis ' + Math.round(health.uptimeDays) + ' jours' });
        }
    }
    return alerts;
}

// Catégorise un event Windows pour l'affichage condensé. Renvoie aussi
// un niveau d'importance (critical/error/warning) basé sur le Level et
// la nature de l'événement.
function categorizeEvent(e) {
    const src = (e.src || '').toLowerCase();
    const id = e.id;
    const log = (e.l || '').toLowerCase();
    const lvl = e.lv; // 1=Critical, 2=Error, 3=Warning
    // BSOD : Kernel-Power id 41 (unexpected shutdown) ou WER 1001
    if (id === 41 && src.indexOf('kernel-power') >= 0) return { cat: 'bsod', label: 'BSOD / arrêt brutal' };
    if (id === 1001 && src.indexOf('wer') >= 0) return { cat: 'bsod', label: 'BSOD / rapport erreur' };
    if (src.indexOf('bugcheck') >= 0) return { cat: 'bsod', label: 'BSOD' };
    // Disque / stockage / fichier système
    if (src === 'disk' || src.indexOf('ntfs') >= 0 || src.indexOf('volsnap') >= 0
        || src.indexOf('volmgr') >= 0 || src.indexOf('storahci') >= 0
        || src.indexOf('storport') >= 0 || src.indexOf('iastor') >= 0) {
        return { cat: 'disk', label: 'Disque / stockage' };
    }
    // Drivers / PnP / matériel
    if (src.indexOf('pnp') >= 0 || src.indexOf('driverframeworks') >= 0
        || src.indexOf('kernel-pnp') >= 0 || src.indexOf('whea-logger') >= 0
        || src === 'display' || src.indexOf('nvlddmkm') >= 0) {
        return { cat: 'driver', label: 'Driver / matériel' };
    }
    // Services Windows
    if (src.indexOf('service control manager') >= 0) {
        return { cat: 'service', label: 'Services Windows' };
    }
    // Réseau
    if (src.indexOf('dhcp') >= 0 || src.indexOf('dns') >= 0 || src.indexOf('netbt') >= 0
        || src.indexOf('netlogon') >= 0 || src.indexOf('tcpip') >= 0) {
        return { cat: 'network', label: 'Réseau' };
    }
    // Sécurité (Defender, auth)
    if (src.indexOf('defender') >= 0 || src.indexOf('security') >= 0
        || src.indexOf('lsa') >= 0 || src.indexOf('authentication') >= 0) {
        return { cat: 'security', label: 'Sécurité' };
    }
    // Applications (Application log)
    if (log === 'application') {
        return { cat: 'app', label: 'Application' };
    }
    return { cat: 'other', label: 'Autre' };
}

function summarizeEvents(events) {
    const cats = {};
    let crit = 0, err = 0, warn = 0;
    events.forEach((e) => {
        const c = categorizeEvent(e);
        e.cat = c.cat;
        e.catLabel = c.label;
        if (!cats[c.cat]) cats[c.cat] = { cat: c.cat, label: c.label, count: 0, critical: 0, error: 0, warning: 0 };
        cats[c.cat].count++;
        if (e.lv === 1) { cats[c.cat].critical++; crit++; }
        else if (e.lv === 2) { cats[c.cat].error++; err++; }
        else if (e.lv === 3) { cats[c.cat].warning++; warn++; }
    });
    return {
        total: events.length,
        critical: crit,
        error: err,
        warning: warn,
        byCategory: Object.values(cats).sort((a, b) => (b.critical + b.error) - (a.critical + a.error)),
    };
}

function newDownloadToken(kind, payload) {
    const t = crypto.randomBytes(24).toString('hex');
    downloadTokens[t] = { kind: kind, payload: payload || null, expires: Date.now() + DOWNLOAD_TTL_MS };
    return t;
}
function consumeDownloadToken(t) {
    const e = downloadTokens[t];
    if (!e) return null;
    if (e.expires < Date.now()) { delete downloadTokens[t]; return null; }
    delete downloadTokens[t];
    return e;
}

// Délai sans heartbeat au-delà duquel un install/clean encore "running"
// est considéré comme abandonné (poste éteint, agent crashé…).
// L'agent émet driverInstallProgress toutes les 4s pendant pnputil, et un
// install d'un seul .inf dépasse rarement 60s, donc 10 min est très large.
const STALE_RUN_MS = 10 * 60 * 1000;

function markStaleRuns() {
    const now = Date.now();
    let changed = false;
    Object.values(runs).forEach((r) => {
        if (!r || !r.results) return;
        Object.keys(r.results).forEach((nid) => {
            const res2 = r.results[nid];
            if (!res2 || res2.status !== 'running') return;
            const last = res2.time || r.timestamp || 0;
            if (now - last > STALE_RUN_MS) {
                res2.status = 'aborted';
                res2.error = 'poste injoignable (pas de heartbeat depuis '
                    + Math.round((now - last) / 60000) + ' min — éteint ou agent perdu ?)';
                changed = true;
            }
        });
    });
    return changed;
}

function historyPath(__dir) { return path.join(__dir, 'maintctl-history.json'); }

function loadHistory(__dir) {
    try {
        const raw = JSON.parse(fs.readFileSync(historyPath(__dir), 'utf8'));
        (raw.runs || []).forEach((r) => { if (r && r.id) runs[r.id] = r; });
    } catch (e) {}
}

function saveHistory(__dir) {
    try {
        const list = Object.values(runs).sort((a, b) => b.timestamp - a.timestamp).slice(0, HISTORY_MAX);
        fs.writeFileSync(historyPath(__dir), JSON.stringify({ runs: list }, null, 2));
    } catch (e) {}
}

module.exports.maintctl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = [];

    const __dir = __dirname;
    loadHistory(__dir);

    function sendJson(res, code, payload) {
        res.status(code || 200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
    }

    function listAgents(cb) {
        const db = obj.meshServer && obj.meshServer.db;
        if (!db || typeof db.GetAllType !== 'function') return cb(new Error('MC DB inaccessible'));
        const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
        db.GetAllType('mesh', function (meshErr, meshDocs) {
            if (meshErr) return cb(meshErr);
            const meshById = {};
            (meshDocs || []).forEach((m) => { if (m && m._id) meshById[m._id] = m.name || m._id; });
            const buildAgents = (sysById) => (docs) => {
                const agents = (docs || []).filter((d) => d && d._id && (d.agent || d.osdesc)).map((d) => {
                    const family = (d.agent && AGENT_TYPE[d.agent.id]) || '';
                    return {
                        id: d._id,
                        name: d.name || d.host || d._id,
                        meshid: d.meshid || '',
                        mesh: meshById[d.meshid] || '',
                        os: d.osdesc || family || '?',
                        family: family,
                        model: deriveModel(sysById[d._id]),
                        online: !!wsagents[d._id],
                    };
                });
                return agents;
            };
            db.GetAllType('sysinfo', function (sErr, sysDocs) {
                const sysById = {};
                if (!sErr && Array.isArray(sysDocs)) {
                    sysDocs.forEach((s) => {
                        if (!s || !s._id) return;
                        // _id format: 'si<nodeId>' ou directement le nodeId selon version MC
                        const nid = (typeof s._id === 'string' && s._id.indexOf('si') === 0) ? s._id.slice(2) : s._id;
                        sysById[nid] = s;
                    });
                }
                db.GetAllType('node', function (err, docs) {
                    if (err) return cb(err);
                    const agents = buildAgents(sysById)(docs);
                    agents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                    const meshes = Object.keys(meshById).map((id) => ({ id: id, name: meshById[id] }));
                    meshes.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                    cb(null, agents, meshes);
                });
            });
        });
    }

    obj.serveraction = function (command) {
        try {
            if (!command) return;
            if (command.pluginaction === 'pong') return;

            if (command.pluginaction === 'regResult') {
                const id = command.dispatchId;
                if (!id) return;
                const payload = {
                    ok: !!command.ok,
                    data: command.data,
                    error: command.error,
                    time: Date.now(),
                };
                delete regPending[id];
                const arr = regWaiters[id] || [];
                delete regWaiters[id];
                if (arr.length) {
                    arr.forEach((w) => {
                        try { clearTimeout(w.timer); } catch (e) {}
                        try {
                            w.res.setHeader('Content-Type', 'application/json');
                            w.res.end(JSON.stringify({ ready: true, result: payload }));
                        } catch (e) {}
                    });
                } else {
                    regResults[id] = payload;
                }
                return;
            }

            if (command.pluginaction === 'devDetailsResult') {
                const did = command.dispatchId;
                if (!did) return;
                delete pendingDispatches[did];
                const waiter = devDetailsWaiters[did];
                if (!waiter) return;
                delete devDetailsWaiters[did];
                let details = null;
                let err = command.error || '';
                if (!err && command.detailsJson) {
                    try {
                        let raw = command.detailsJson;
                        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
                        details = JSON.parse(raw);
                    } catch (e) { err = 'parse JSON: ' + e.message; }
                }
                try {
                    waiter.res.setHeader('Content-Type', 'application/json');
                    waiter.res.end(JSON.stringify({
                        ok: !err,
                        error: err || undefined,
                        details: details
                    }));
                } catch (e) {}
                return;
            }
            if (command.pluginaction === 'devActionResult') {
                const did = command.dispatchId;
                if (!did) return;
                delete pendingDispatches[did];
                const waiter = devActionWaiters[did];
                if (!waiter) return;
                delete devActionWaiters[did];
                try {
                    waiter.res.setHeader('Content-Type', 'application/json');
                    waiter.res.end(JSON.stringify({
                        ok: !!command.ok,
                        action: command.action,
                        instanceId: command.instanceId,
                        log: command.logTail || ''
                    }));
                } catch (e) {}
                return;
            }
            if (command.pluginaction === 'eventListResult') {
                const did = command.dispatchId;
                if (!did) return;
                const entry = pendingDispatches[did];
                if (!entry || entry.kind !== 'eventList') return;
                delete pendingDispatches[did];
                const nid = entry.nodeId;
                let events = [];
                let err = command.error || '';
                if (!err && command.eventsJson) {
                    try {
                        let raw = command.eventsJson;
                        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
                        const parsed = JSON.parse(raw);
                        events = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                    } catch (e) {
                        err = 'parse JSON: ' + e.message;
                    }
                }
                const summary = summarizeEvents(events);
                evtCache[nid] = { ok: !err, error: err, events: events, summary: summary, lastCheck: Date.now() };
                const w = evtWaiters[did];
                if (w) {
                    delete evtWaiters[did];
                    try {
                        w.res.setHeader('Content-Type', 'application/json');
                        w.res.end(JSON.stringify({
                            ok: !err, error: err || undefined,
                            events: events, summary: summary,
                            lastCheck: evtCache[nid].lastCheck,
                            logTail: command.logTail || ''
                        }));
                    } catch (_) {}
                }
                return;
            }
            if (command.pluginaction === 'devListResult') {
                const did = command.dispatchId;
                if (!did) return;
                const entry = pendingDispatches[did];
                if (!entry || entry.kind !== 'devList') return;
                delete pendingDispatches[did];
                const nid = entry.nodeId;
                let devices = [];
                let err = command.error || '';
                // Parsing JSON côté serveur (Node = parser robuste).
                if (!err && command.devicesJson) {
                    try {
                        // Strip BOM UTF-8 si présent.
                        let raw = command.devicesJson;
                        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
                        const parsed = JSON.parse(raw);
                        devices = Array.isArray(parsed) ? parsed : [parsed];
                    } catch (e) {
                        err = 'parse JSON (server): ' + e.message;
                    }
                } else if (!err && Array.isArray(command.devices)) {
                    devices = command.devices;
                }
                devCache[nid] = {
                    ok: !err,
                    error: err,
                    devices: devices,
                    lastCheck: Date.now()
                };
                const waiter = devPendingWaiters[did];
                if (waiter) {
                    delete devPendingWaiters[did];
                    try {
                        waiter.res.setHeader('Content-Type', 'application/json');
                        waiter.res.end(JSON.stringify({
                            ok: !err,
                            error: err || undefined,
                            devices: devices,
                            cached: false,
                        }));
                    } catch (e) {}
                }
                return;
            }

            if (command.pluginaction === 'driverInstallProgress' || command.pluginaction === 'driverInstallComplete') {
                const did2 = command.dispatchId;
                if (!did2) return;
                const entry2 = pendingDispatches[did2];
                if (!entry2 || entry2.kind !== 'driverInstall') return;
                const run2 = runs[entry2.runId];
                if (!run2) return;
                const r2 = run2.results[entry2.nodeId] || (run2.results[entry2.nodeId] = { status: 'running', time: Date.now() });
                if (command.pluginaction === 'driverInstallProgress') {
                    r2.step = command.step || '';
                    r2.time = Date.now();
                } else {
                    r2.status = command.ok ? 'done' : 'error';
                    r2.ok = !!command.ok;
                    r2.installed = command.installed || 0;
                    r2.rebootRequired = !!command.rebootRequired;
                    r2.error = command.error || undefined;
                    r2.logTail = command.logTail || '';
                    r2.time = Date.now();
                    delete pendingDispatches[did2];
                }
                saveHistory(__dir);
                return;
            }

            if (command.pluginaction !== 'cleanProgress' && command.pluginaction !== 'cleanComplete') return;
            const did = command.dispatchId;
            if (!did) return;
            const entry = pendingDispatches[did];
            if (!entry || entry.kind !== 'clean') return;
            const run = runs[entry.runId];
            if (!run) return;
            const r = run.results[entry.nodeId] || (run.results[entry.nodeId] = { status: 'running', tasks: {}, totalBytes: 0, time: Date.now() });
            if (command.pluginaction === 'cleanProgress') {
                r.tasks[command.task] = { ok: !!command.ok, bytes: command.bytes || 0, note: command.note || '' };
                if (command.bytes) r.totalBytes += command.bytes;
                r.time = Date.now();
            } else {
                r.status = command.ok ? 'done' : 'error';
                r.error = command.error || undefined;
                if (command.results) {
                    Object.keys(command.results).forEach((tk) => {
                        const cur = r.tasks[tk] || {};
                        const v = command.results[tk] || {};
                        r.tasks[tk] = {
                            ok: !!v.ok,
                            bytes: v.bytes || cur.bytes || 0,
                            note: v.note || cur.note || '',
                            logTail: v.logTail || cur.logTail,
                        };
                    });
                    r.totalBytes = Object.values(r.tasks).reduce((s, t) => s + (t.bytes || 0), 0);
                }
                r.time = Date.now();
                delete pendingDispatches[did];
            }
            const now = Date.now();
            Object.keys(pendingDispatches).forEach((k) => {
                if (pendingDispatches[k].expires < now) delete pendingDispatches[k];
            });
            saveHistory(__dir);
        } catch (e) {
            console.log('maintctl: serveraction error: ' + e.message);
        }
    };

    obj.server_startup = function () {
        const ws = obj.meshServer && obj.meshServer.webserver;
        const app = ws && ws.app;
        if (!app || typeof app.get !== 'function') {
            console.log('maintctl: webserver.app inaccessible — downloads HTTP indisponibles');
            return;
        }
        app.get('/maintctl-download/delprof2/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = consumeDownloadToken(token);
                if (!entry || entry.kind !== 'delprof2') {
                    return res.status(403).set('Content-Type', 'text/plain').send('forbidden');
                }
                const bin = path.join(__dirname, 'bin', 'DelProf2.exe');
                if (!fs.existsSync(bin)) {
                    console.log('maintctl: DelProf2.exe absent à ' + bin);
                    return res.status(404).set('Content-Type', 'text/plain').send('DelProf2.exe non déployé sur le serveur');
                }
                const stat = fs.statSync(bin);
                res.set('Content-Type', 'application/octet-stream');
                res.set('Content-Length', stat.size);
                res.set('Content-Disposition', 'attachment; filename="DelProf2.exe"');
                fs.createReadStream(bin).pipe(res);
            } catch (e) { res.status(500).send(e.message); }
        });
        app.get('/maintctl-download/driver/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = consumeDownloadToken(token);
                if (!entry || entry.kind !== 'driver') {
                    return res.status(403).set('Content-Type', 'text/plain').send('forbidden');
                }
                const payload = entry.payload || {};
                // Deux modes :
                //   { file: 'xxx.zip' }                         → fichier .zip à la racine de driversDir
                //   { pack: 'foo', file: 'foo.inf' }            → fichier dans le sous-dossier pack/
                if (payload.pack) {
                    if (!/^[a-zA-Z0-9._-]+$/.test(payload.pack) || !/^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+$/.test(payload.file)) {
                        return res.status(400).set('Content-Type', 'text/plain').send('invalid path');
                    }
                    const full = path.join(loadDriversDir(), payload.pack, payload.file);
                    if (!fs.existsSync(full)) return res.status(404).set('Content-Type', 'text/plain').send('not found');
                    const stat = fs.statSync(full);
                    res.set('Content-Type', 'application/octet-stream');
                    res.set('Content-Length', stat.size);
                    res.set('Content-Disposition', 'attachment; filename="' + payload.file + '"');
                    return fs.createReadStream(full).pipe(res);
                }
                const file = payload.file || '';
                if (!/^[a-zA-Z0-9._-]+\.zip$/.test(file)) {
                    return res.status(400).set('Content-Type', 'text/plain').send('invalid file');
                }
                const full = path.join(loadDriversDir(), file);
                if (!fs.existsSync(full)) {
                    return res.status(404).set('Content-Type', 'text/plain').send('driver not found');
                }
                const stat = fs.statSync(full);
                res.set('Content-Type', 'application/zip');
                res.set('Content-Length', stat.size);
                res.set('Content-Disposition', 'attachment; filename="' + file + '"');
                fs.createReadStream(full).pipe(res);
            } catch (e) { res.status(500).send(e.message); }
        });
        app.put('/maintctl-upload/driver/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = uploadTokens[token];
                if (!entry || entry.kind !== 'driver' || entry.expires < Date.now()) {
                    return res.status(403).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'token invalide ou expiré' }));
                }
                delete uploadTokens[token]; // single-use
                const dir = loadDriversDir();
                const targetDir = entry.pack ? path.join(dir, entry.pack) : dir;
                try {
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                } catch (e) {
                    return res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'mkdir échoué (NFS read-only ?): ' + e.message }));
                }
                const full = path.join(targetDir, entry.filename);
                const tmp = full + '.uploading';
                const ws2 = fs.createWriteStream(tmp);
                req.pipe(ws2);
                ws2.on('finish', () => {
                    try {
                        if (fs.existsSync(full)) fs.unlinkSync(full);
                        fs.renameSync(tmp, full);
                        const stat = fs.statSync(full);
                        res.set('Content-Type', 'application/json').send(JSON.stringify({ ok: true, filename: entry.filename, pack: entry.pack || null, size: stat.size }));
                    } catch (e) {
                        try { fs.unlinkSync(tmp); } catch (_) {}
                        res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'rename: ' + e.message }));
                    }
                });
                ws2.on('error', (e) => {
                    try { fs.unlinkSync(tmp); } catch (_) {}
                    res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'write failed: ' + e.message }));
                });
            } catch (e) {
                res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: e.message }));
            }
        });
        console.log('maintctl: endpoint /maintctl-download/delprof2/:token enregistré');
        console.log('maintctl: endpoint /maintctl-download/driver/:token enregistré (dir: ' + loadDriversDir() + ')');
        console.log('maintctl: endpoint PUT /maintctl-upload/driver/:token enregistré');
    };

    obj.handleAdminReq = function (req, res, user) {
        const action = (req.query && req.query.action) || '';

        if (!serverState.baseUrl && req && req.headers && req.headers.host) {
            const proto = (req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http'));
            serverState.baseUrl = proto + '://' + req.headers.host;
        }

        if (action === 'ping') {
            return sendJson(res, 200, { ok: true, runs: Object.keys(runs).length });
        }

        if (action === 'nodeHistory') {
            const nodeId = String((req.query && req.query.nodeId) || '');
            const kind = String((req.query && req.query.kind) || 'driver');
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            if (markStaleRuns()) saveHistory(__dir);
            const out = [];
            Object.values(runs).forEach((r) => {
                if (!r || r.kind !== kind) return;
                const res2 = r.results && r.results[nodeId];
                if (!res2) return;
                const entry = {
                    runId: r.id,
                    timestamp: r.timestamp,
                    user: r.user,
                    status: res2.status,
                    step: res2.step,
                    error: res2.error,
                };
                if (kind === 'driver') {
                    entry.driver = r.driver;
                    entry.installed = res2.installed;
                    entry.errors = res2.errors;
                    entry.rebootRequired = res2.rebootRequired;
                } else if (kind === 'clean') {
                    entry.tasks = r.tasks;
                    entry.profileDays = r.profileDays;
                    entry.totalBytes = res2.totalBytes;
                    entry.tasksResult = res2.tasks;
                }
                out.push(entry);
            });
            out.sort((a, b) => b.timestamp - a.timestamp);
            return sendJson(res, 200, { nodeId: nodeId, runs: out.slice(0, 50) });
        }

        if (action === 'agents') {
            return listAgents(function (err, agents, meshes) {
                if (err) return sendJson(res, 500, { error: err.message });
                sendJson(res, 200, { agents: agents, meshes: meshes || [] });
            });
        }

        if (action === 'healthDebug') {
            // Debug : renvoie le sysinfo brut + ce que deriveHealth en extrait,
            // pour un nodeId. ?nodeId=...
            const nodeId = String((req.query && req.query.nodeId) || '');
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            const db = obj.meshServer && obj.meshServer.db;
            if (!db || typeof db.GetAllType !== 'function') return sendJson(res, 500, { error: 'DB inaccessible' });
            db.GetAllType('sysinfo', function (sErr, sysDocs) {
                if (sErr) return sendJson(res, 500, { error: sErr.message });
                let found = null;
                (sysDocs || []).forEach((s) => {
                    if (!s || !s._id) return;
                    const nid = (typeof s._id === 'string' && s._id.indexOf('si') === 0) ? s._id.slice(2) : s._id;
                    if (nid === nodeId) found = s;
                });
                if (!found) return sendJson(res, 404, { error: 'sysinfo introuvable pour ' + nodeId });
                const disks = deepFindLogicalDisks(found);
                const lb = deepFindKey(found, 'lastbootuptime') || deepFindKey(found, 'lastboot') || deepFindKey(found, 'bootuptime');
                return sendJson(res, 200, {
                    derived: deriveHealth(found),
                    disksFound: disks.map((d) => ({
                        keys: Object.keys(d),
                        DeviceID: d.DeviceID, Caption: d.Caption, Name: d.Name,
                        Size: d.Size, FreeSpace: d.FreeSpace, Free: d.Free,
                        Capacity: d.Capacity, CapacityRemaining: d.CapacityRemaining,
                    })),
                    lastBootRaw: lb,
                    sysinfoTopKeys: Object.keys(found),
                    sysinfoHardwareWindowsKeys: found.hardware && found.hardware.windows ? Object.keys(found.hardware.windows) : null,
                    sysinfo: found,
                });
            });
            return;
        }

        if (action === 'health') {
            const db = obj.meshServer && obj.meshServer.db;
            if (!db || typeof db.GetAllType !== 'function') return sendJson(res, 500, { error: 'MC DB inaccessible' });
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const hcfg = loadHealthConfig();
            db.GetAllType('mesh', function (meshErr, meshDocs) {
                if (meshErr) return sendJson(res, 500, { error: meshErr.message });
                const meshById = {};
                (meshDocs || []).forEach((m) => { if (m && m._id) meshById[m._id] = m.name || m._id; });
                db.GetAllType('sysinfo', function (sErr, sysDocs) {
                    const sysById = {};
                    if (!sErr && Array.isArray(sysDocs)) {
                        sysDocs.forEach((s) => {
                            if (!s || !s._id) return;
                            const nid = (typeof s._id === 'string' && s._id.indexOf('si') === 0) ? s._id.slice(2) : s._id;
                            sysById[nid] = s;
                        });
                    }
                    db.GetAllType('node', function (err, docs) {
                        if (err) return sendJson(res, 500, { error: err.message });
                        let critCount = 0, warnCount = 0;
                        const agents = (docs || [])
                            .filter((d) => d && d._id && (d.agent || d.osdesc))
                            .map((d) => {
                                const online = !!wsagents[d._id];
                                const sys = sysById[d._id];
                                const health = deriveHealth(sys);
                                const alerts = evalAlerts(health, online, hcfg);
                                alerts.forEach((a) => { if (a.level === 'critical') critCount++; else warnCount++; });
                                return {
                                    id: d._id,
                                    name: d.name || d.host || d._id,
                                    mesh: meshById[d.meshid] || '',
                                    online: online,
                                    model: deriveModel(sys),
                                    health: health,
                                    alerts: alerts,
                                };
                            });
                        agents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                        const meshes = Object.keys(meshById).map((id) => ({ id: id, name: meshById[id] }));
                        meshes.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                        sendJson(res, 200, {
                            agents: agents,
                            meshes: meshes,
                            alertCount: critCount + warnCount,
                            criticalCount: critCount,
                            warningCount: warnCount,
                            thresholds: hcfg,
                        });
                    });
                });
            });
            return;
        }

        if (action === 'run') {
            let body = {};
            try { body = JSON.parse((req.query && req.query.payload) || '{}'); }
            catch (e) { return sendJson(res, 400, { error: 'payload JSON invalide' }); }
            const nodes = Array.isArray(body.nodes) ? body.nodes.filter((n) => typeof n === 'string') : [];
            const tasks = Array.isArray(body.tasks) ? body.tasks.filter((t) => ['temp','browser','dism','profiles'].indexOf(t) >= 0) : [];
            const profileDays = parseInt(body.profileDays, 10) || 90;
            if (!nodes.length) return sendJson(res, 400, { error: 'aucun poste sélectionné' });
            if (!tasks.length) return sendJson(res, 400, { error: 'aucune tâche sélectionnée' });

            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const runId = crypto.randomBytes(8).toString('hex');
            const run = {
                id: runId,
                kind: 'clean',
                timestamp: Date.now(),
                user: (user && (user.name || user._id)) || 'unknown',
                tasks: tasks,
                profileDays: profileDays,
                nodes: nodes.map((id) => ({ id: id })),
                results: {},
            };
            runs[runId] = run;

            const dispatched = [];
            const offline = [];
            nodes.forEach((nid) => {
                const ws = wsagents[nid];
                if (!ws || typeof ws.send !== 'function') {
                    offline.push(nid);
                    run.results[nid] = { status: 'offline', tasks: {}, totalBytes: 0, time: Date.now() };
                    return;
                }
                const did = crypto.randomBytes(16).toString('hex');
                pendingDispatches[did] = { kind: 'clean', runId: runId, nodeId: nid, expires: Date.now() + RUN_TTL_MS };
                let delprof2Url = '';
                if (tasks.indexOf('profiles') >= 0 && serverState.baseUrl) {
                    delprof2Url = serverState.baseUrl + '/maintctl-download/delprof2/' + newDownloadToken('delprof2');
                }
                try {
                    ws.send(JSON.stringify({
                        action: 'plugin', plugin: 'maintctl', pluginaction: 'clean',
                        dispatchId: did,
                        tasks: tasks,
                        profileDays: profileDays,
                        delprof2Url: delprof2Url,
                    }));
                    run.results[nid] = { status: 'running', tasks: {}, totalBytes: 0, time: Date.now() };
                    dispatched.push(nid);
                } catch (e) {
                    run.results[nid] = { status: 'error', tasks: {}, totalBytes: 0, error: String(e), time: Date.now() };
                }
            });
            saveHistory(__dir);
            return sendJson(res, 200, { runId: runId, dispatched: dispatched.length, offline: offline.length });
        }

        if (action === 'runStatus') {
            const id = String((req.query && req.query.runId) || '');
            const run = runs[id];
            if (!run) return sendJson(res, 404, { error: 'run inconnu' });
            if (markStaleRuns()) saveHistory(__dir);
            return sendJson(res, 200, run);
        }

        // ---- Bibliothèque de drivers ----

        if (action === 'driverList') {
            const dir = loadDriversDir();
            try {
                if (!fs.existsSync(dir)) {
                    return sendJson(res, 200, { drivers: [], dir: dir, error: 'dossier introuvable : ' + dir + ' — vérifie maintctl-config.json et le montage NFS' });
                }
                const drivers = [];
                fs.readdirSync(dir).forEach((entry) => {
                    if (!/^[a-zA-Z0-9._-]+$/.test(entry)) return;
                    const full = path.join(dir, entry);
                    let st = null;
                    try { st = fs.statSync(full); } catch (_) { return; }
                    if (st.isFile() && /\.zip$/i.test(entry)) {
                        drivers.push({ name: entry, type: 'zip', size: st.size, mtime: st.mtimeMs, fileCount: 1 });
                    } else if (st.isDirectory()) {
                        // Scanne le dossier : taille totale + count + détecte présence .inf
                        let total = 0, count = 0, hasInf = false;
                        try {
                            fs.readdirSync(full).forEach((f) => {
                                try {
                                    const s2 = fs.statSync(path.join(full, f));
                                    if (s2.isFile()) {
                                        total += s2.size; count++;
                                        if (/\.inf$/i.test(f)) hasInf = true;
                                    }
                                } catch (_) {}
                            });
                        } catch (_) {}
                        if (count > 0) drivers.push({ name: entry, type: 'folder', size: total, mtime: st.mtimeMs, fileCount: count, hasInf: hasInf });
                    }
                });
                drivers.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
                return sendJson(res, 200, { drivers: drivers, dir: dir });
            } catch (e) { return sendJson(res, 500, { error: e.message + ' (dir: ' + dir + ')' }); }
        }

        if (action === 'requestDriverUploadToken') {
            const filename = String((req.query && req.query.filename) || '').replace(/[\\/]/g, '_').trim();
            const pack = String((req.query && req.query.pack) || '').trim();
            const dir = loadDriversDir();
            const overwrite = String((req.query && req.query.overwrite) || '') === '1';

            if (pack) {
                // Mode pack : dossier + n'importe quel fichier de pilote (.inf/.sys/.cat/.dll/.cab/.pnf/...)
                if (!/^[a-zA-Z0-9._-]+$/.test(pack)) return sendJson(res, 400, { error: 'pack invalide ([a-zA-Z0-9._-])' });
                if (!/^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+$/.test(filename)) return sendJson(res, 400, { error: 'filename invalide' });
                if (!overwrite && fs.existsSync(path.join(dir, pack, filename))) {
                    return sendJson(res, 409, { error: 'fichier existe déjà — overwrite=1 pour remplacer' });
                }
                const token = crypto.randomBytes(24).toString('hex');
                uploadTokens[token] = { kind: 'driver', pack: pack, filename: filename, expires: Date.now() + DOWNLOAD_TTL_MS };
                return sendJson(res, 200, { token: token, url: '/maintctl-upload/driver/' + token, pack: pack, filename: filename });
            }
            // Mode legacy : .zip à la racine
            if (!/^[a-zA-Z0-9._-]+\.zip$/.test(filename)) {
                return sendJson(res, 400, { error: 'filename invalide (autorisé : [a-zA-Z0-9._-]+.zip — ou utilise le mode pack pour des fichiers libres)' });
            }
            if (!overwrite && fs.existsSync(path.join(dir, filename))) {
                return sendJson(res, 409, { error: 'fichier existe déjà — overwrite=1 pour remplacer' });
            }
            const token = crypto.randomBytes(24).toString('hex');
            uploadTokens[token] = { kind: 'driver', filename: filename, expires: Date.now() + DOWNLOAD_TTL_MS };
            return sendJson(res, 200, { token: token, url: '/maintctl-upload/driver/' + token, filename: filename });
        }

        if (action === 'deleteDriver') {
            const name = String((req.query && req.query.name) || (req.query && req.query.filename) || '');
            if (!/^[a-zA-Z0-9._-]+$/.test(name)) return sendJson(res, 400, { error: 'nom invalide' });
            const full = path.join(loadDriversDir(), name);
            if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'introuvable' });
            try {
                const st = fs.statSync(full);
                if (st.isDirectory()) {
                    fs.rmSync(full, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(full);
                }
                return sendJson(res, 200, { ok: true });
            }
            catch (e) { return sendJson(res, 500, { error: e.message }); }
        }

        if (action === 'driverInstall') {
            let body = {};
            try { body = JSON.parse((req.query && req.query.payload) || '{}'); }
            catch (e) { return sendJson(res, 400, { error: 'payload JSON invalide' }); }
            const nodes = Array.isArray(body.nodes) ? body.nodes.filter((n) => typeof n === 'string') : [];
            const driver = String(body.driver || '');
            if (!nodes.length) return sendJson(res, 400, { error: 'aucun poste sélectionné' });
            if (!/^[a-zA-Z0-9._-]+$/.test(driver)) return sendJson(res, 400, { error: 'driver invalide' });
            const driversDir = loadDriversDir();
            const driverPath = path.join(driversDir, driver);
            if (!fs.existsSync(driverPath)) return sendJson(res, 400, { error: 'driver introuvable: ' + driver });
            if (!serverState.baseUrl) return sendJson(res, 500, { error: 'baseUrl pas encore captée — recharge la page admin' });

            // Détecte le type
            const st = fs.statSync(driverPath);
            const isZip = st.isFile() && /\.zip$/i.test(driver);
            const isFolder = st.isDirectory();
            if (!isZip && !isFolder) return sendJson(res, 400, { error: 'driver doit être un .zip ou un dossier' });

            // Pour un folder : énumère les fichiers (uniquement à la racine du pack)
            let packFiles = [];
            if (isFolder) {
                try {
                    packFiles = fs.readdirSync(driverPath).filter((f) => {
                        try { return fs.statSync(path.join(driverPath, f)).isFile(); }
                        catch (_) { return false; }
                    });
                } catch (e) { return sendJson(res, 500, { error: 'lecture dossier: ' + e.message }); }
                if (!packFiles.length) return sendJson(res, 400, { error: 'dossier vide' });
                if (!packFiles.some((f) => /\.inf$/i.test(f))) return sendJson(res, 400, { error: 'aucun .inf dans le dossier ' + driver });
            }

            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const runId = crypto.randomBytes(8).toString('hex');
            const run = {
                id: runId, kind: 'driver', driver: driver,
                timestamp: Date.now(),
                user: (user && (user.name || user._id)) || 'unknown',
                nodes: nodes.map((id) => ({ id: id })),
                results: {},
            };
            runs[runId] = run;

            const dispatched = [];
            const offline = [];
            nodes.forEach((nid) => {
                const ws = wsagents[nid];
                if (!ws || typeof ws.send !== 'function') {
                    offline.push(nid);
                    run.results[nid] = { status: 'offline', time: Date.now() };
                    return;
                }
                const did = crypto.randomBytes(16).toString('hex');
                pendingDispatches[did] = { kind: 'driverInstall', runId: runId, nodeId: nid, expires: Date.now() + RUN_TTL_MS };
                const msg = {
                    action: 'plugin', plugin: 'maintctl', pluginaction: 'driverInstall',
                    dispatchId: did, driver: driver
                };
                if (isZip) {
                    msg.driverUrl = serverState.baseUrl + '/maintctl-download/driver/' + newDownloadToken('driver', { file: driver });
                } else {
                    msg.driverFiles = packFiles.map((f) => ({
                        name: f,
                        url: serverState.baseUrl + '/maintctl-download/driver/' + newDownloadToken('driver', { pack: driver, file: f })
                    }));
                }
                try {
                    ws.send(JSON.stringify(msg));
                    run.results[nid] = { status: 'running', step: 'download', time: Date.now() };
                    dispatched.push(nid);
                } catch (e) {
                    run.results[nid] = { status: 'error', error: String(e), time: Date.now() };
                }
            });
            saveHistory(__dir);
            return sendJson(res, 200, { runId: runId, dispatched: dispatched.length, offline: offline.length });
        }

        // ---- Gestionnaire de périphériques ----

        if (action === 'devDetails') {
            const nodeId = String((req.query && req.query.nodeId) || '');
            const instanceId = String((req.query && req.query.instanceId) || '');
            if (!nodeId || !instanceId) return sendJson(res, 400, { error: 'nodeId et instanceId requis' });
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const ws = wsagents[nodeId];
            if (!ws || typeof ws.send !== 'function') return sendJson(res, 503, { error: 'agent offline' });
            const did = 'dd-' + crypto.randomBytes(8).toString('hex');
            pendingDispatches[did] = { kind: 'devDetails', nodeId: nodeId, expires: Date.now() + 90 * 1000 };
            devDetailsWaiters[did] = { res: res, expires: Date.now() + 90 * 1000 };
            try {
                ws.send(JSON.stringify({
                    action: 'plugin', plugin: 'maintctl', pluginaction: 'devDetails',
                    dispatchId: did, instanceId: instanceId
                }));
            } catch (e) {
                delete pendingDispatches[did];
                delete devDetailsWaiters[did];
                return sendJson(res, 500, { error: 'dispatch failed: ' + e.message });
            }
            setTimeout(() => {
                const w = devDetailsWaiters[did];
                if (!w) return;
                delete devDetailsWaiters[did];
                delete pendingDispatches[did];
                try {
                    w.res.setHeader('Content-Type', 'application/json');
                    w.res.end(JSON.stringify({ ok: false, error: 'agent timeout (90s)' }));
                } catch (_) {}
            }, 90 * 1000);
            return;
        }

        if (action === 'devAction') {
            const nodeId = String((req.query && req.query.nodeId) || '');
            const instanceId = String((req.query && req.query.instanceId) || '');
            const devAction = String((req.query && req.query.devAction) || '');
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            if (['scan','enable','disable','remove'].indexOf(devAction) < 0) return sendJson(res, 400, { error: 'devAction invalide' });
            if (devAction !== 'scan' && !instanceId) return sendJson(res, 400, { error: 'instanceId requis' });
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const ws = wsagents[nodeId];
            if (!ws || typeof ws.send !== 'function') return sendJson(res, 503, { error: 'agent offline' });
            const did = 'da-' + crypto.randomBytes(8).toString('hex');
            pendingDispatches[did] = { kind: 'devAction', nodeId: nodeId, expires: Date.now() + 120 * 1000 };
            devActionWaiters[did] = { res: res, expires: Date.now() + 120 * 1000 };
            try {
                ws.send(JSON.stringify({
                    action: 'plugin', plugin: 'maintctl', pluginaction: 'devAction',
                    dispatchId: did, instanceId: instanceId, devAction: devAction
                }));
            } catch (e) {
                delete pendingDispatches[did];
                delete devActionWaiters[did];
                return sendJson(res, 500, { error: 'dispatch failed: ' + e.message });
            }
            // Invalide le cache devList du poste pour qu'un rafraîchissement
            // après l'action remonte l'état nouveau.
            delete devCache[nodeId];
            setTimeout(() => {
                const w = devActionWaiters[did];
                if (!w) return;
                delete devActionWaiters[did];
                delete pendingDispatches[did];
                try {
                    w.res.setHeader('Content-Type', 'application/json');
                    w.res.end(JSON.stringify({ ok: false, error: 'agent timeout (120s)' }));
                } catch (_) {}
            }, 120 * 1000);
            return;
        }

        if (action === 'devList') {
            // ?nodeId=...&force=1
            const nodeId = String((req.query && req.query.nodeId) || '');
            const force = String((req.query && req.query.force) || '') === '1';
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            const cached = devCache[nodeId];
            if (!force && cached && (Date.now() - cached.lastCheck) < DEV_TTL_MS) {
                return sendJson(res, 200, {
                    ok: cached.ok, error: cached.error || undefined,
                    devices: cached.devices, cached: true, lastCheck: cached.lastCheck
                });
            }
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const ws = wsagents[nodeId];
            if (!ws || typeof ws.send !== 'function') {
                return sendJson(res, 503, { error: 'agent offline' });
            }
            const did = 'dev-' + crypto.randomBytes(8).toString('hex');
            pendingDispatches[did] = { kind: 'devList', nodeId: nodeId, expires: Date.now() + 2 * 60 * 1000 };
            devPendingWaiters[did] = { res: res, expires: Date.now() + 90 * 1000 };
            try {
                ws.send(JSON.stringify({
                    action: 'plugin', plugin: 'maintctl', pluginaction: 'devList',
                    dispatchId: did
                }));
            } catch (e) {
                delete pendingDispatches[did];
                delete devPendingWaiters[did];
                return sendJson(res, 500, { error: 'dispatch failed: ' + e.message });
            }
            // Timeout : si pas de réponse dans 150s
            setTimeout(() => {
                const w = devPendingWaiters[did];
                if (!w) return;
                delete devPendingWaiters[did];
                delete pendingDispatches[did];
                try {
                    w.res.setHeader('Content-Type', 'application/json');
                    w.res.end(JSON.stringify({ ok: false, error: 'agent timeout (150s) — agent peut-être sur ancienne version (restart MeshAgent service ?), ou Get-PnpDevice trop lent' }));
                } catch (_) {}
            }, 150 * 1000);
            return;
        }

        if (action === 'eventList') {
            // ?nodeId=...&days=7&force=1
            const nodeId = String((req.query && req.query.nodeId) || '');
            const days = Math.max(1, Math.min(30, parseInt((req.query && req.query.days) || '7', 10) || 7));
            const force = String((req.query && req.query.force) || '') === '1';
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            const cached = evtCache[nodeId];
            if (!force && cached && (Date.now() - cached.lastCheck) < EVT_TTL_MS) {
                return sendJson(res, 200, {
                    ok: cached.ok, error: cached.error || undefined,
                    events: cached.events, summary: cached.summary,
                    cached: true, lastCheck: cached.lastCheck
                });
            }
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const ws = wsagents[nodeId];
            if (!ws || typeof ws.send !== 'function') return sendJson(res, 503, { error: 'agent offline' });
            const did = 'evt-' + crypto.randomBytes(8).toString('hex');
            pendingDispatches[did] = { kind: 'eventList', nodeId: nodeId, expires: Date.now() + 3 * 60 * 1000 };
            evtWaiters[did] = { res: res, expires: Date.now() + 3 * 60 * 1000 };
            try {
                ws.send(JSON.stringify({
                    action: 'plugin', plugin: 'maintctl', pluginaction: 'eventList',
                    dispatchId: did, days: days
                }));
            } catch (e) {
                delete pendingDispatches[did];
                delete evtWaiters[did];
                return sendJson(res, 500, { error: 'dispatch failed: ' + e.message });
            }
            setTimeout(() => {
                const w = evtWaiters[did];
                if (!w) return;
                delete evtWaiters[did];
                delete pendingDispatches[did];
                try {
                    w.res.setHeader('Content-Type', 'application/json');
                    w.res.end(JSON.stringify({ ok: false, error: 'agent timeout (180s) — agent peut-être sur ancienne version (restart MeshAgent ?)' }));
                } catch (_) {}
            }, 180 * 1000);
            return;
        }

        // ---- Registre (ex-regctl, intégré) ----

        if (action === 'regTemplates') {
            // Fusionne les modèles "builtin" (regkey-templates.json livré avec
            // le plugin) avec les modèles "custom" sauvés par l'utilisateur
            // (regkey-templates-custom.json — préservé entre màj plugin).
            const builtinPath = path.join(__dirname, 'regkey-templates.json');
            const customPath = path.join(__dirname, 'regkey-templates-custom.json');
            let builtin = { categories: [] };
            let custom = { categories: [] };
            try { builtin = JSON.parse(fs.readFileSync(builtinPath, 'utf8')); } catch (e) {}
            try { custom = JSON.parse(fs.readFileSync(customPath, 'utf8')); } catch (e) {}
            // Tague les templates pour que l'UI puisse afficher edit/delete uniquement sur les customs
            (builtin.categories || []).forEach((c) => (c.templates || []).forEach((t) => { t.builtin = true; }));
            (custom.categories || []).forEach((c) => (c.templates || []).forEach((t) => { t.builtin = false; }));
            // Merge par nom de catégorie
            const out = { categories: [] };
            const byName = {};
            (builtin.categories || []).forEach((c) => { byName[c.name] = { name: c.name, templates: (c.templates || []).slice() }; out.categories.push(byName[c.name]); });
            (custom.categories || []).forEach((c) => {
                if (byName[c.name]) byName[c.name].templates = byName[c.name].templates.concat(c.templates || []);
                else { byName[c.name] = { name: c.name, templates: (c.templates || []).slice() }; out.categories.push(byName[c.name]); }
            });
            return sendJson(res, 200, out);
        }

        if (action === 'regTemplateSave') {
            let body = {};
            try { body = JSON.parse((req.query && req.query.payload) || '{}'); }
            catch (e) { return sendJson(res, 400, { error: 'payload JSON invalide' }); }
            const name = String(body.name || '').trim();
            const category = String(body.category || 'Personnalisés').trim() || 'Personnalisés';
            const description = String(body.description || '').trim();
            const id = String(body.id || '').trim();
            const ops = Array.isArray(body.ops) ? body.ops : null;
            if (!name) return sendJson(res, 400, { error: 'name requis' });
            if (!ops || !ops.length) return sendJson(res, 400, { error: 'au moins une op requise' });
            const validOps = ['writeValue', 'deleteValue', 'createKey', 'deleteKey'];
            for (let i = 0; i < ops.length; i++) {
                const o = ops[i];
                if (!o || validOps.indexOf(o.op) < 0) return sendJson(res, 400, { error: 'op invalide #' + (i + 1) + ': ' + (o && o.op) });
                if (!o.path) return sendJson(res, 400, { error: 'path manquant op #' + (i + 1) });
                if ((o.op === 'writeValue' || o.op === 'deleteValue') && o.name === undefined) {
                    return sendJson(res, 400, { error: 'name manquant op #' + (i + 1) });
                }
                if (o.op === 'writeValue' && (!o.type || o.data === undefined)) {
                    return sendJson(res, 400, { error: 'type/data manquants op #' + (i + 1) });
                }
            }
            const customPath = path.join(__dirname, 'regkey-templates-custom.json');
            let custom = { categories: [] };
            try { custom = JSON.parse(fs.readFileSync(customPath, 'utf8')); } catch (e) {}
            // Génère un id si nouveau
            const tplId = id || ('custom-' + crypto.randomBytes(6).toString('hex'));
            const newTpl = { id: tplId, name: name, description: description, ops: ops };
            // Retire l'ancien (par id) puis insère dans la bonne catégorie
            (custom.categories || []).forEach((c) => {
                c.templates = (c.templates || []).filter((t) => t.id !== tplId);
            });
            let cat = (custom.categories || []).find((c) => c.name === category);
            if (!cat) { cat = { name: category, templates: [] }; (custom.categories = custom.categories || []).push(cat); }
            cat.templates.push(newTpl);
            // Nettoie les catégories vides
            custom.categories = (custom.categories || []).filter((c) => (c.templates || []).length);
            try {
                fs.writeFileSync(customPath, JSON.stringify(custom, null, 2));
            } catch (e) {
                return sendJson(res, 500, { error: 'écriture: ' + e.message });
            }
            return sendJson(res, 200, { ok: true, id: tplId });
        }

        if (action === 'regTemplateDelete') {
            const id = String((req.query && req.query.id) || '');
            if (!id) return sendJson(res, 400, { error: 'id requis' });
            const customPath = path.join(__dirname, 'regkey-templates-custom.json');
            let custom = { categories: [] };
            try { custom = JSON.parse(fs.readFileSync(customPath, 'utf8')); } catch (e) {}
            let found = false;
            (custom.categories || []).forEach((c) => {
                const before = (c.templates || []).length;
                c.templates = (c.templates || []).filter((t) => t.id !== id);
                if (c.templates.length !== before) found = true;
            });
            if (!found) return sendJson(res, 404, { error: 'modèle introuvable (ou builtin non supprimable)' });
            custom.categories = (custom.categories || []).filter((c) => (c.templates || []).length);
            try {
                fs.writeFileSync(customPath, JSON.stringify(custom, null, 2));
            } catch (e) {
                return sendJson(res, 500, { error: 'écriture: ' + e.message });
            }
            return sendJson(res, 200, { ok: true });
        }

        const regOpMap = {
            regEnumKeys:    { needs: ['nodeId', 'path'] },
            regEnumValues:  { needs: ['nodeId', 'path'] },
            regReadValue:   { needs: ['nodeId', 'path', 'name'] },
            regWriteValue:  { needs: ['nodeId', 'path', 'name', 'type', 'data'] },
            regDeleteValue: { needs: ['nodeId', 'path', 'name'] },
            regDeleteKey:   { needs: ['nodeId', 'path'] },
            regCreateKey:   { needs: ['nodeId', 'path'] },
        };

        if (regOpMap[action]) {
            let payload = {};
            try { payload = JSON.parse((req.query && req.query.payload) || '{}'); }
            catch (e) { return sendJson(res, 400, { error: 'payload JSON invalide' }); }
            const op = regOpMap[action];
            for (let i = 0; i < op.needs.length; i++) {
                const k = op.needs[i];
                if (payload[k] === undefined || payload[k] === null || payload[k] === '') {
                    // name peut légitimement être '' (valeur par défaut)
                    if (k === 'name') continue;
                    return sendJson(res, 400, { error: 'paramètre manquant: ' + k });
                }
            }
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const ws = wsagents[payload.nodeId];
            if (!ws || typeof ws.send !== 'function') {
                return sendJson(res, 200, { ok: false, error: 'agent déconnecté' });
            }
            const dispatchId = crypto.randomBytes(12).toString('hex');
            regPending[dispatchId] = true;
            const message = Object.assign({
                action: 'plugin', plugin: 'maintctl',
                pluginaction: action,
                dispatchId: dispatchId,
            }, payload);
            try {
                ws.send(JSON.stringify(message));
                return sendJson(res, 200, { ok: true, dispatchId: dispatchId });
            } catch (e) {
                delete regPending[dispatchId];
                return sendJson(res, 200, { ok: false, error: e.message });
            }
        }

        if (action === 'regPollResult') {
            const id = String((req.query && req.query.dispatchId) || '');
            if (!id) return sendJson(res, 400, { error: 'dispatchId requis' });
            if (regResults[id]) {
                const r = regResults[id];
                delete regResults[id];
                return sendJson(res, 200, { ready: true, result: r });
            }
            if (!regPending[id]) {
                return sendJson(res, 200, { ready: false, unknown: true });
            }
            if (!regWaiters[id]) regWaiters[id] = [];
            const waiter = { res: res, timer: null };
            regWaiters[id].push(waiter);
            waiter.timer = setTimeout(() => {
                const arr = regWaiters[id] || [];
                const i = arr.indexOf(waiter);
                if (i !== -1) arr.splice(i, 1);
                try {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ready: false }));
                } catch (e) {}
            }, 25000);
            return;
        }

        // UI shell
        try {
            const tmpl = fs.readFileSync(path.join(__dirname, 'views', 'maintctl.handlebars'), 'utf8');
            res.set('Content-Type', 'text/html; charset=utf-8').send(tmpl);
        } catch (e) {
            res.status(500).set('Content-Type', 'text/plain').send('maintctl: vue introuvable: ' + e.message);
        }
    };

    return obj;
};

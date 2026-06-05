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

const pendingDispatches = {};      // dispatchId -> { kind, runId|nodeId, expires }
const downloadTokens = {};         // token -> { kind, payload, expires }
const DRIVERS_DIR = path.join(__dirname, 'drivers');
const serverState = { baseUrl: '' };
const runs = {};                   // runId -> run cleanup
const devCache = {};               // nodeId -> { devices, lastCheck }
const devPendingWaiters = {};      // dispatchId -> { res, expires }
const devDetailsWaiters = {};      // dispatchId -> { res, expires }
const devActionWaiters = {};       // dispatchId -> { res, expires }

const AGENT_TYPE = {
    1: 'Windows', 2: 'Windows', 3: 'Windows', 4: 'Windows', 5: 'Windows',
    6: 'Linux', 9: 'Linux', 13: 'Linux', 25: 'Linux',
    7: 'macOS', 16: 'macOS', 29: 'macOS',
    11: 'Android', 12: 'iOS',
};

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
            db.GetAllType('node', function (err, docs) {
                if (err) return cb(err);
                const agents = (docs || []).filter((d) => d && d._id && (d.agent || d.osdesc)).map((d) => {
                    const family = (d.agent && AGENT_TYPE[d.agent.id]) || '';
                    return {
                        id: d._id,
                        name: d.name || d.host || d._id,
                        meshid: d.meshid || '',
                        mesh: meshById[d.meshid] || '',
                        os: d.osdesc || family || '?',
                        family: family,
                        online: !!wsagents[d._id],
                    };
                });
                agents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                const meshes = Object.keys(meshById).map((id) => ({ id: id, name: meshById[id] }));
                meshes.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                cb(null, agents, meshes);
            });
        });
    }

    obj.serveraction = function (command) {
        try {
            if (!command) return;
            if (command.pluginaction === 'pong') return;

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
                const file = (entry.payload && entry.payload.file) || '';
                // Sécurité : nom de fichier strict, .zip uniquement, pas de path traversal.
                if (!/^[a-zA-Z0-9._-]+\.zip$/.test(file)) {
                    return res.status(400).set('Content-Type', 'text/plain').send('invalid file');
                }
                const full = path.join(DRIVERS_DIR, file);
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
        console.log('maintctl: endpoint /maintctl-download/delprof2/:token enregistré');
        console.log('maintctl: endpoint /maintctl-download/driver/:token enregistré (dir: ' + DRIVERS_DIR + ')');
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

        if (action === 'agents') {
            return listAgents(function (err, agents, meshes) {
                if (err) return sendJson(res, 500, { error: err.message });
                sendJson(res, 200, { agents: agents, meshes: meshes || [] });
            });
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
            return sendJson(res, 200, run);
        }

        // ---- Bibliothèque de drivers ----

        if (action === 'driverList') {
            try {
                if (!fs.existsSync(DRIVERS_DIR)) {
                    try { fs.mkdirSync(DRIVERS_DIR, { recursive: true }); } catch (_) {}
                }
                const drivers = fs.readdirSync(DRIVERS_DIR)
                    .filter((f) => /^[a-zA-Z0-9._-]+\.zip$/.test(f))
                    .map((f) => {
                        let st = null;
                        try { st = fs.statSync(path.join(DRIVERS_DIR, f)); } catch (_) {}
                        return { name: f, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
                    })
                    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
                return sendJson(res, 200, { drivers: drivers, dir: DRIVERS_DIR });
            } catch (e) { return sendJson(res, 500, { error: e.message }); }
        }

        if (action === 'driverInstall') {
            let body = {};
            try { body = JSON.parse((req.query && req.query.payload) || '{}'); }
            catch (e) { return sendJson(res, 400, { error: 'payload JSON invalide' }); }
            const nodes = Array.isArray(body.nodes) ? body.nodes.filter((n) => typeof n === 'string') : [];
            const driver = String(body.driver || '');
            if (!nodes.length) return sendJson(res, 400, { error: 'aucun poste sélectionné' });
            if (!/^[a-zA-Z0-9._-]+\.zip$/.test(driver)) return sendJson(res, 400, { error: 'driver invalide' });
            if (!fs.existsSync(path.join(DRIVERS_DIR, driver))) return sendJson(res, 400, { error: 'driver introuvable: ' + driver });
            if (!serverState.baseUrl) return sendJson(res, 500, { error: 'baseUrl pas encore captée — recharge la page admin' });

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
                const url = serverState.baseUrl + '/maintctl-download/driver/' + newDownloadToken('driver', { file: driver });
                try {
                    ws.send(JSON.stringify({
                        action: 'plugin', plugin: 'maintctl', pluginaction: 'driverInstall',
                        dispatchId: did, driver: driver, driverUrl: url
                    }));
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

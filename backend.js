// netlify/functions/api.js
import { getStore } from '@netlify/blobs';

// ─── Constantes ───────────────────────────────────────────────────────────────
const MAX_SNAPSHOTS    = 5000;
const MAX_QUEUE        = 50;
const MAX_LATENCY      = 200;
const HEAP_LIMIT_PCT   = 0.80;
const STALE_DATA_MS    = 60000;

// Nomes das stores (cada uma é um bucket isolado)
const STORE_SNAPSHOTS  = 'snapshots';
const STORE_LATEST     = 'latest';
const STORE_QUEUE      = 'commandQueue';
const STORE_STATS      = 'stats';
const STORE_CIRCUIT    = 'circuitBreaker';
const STORE_LATENCY_LOG = 'latencyLog';
const STORE_LAST_DATA  = 'lastDataAt';

// ─── Utilitários de persistência ──────────────────────────────────────────────
function getStoreClient(name) {
  return getStore(name);
}

// Leitura / escrita de arrays (snapshots, queue, latency)
async function loadArray(storeName, maxItems = null) {
  const store = getStoreClient(storeName);
  const raw = await store.get('data');
  let arr = raw ? JSON.parse(raw) : [];
  if (maxItems && arr.length > maxItems) arr = arr.slice(-maxItems);
  return arr;
}

async function saveArray(storeName, arr, maxItems = null) {
  if (maxItems && arr.length > maxItems) arr = arr.slice(-maxItems);
  const store = getStoreClient(storeName);
  await store.set('data', JSON.stringify(arr));
}

async function pushCapped(storeName, item, max) {
  const arr = await loadArray(storeName, max);
  arr.push(item);
  await saveArray(storeName, arr, max);
}

// Leitura / escrita de objeto simples (latest, stats, circuit)
async function loadObject(storeName) {
  const store = getStoreClient(storeName);
  const raw = await store.get('data');
  return raw ? JSON.parse(raw) : {};
}

async function saveObject(storeName, obj) {
  const store = getStoreClient(storeName);
  await store.set('data', JSON.stringify(obj));
}

// ─── Circuit Breaker persistente ─────────────────────────────────────────────
async function recordCircuitFailure(success) {
  const cb = await loadObject(STORE_CIRCUIT);
  cb.failures = cb.failures || 0;
  cb.state = cb.state || 'CLOSED';
  cb.threshold = cb.threshold || 5;
  cb.timeout = cb.timeout || 30000;
  cb.openedAt = cb.openedAt || 0;

  if (success) {
    cb.failures = 0;
    if (cb.state !== 'CLOSED') {
      console.log(`[CB] ✅ Circuito FECHADO — sistema recuperado`);
      cb.state = 'CLOSED';
    }
  } else {
    cb.failures++;
    if (cb.failures >= cb.threshold && cb.state === 'CLOSED') {
      cb.state = 'OPEN';
      cb.openedAt = Date.now();
      console.error(`[CB] ⚡ Circuito ABERTO após ${cb.failures} falhas`);
      // incrementa watchdog alerts via stats
      const stats = await loadObject(STORE_STATS);
      stats.watchdog_alerts = (stats.watchdog_alerts || 0) + 1;
      await saveObject(STORE_STATS, stats);
    }
  }
  await saveObject(STORE_CIRCUIT, cb);
  return cb;
}

async function canCircuitRequest() {
  const cb = await loadObject(STORE_CIRCUIT);
  const state = cb.state || 'CLOSED';
  const openedAt = cb.openedAt || 0;
  const timeout = cb.timeout || 30000;

  if (state === 'CLOSED') return true;
  if (state === 'OPEN') {
    if (Date.now() - openedAt >= timeout) {
      cb.state = 'HALF_OPEN';
      await saveObject(STORE_CIRCUIT, cb);
      console.log('[CB] 🟡 Circuito HALF-OPEN — testando recuperação');
      return true;
    }
    return false;
  }
  return true; // HALF_OPEN
}

// ─── Helpers de resposta ────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  };
}

function sendJSON(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
    body: JSON.stringify(body, null, 0),
  };
}

function now() { return new Date().toISOString(); }

// ─── Handlers dos endpoints (adaptados para async com blob) ─────────────────
async function handlePostData(body) {
  if (typeof body !== 'object') throw new Error('Payload inválido');
  body._received_at = now();
  await saveObject(STORE_LATEST, body);
  await pushCapped(STORE_SNAPSHOTS, body, MAX_SNAPSHOTS);
  await saveObject(STORE_LAST_DATA, { ts: Date.now() });
  await recordCircuitFailure(true);
  return { ok: true, stored: (await loadArray(STORE_SNAPSHOTS)).length };
}

async function handlePostCommand(body) {
  if (!body.action) throw new Error('Campo action obrigatório');
  body._queued_at = now();
  await pushCapped(STORE_QUEUE, body, MAX_QUEUE);

  const stats = await loadObject(STORE_STATS);
  stats.total_commands = (stats.total_commands || 0) + 1;
  if (body.action === 'CALL') stats.calls_sent = (stats.calls_sent || 0) + 1;
  if (body.action === 'PUT') stats.puts_sent = (stats.puts_sent || 0) + 1;
  stats.last_signal = body.action === 'CALL' ? 'COMPRAR (CALL)' : (body.action === 'PUT' ? 'VENDER (PUT)' : stats.last_signal);
  stats.last_score = body.score || 0;
  await saveObject(STORE_STATS, stats);

  const queueLen = (await loadArray(STORE_QUEUE)).length;
  return { ok: true, queued: queueLen };
}

async function handleGetHealth() {
  const latencies = await loadArray(STORE_LATENCY_LOG);
  const lats = latencies.map(l => l.ms);
  const avg = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
  const max = lats.length ? Math.max(...lats) : 0;
  const mem = process.memoryUsage();
  const lastData = await loadObject(STORE_LAST_DATA);
  const stale = lastData.ts ? (Date.now() - lastData.ts) : null;
  const stats = await loadObject(STORE_STATS);
  const cb = await loadObject(STORE_CIRCUIT);

  return {
    status: 'online',
    snapshots: (await loadArray(STORE_SNAPSHOTS)).length,
    pending_commands: (await loadArray(STORE_QUEUE)).length,
    time: now(),
    latency_avg_ms: +avg.toFixed(2),
    latency_max_ms: +max.toFixed(2),
    uptime_since: stats.start_time || now(),
    circuit_breaker: cb.state || 'CLOSED',
    heap_used_pct: +((mem.heapUsed / mem.heapTotal) * 100).toFixed(1),
    data_stale_ms: stale,
    data_fresh: stale !== null ? stale < STALE_DATA_MS : null,
    auto_cleanups: stats.auto_cleanups || 0,
    watchdog_alerts: stats.watchdog_alerts || 0,
  };
}

async function handleGetLatest() {
  const latest = await loadObject(STORE_LATEST);
  return Object.keys(latest).length ? latest : { error: 'sem dados ainda' };
}

async function handleGetHistory(limit = 200) {
  const limitNum = Math.min(parseInt(limit, 10) || 200, 2000);
  const snaps = await loadArray(STORE_SNAPSHOTS);
  return snaps.slice(-limitNum);
}

async function handleGetCommand() {
  const queue = await loadArray(STORE_QUEUE);
  if (queue.length) {
    const cmd = queue.shift();
    await saveArray(STORE_QUEUE, queue, MAX_QUEUE);
    return { ok: true, command: cmd };
  }
  return { ok: true, command: null };
}

async function handlePostRepair() {
  // Reseta circuit breaker
  await saveObject(STORE_CIRCUIT, { failures: 0, state: 'CLOSED', threshold: 5, timeout: 30000, openedAt: 0 });
  // Limpa fila de comandos
  await saveArray(STORE_QUEUE, [], MAX_QUEUE);
  // Reseta contagem de alertas nas stats
  const stats = await loadObject(STORE_STATS);
  stats.watchdog_alerts = 0;
  await saveObject(STORE_STATS, stats);
  console.log('[REPAIR] ♻️ Auto-reparo executado via /api/repair');
  return { ok: true, repaired: true };
}

async function handleGetDashboard() {
  const latencies = await loadArray(STORE_LATENCY_LOG);
  const lats = latencies.map(l => l.ms);
  const avg = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
  const mx = lats.length ? Math.max(...lats) : 0;
  const mem = process.memoryUsage();
  const lastData = await loadObject(STORE_LAST_DATA);
  const stale = lastData.ts ? (Date.now() - lastData.ts) : null;
  const stats = await loadObject(STORE_STATS);
  const cb = await loadObject(STORE_CIRCUIT);
  const latest = await loadObject(STORE_LATEST);
  const queue = await loadArray(STORE_QUEUE);

  return {
    api_status: 'online',
    snapshots: (await loadArray(STORE_SNAPSHOTS)).length,
    pending_commands: queue.length,
    stats: {
      total_commands: stats.total_commands || 0,
      calls_sent: stats.calls_sent || 0,
      puts_sent: stats.puts_sent || 0,
      start_time: stats.start_time || now(),
      last_signal: stats.last_signal || 'AGUARDAR',
      last_score: stats.last_score || 0,
      auto_cleanups: stats.auto_cleanups || 0,
      watchdog_alerts: stats.watchdog_alerts || 0,
      total_requests: stats.total_requests || 0,
      errors_caught: stats.errors_caught || 0,
    },
    latency: {
      avg_ms: +avg.toFixed(2),
      max_ms: +mx.toFixed(2),
      last_ms: lats.length ? lats[lats.length - 1] : 0,
      history: latencies.slice(-50),
    },
    latest_data: latest,
    uptime_since: stats.start_time || now(),
    circuit_breaker: cb.state || 'CLOSED',
    heap_used_pct: +((mem.heapUsed / mem.heapTotal) * 100).toFixed(1),
    data_stale_ms: stale,
    data_fresh: stale !== null ? stale < STALE_DATA_MS : null,
  };
}

// ─── Entrypoint Netlify Function ─────────────────────────────────────────────
export async function handler(event, context) {
  const start = process.hrtime.bigint();
  const method = event.httpMethod;
  const path = event.path.replace(/^\/\.netlify\/functions\/api/, ''); // normaliza path
  const headers = event.headers;

  // Atualiza contador de requisições (stats)
  const stats = await loadObject(STORE_STATS);
  stats.total_requests = (stats.total_requests || 0) + 1;
  if (!stats.start_time) stats.start_time = now();
  await saveObject(STORE_STATS, stats);

  // Preflight CORS
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
  }

  // Circuit breaker check
  const canReq = await canCircuitRequest();
  if (!canReq) {
    const cb = await loadObject(STORE_CIRCUIT);
    const retryAfter = (cb.timeout || 30000) - (Date.now() - (cb.openedAt || 0));
    return sendJSON(503, {
      ok: false,
      error: 'Circuito aberto — servidor em modo de proteção. Aguarde.',
      retry_after_ms: retryAfter,
    });
  }

  let result;
  let success = true;
  try {
    const body = event.body ? JSON.parse(event.body) : {};

    // Roteamento
    if (method === 'POST' && path === '/api/data') {
      result = await handlePostData(body);
    } else if (method === 'POST' && path === '/api/command') {
      result = await handlePostCommand(body);
    } else if (method === 'GET' && path === '/api/health') {
      result = await handleGetHealth();
    } else if (method === 'GET' && path === '/api/latest') {
      result = await handleGetLatest();
    } else if (method === 'GET' && path === '/api/history') {
      const limit = event.queryStringParameters?.limit || '200';
      result = await handleGetHistory(limit);
    } else if (method === 'GET' && path === '/api/command') {
      result = await handleGetCommand();
    } else if (method === 'POST' && path === '/api/repair') {
      result = await handlePostRepair();
    } else if (method === 'GET' && path === '/api/dashboard') {
      result = await handleGetDashboard();
    } else {
      return sendJSON(404, {
        error: 'endpoint desconhecido',
        endpoints: [
          'POST /api/data', 'GET /api/latest', 'GET /api/history',
          'GET /api/health', 'POST /api/command', 'GET /api/command',
          'GET /api/dashboard', 'POST /api/repair',
        ],
      });
    }

    await recordCircuitFailure(true);
  } catch (err) {
    success = false;
    await recordCircuitFailure(false);
    const statsErr = await loadObject(STORE_STATS);
    statsErr.errors_caught = (statsErr.errors_caught || 0) + 1;
    await saveObject(STORE_STATS, statsErr);
    console.error(`[ERR] ${method} ${path} → ${err.message}`);
    return sendJSON(400, { ok: false, error: err.message, ts: now() });
  }

  // Registra latência
  const ns = process.hrtime.bigint() - start;
  const ms = Number(ns) / 1e6;
  await pushCapped(STORE_LATENCY_LOG, { ms: +ms.toFixed(2), ts: now() }, MAX_LATENCY);

  // Verificação de heap e limpeza automática (a cada request, mas limitado)
  const mem = process.memoryUsage();
  if (mem.heapUsed / mem.heapTotal > HEAP_LIMIT_PCT) {
    const snaps = await loadArray(STORE_SNAPSHOTS);
    if (snaps.length > 500) {
      await saveArray(STORE_SNAPSHOTS, snaps.slice(-500), MAX_SNAPSHOTS);
      const statsCl = await loadObject(STORE_STATS);
      statsCl.auto_cleanups = (statsCl.auto_cleanups || 0) + 1;
      await saveObject(STORE_STATS, statsCl);
      console.warn(`[WD] ⚠️ Heap alto — limpei snapshots`);
    }
  }

  // Verifica stale data
  const lastData = await loadObject(STORE_LAST_DATA);
  if (lastData.ts && (Date.now() - lastData.ts) > STALE_DATA_MS) {
    console.warn(`[WD] ⚠️ Sem dados do bot há muito tempo`);
    const statsStale = await loadObject(STORE_STATS);
    statsStale.watchdog_alerts = (statsStale.watchdog_alerts || 0) + 1;
    await saveObject(STORE_STATS, statsStale);
  }

  return sendJSON(200, result);
}

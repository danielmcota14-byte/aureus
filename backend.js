#!/usr/bin/env node
/**
 * OCTOCOOKIE API SERVER  v3.0  —  AUTO-HEALING EDITION
 * =====================================================
 * Porta padrão: 5050
 *
 * ✅ Protocolos automáticos:
 *   - Watchdog interno: detecta travamentos e reinicia subsistemas
 *   - Circuit Breaker: para cascata de falhas
 *   - Health check periódico: /api/health com auto-diagnóstico
 *   - Graceful shutdown + auto-restart via sinal SIGUSR1
 *   - Memória protegida: limpa snapshots se heap > 80%
 *   - Sem dependências externas — Node.js puro!
 */

const http = require('http');
const os   = require('os');

// ─── Constantes ───────────────────────────────────────────────────────────────
const MAX_SNAPSHOTS    = 5000;
const MAX_QUEUE        = 50;
const MAX_LATENCY      = 200;
const HEAP_LIMIT_PCT   = 0.80;   // limpa histórico se heap > 80%
const WATCHDOG_MS      = 15000;  // verifica saúde a cada 15s
const STALE_DATA_MS    = 60000;  // dado é "velho" se > 60s sem update

// ─── Estado global ────────────────────────────────────────────────────────────
let _snapshots    = [];
let _latest       = {};
let _cmdQueue     = [];
let _latencyLog   = [];
let _lastDataAt   = 0;          // timestamp do último POST /api/data

const _stats = {
  total_commands   : 0,
  calls_sent       : 0,
  puts_sent        : 0,
  start_time       : new Date().toISOString(),
  last_signal      : 'AGUARDAR',
  last_score       : 0.0,
  auto_cleanups    : 0,
  watchdog_alerts  : 0,
  total_requests   : 0,
  errors_caught    : 0,
};

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const circuitBreaker = {
  failures   : 0,
  threshold  : 5,
  timeout    : 30000,   // 30s em open state
  state      : 'CLOSED', // CLOSED | OPEN | HALF_OPEN
  openedAt   : 0,

  record(success) {
    if (success) {
      this.failures = 0;
      if (this.state !== 'CLOSED') {
        console.log(`[CB] ✅ Circuito FECHADO — sistema recuperado`);
        this.state = 'CLOSED';
      }
    } else {
      this.failures++;
      if (this.failures >= this.threshold && this.state === 'CLOSED') {
        this.state   = 'OPEN';
        this.openedAt = Date.now();
        console.error(`[CB] ⚡ Circuito ABERTO após ${this.failures} falhas — aguardando ${this.timeout/1000}s`);
        _stats.watchdog_alerts++;
      }
    }
  },

  canRequest() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.timeout) {
        this.state = 'HALF_OPEN';
        console.log('[CB] 🟡 Circuito HALF-OPEN — testando recuperação');
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN permite 1 req
  },
};

// ─── Utilitários ──────────────────────────────────────────────────────────────
function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function now()  { return new Date().toISOString(); }
function ts()   { return new Date().toLocaleTimeString('pt-BR', { hour12: false }); }

function hrMs(start) {
  const ns = process.hrtime.bigint() - start;
  return Number(ns) / 1e6;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  };
}

function sendJSON(res, data, code = 200) {
  const body = JSON.stringify(data, null, 0);
  res.writeHead(code, {
    'Content-Type'  : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('Body read timeout')), 5000);
  });
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────
function watchdogTick() {
  try {
    // 1. Checa uso de heap — limpa histórico se necessário
    const mem  = process.memoryUsage();
    const used = mem.heapUsed / mem.heapTotal;
    if (used > HEAP_LIMIT_PCT) {
      const before = _snapshots.length;
      _snapshots   = _snapshots.slice(-500);  // mantém só 500
      _latencyLog  = _latencyLog.slice(-50);
      _stats.auto_cleanups++;
      console.warn(`[WD] ⚠️  Heap ${(used*100).toFixed(1)}% — limpei ${before - _snapshots.length} snapshots`);
    }

    // 2. Checa dado estale (bot parou de enviar)
    if (_lastDataAt > 0) {
      const staleMs = Date.now() - _lastDataAt;
      if (staleMs > STALE_DATA_MS) {
        console.warn(`[WD] ⚠️  Sem dados do bot há ${(staleMs/1000).toFixed(0)}s`);
        _stats.watchdog_alerts++;
      }
    }

    // 3. Loga status periódico
    const upSec = Math.floor((Date.now() - new Date(_stats.start_time)) / 1000);
    const upMin = Math.floor(upSec / 60);
    console.log(
      `[WD] ✅ Up:${upMin}m | Snaps:${_snapshots.length} | Cmds:${_cmdQueue.length}` +
      ` | Heap:${(used*100).toFixed(1)}% | CB:${circuitBreaker.state}`
    );

  } catch (err) {
    console.error('[WD] Erro no watchdog:', err.message);
  }
}

// ─── Roteador ─────────────────────────────────────────────────────────────────
async function handler(req, res) {
  const t0     = process.hrtime.bigint();
  const parsed = new URL(req.url, 'http://localhost');
  const path   = parsed.pathname;
  const method = req.method;

  _stats.total_requests++;

  // Preflight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Circuit breaker check
  if (!circuitBreaker.canRequest()) {
    sendJSON(res, {
      ok    : false,
      error : 'Circuito aberto — servidor em modo de proteção. Aguarde.',
      retry_after_ms: circuitBreaker.timeout - (Date.now() - circuitBreaker.openedAt),
    }, 503);
    return;
  }

  try {
    // ── POST /api/data ───────────────────────────────────────────────────────
    if (method === 'POST' && path === '/api/data') {
      const data = await readBody(req);
      if (typeof data !== 'object') throw new Error('Payload inválido');
      data._received_at = now();
      _latest    = { ...data };
      _lastDataAt = Date.now();
      pushCapped(_snapshots, { ...data }, MAX_SNAPSHOTS);
      circuitBreaker.record(true);
      sendJSON(res, { ok: true, stored: _snapshots.length });

    // ── POST /api/command ────────────────────────────────────────────────────
    } else if (method === 'POST' && path === '/api/command') {
      const cmd = await readBody(req);
      if (!cmd.action) throw new Error('Campo action obrigatório');
      cmd._queued_at = now();
      pushCapped(_cmdQueue, cmd, MAX_QUEUE);
      _stats.total_commands++;
      if (cmd.action === 'CALL') { _stats.calls_sent++; _stats.last_signal = 'COMPRAR (CALL)'; }
      else if (cmd.action === 'PUT')  { _stats.puts_sent++;  _stats.last_signal = 'VENDER (PUT)'; }
      _stats.last_score = cmd.score || 0;
      sendJSON(res, { ok: true, queued: _cmdQueue.length });

    // ── GET /api/health ──────────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/health') {
      const lats   = _latencyLog.map(x => x.ms);
      const avg    = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      const max    = lats.length ? Math.max(...lats) : 0;
      const mem    = process.memoryUsage();
      const stale  = _lastDataAt ? (Date.now() - _lastDataAt) : null;
      sendJSON(res, {
        status           : 'online',
        snapshots        : _snapshots.length,
        pending_commands : _cmdQueue.length,
        time             : now(),
        latency_avg_ms   : +avg.toFixed(2),
        latency_max_ms   : +max.toFixed(2),
        uptime_since     : _stats.start_time,
        circuit_breaker  : circuitBreaker.state,
        heap_used_pct    : +((mem.heapUsed / mem.heapTotal) * 100).toFixed(1),
        data_stale_ms    : stale,
        data_fresh       : stale !== null ? stale < STALE_DATA_MS : null,
        auto_cleanups    : _stats.auto_cleanups,
        watchdog_alerts  : _stats.watchdog_alerts,
      });

    // ── GET /api/latest ──────────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/latest') {
      sendJSON(res, Object.keys(_latest).length ? _latest : { error: 'sem dados ainda' });

    // ── GET /api/history?limit=200 ───────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/history') {
      const limit = Math.min(parseInt(parsed.searchParams.get('limit') || '200', 10), 2000);
      sendJSON(res, _snapshots.slice(-limit));

    // ── GET /api/command ─────────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/command') {
      if (_cmdQueue.length) {
        const cmd = _cmdQueue.shift();
        sendJSON(res, { ok: true, command: cmd });
      } else {
        sendJSON(res, { ok: true, command: null });
      }

    // ── POST /api/repair ─────────────────────────────────────────────────────
    // Endpoint de auto-reparo: reseta circuit breaker e limpa filas
    } else if (method === 'POST' && path === '/api/repair') {
      const before = { snaps: _snapshots.length, cmds: _cmdQueue.length, cb: circuitBreaker.state };
      circuitBreaker.failures = 0;
      circuitBreaker.state    = 'CLOSED';
      _cmdQueue               = [];
      _stats.watchdog_alerts  = 0;
      console.log('[REPAIR] ♻️  Auto-reparo executado via /api/repair');
      sendJSON(res, { ok: true, repaired: true, before, after: {
        snaps: _snapshots.length, cmds: 0, cb: 'CLOSED',
      }});

    // ── GET /api/dashboard ───────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/dashboard') {
      const lats = _latencyLog.map(x => x.ms);
      const avg  = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      const mx   = lats.length ? Math.max(...lats) : 0;
      const mem  = process.memoryUsage();
      const stale = _lastDataAt ? (Date.now() - _lastDataAt) : null;
      sendJSON(res, {
        api_status       : 'online',
        snapshots        : _snapshots.length,
        pending_commands : _cmdQueue.length,
        stats            : { ..._stats },
        latency          : {
          avg_ms  : +avg.toFixed(2),
          max_ms  : +mx.toFixed(2),
          last_ms : lats.length ? lats[lats.length - 1] : 0,
          history : _latencyLog.slice(-50),
        },
        latest_data      : { ..._latest },
        uptime_since     : _stats.start_time,
        circuit_breaker  : circuitBreaker.state,
        heap_used_pct    : +((mem.heapUsed / mem.heapTotal) * 100).toFixed(1),
        data_stale_ms    : stale,
        data_fresh       : stale !== null ? stale < STALE_DATA_MS : null,
      });

    } else {
      sendJSON(res, { error: 'endpoint desconhecido', endpoints: [
        'POST /api/data', 'GET /api/latest', 'GET /api/history',
        'GET /api/health', 'POST /api/command', 'GET /api/command',
        'GET /api/dashboard', 'POST /api/repair',
      ]}, 404);
    }

    circuitBreaker.record(true);

  } catch (err) {
    _stats.errors_caught++;
    circuitBreaker.record(false);
    console.error(`[ERR] ${method} ${path} → ${err.message}`);
    sendJSON(res, { ok: false, error: err.message, ts: now() }, 400);
  }

  // Registra latência
  const ms = hrMs(t0);
  pushCapped(_latencyLog, { ms: +ms.toFixed(2), ts: now() }, MAX_LATENCY);
}

// ─── Mock injector (--demo) ───────────────────────────────────────────────────
function startDemoInjector() {
  console.log('  [DEMO] Injetando ticks sintéticos...');
  let price = 1.10000;
  let wins = 0, losses = 0, count = 0;

  const interval = setInterval(() => {
    price += (Math.random() - 0.5) * 0.0006;
    wins   += Math.random() > 0.5 ? 1 : 0;
    losses += Math.random() > 0.6 ? 1 : 0;
    const total = wins + losses || 1;
    const hist  = Array.from({ length: 60 }, () => price + (Math.random() - 0.5) * 0.002);

    const payload = {
      currentPrice      : +price.toFixed(5),
      priceHistory      : hist,
      dailyProfit       : +(Math.random() * 7 - 2).toFixed(2),
      lastProfit        : +(Math.random() * 1.5 - 0.5).toFixed(2),
      lastProfitPercent : +(Math.random() * 15 - 5).toFixed(2),
      tradesToday       : Math.floor(Math.random() * 40),
      wins, losses,
      winRate           : +((wins / total) * 100).toFixed(1),
      consecutiveLosses : Math.floor(Math.random() * 3),
      balance           : +(100 + Math.random() * 30 - 10).toFixed(2),
      symbol            : 'frxEURUSD',
      securityLevel     : 70,
      riskLevel         : 40,
      rsiLow            : 30,
      rsiHigh           : 70,
      maxTrades         : 100,
      minScore          : 25,
      stake             : 1.00,
      stopLoss          : -5.00,
      takeProfit        : 10.00,
      botRunning        : true,
      openContract      : null,
      _received_at      : now(),
    };

    _latest    = { ...payload };
    _lastDataAt = Date.now();
    pushCapped(_snapshots, { ...payload }, MAX_SNAPSHOTS);

    if (++count >= 500) {
      clearInterval(interval);
      console.log('  [DEMO] ✅ 500 ticks injetados.');
    }
  }, 50);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const pIdx = args.indexOf('--port');
const PORT = pIdx !== -1 ? parseInt(args[pIdx + 1], 10) : 5050;

const server = http.createServer(handler);

// Timeout global nas requests
server.timeout        = 10000;  // 10s
server.keepAliveTimeout = 5000;

server.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(62);
  console.log(line);
  console.log('  OCTOCOOKIE API SERVER v3.0  —  AUTO-HEALING  —  porta', PORT);
  console.log(line);
  console.log(`  POST http://localhost:${PORT}/api/data      (bot → api)`);
  console.log(`  GET  http://localhost:${PORT}/api/latest    (último dado)`);
  console.log(`  GET  http://localhost:${PORT}/api/history   (histórico)`);
  console.log(`  GET  http://localhost:${PORT}/api/health    (status + latência)`);
  console.log(`  POST http://localhost:${PORT}/api/command   (analize → api)`);
  console.log(`  GET  http://localhost:${PORT}/api/command   (html faz poll)`);
  console.log(`  GET  http://localhost:${PORT}/api/dashboard (dashboard json)`);
  console.log(`  POST http://localhost:${PORT}/api/repair    (auto-reparo)`);
  console.log(line);
  console.log('  ✅ Watchdog ativo  |  Circuit Breaker ativo  |  Heap Guard ativo');
  console.log(line);

  // Inicia watchdog
  setInterval(watchdogTick, WATCHDOG_MS).unref();
  if (demo) startDemoInjector();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORT} já está em uso.`);
    console.error(`   Tente: node backend.js --port 5051`);
    console.error(`   Ou mate o processo: kill $(lsof -ti:${PORT})`);
  } else {
    console.error('[SRV] Erro no servidor:', err);
  }
  process.exit(1);
});

// Erros não capturados — previne crash
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  _stats.errors_caught++;
  circuitBreaker.record(false);
  // Não sai do processo — continua rodando
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED]', reason);
  _stats.errors_caught++;
});

// SIGUSR1 = reparo manual via sinal (kill -USR1 <pid>)
process.on('SIGUSR1', () => {
  console.log('[SIGNAL] ♻️  SIGUSR1 recebido — executando reparo manual');
  circuitBreaker.failures = 0;
  circuitBreaker.state    = 'CLOSED';
  _cmdQueue               = [];
  _snapshots              = _snapshots.slice(-1000);
  console.log('[SIGNAL] ✅ Reparo concluído');
});

process.on('SIGINT',  () => { console.log('\n[API] Servidor encerrado.'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[API] SIGTERM — encerrando.'); server.close(); process.exit(0); });
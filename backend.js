#!/usr/bin/env node
/**
 * OCTOCOOKIE API SERVER  v2.0  —  Node.js
 * =========================================
 * Porta padrão: 5050
 *
 * Endpoints:
 *   POST /api/data        → recebe payload do bot (HTML → API)
 *   GET  /api/latest      → retorna último snapshot
 *   GET  /api/history     → retorna histórico completo
 *   GET  /api/health      → status da API + latência
 *   POST /api/command     → Python/JS envia comando (CALL / PUT / WAIT)
 *   GET  /api/command     → HTML faz poll e consome o comando pendente
 *   GET  /api/dashboard   → JSON completo para o dashboard web
 *
 * Sem dependências externas — Node.js puro!
 * Uso: node server.js [--demo] [--port 5050]
 */

const http = require('http');
const url  = require('url');

// ─── Estado global ────────────────────────────────────────────────────────────
const MAX_SNAPSHOTS = 5000;
const MAX_QUEUE     = 50;
const MAX_LATENCY   = 200;

let _snapshots    = [];   // histórico de snapshots
let _latest       = {};   // último snapshot recebido
let _cmdQueue     = [];   // fila de comandos CALL/PUT para o HTML
let _latencyLog   = [];   // log de latências em ms

const _stats = {
  total_commands : 0,
  calls_sent     : 0,
  puts_sent      : 0,
  start_time     : new Date().toISOString(),
  last_signal    : 'AGUARDAR',
  last_score     : 0.0,
};

// ─── Utilitários ──────────────────────────────────────────────────────────────
function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function now() {
  return new Date().toISOString();
}

function ts() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

function hrMs(start) {
  const ns = process.hrtime.bigint() - start;
  return Number(ns) / 1e6; // ns → ms (float)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── Roteador ─────────────────────────────────────────────────────────────────
async function handler(req, res) {
  const t0      = process.hrtime.bigint();
  const parsed  = url.parse(req.url, true);
  const path    = parsed.pathname;
  const method  = req.method;

  // Preflight CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    // ── POST /api/data  (bot → API) ──────────────────────────────────────────
    if (method === 'POST' && path === '/api/data') {
      const data = await readBody(req);
      data._received_at = now();
      _latest = { ...data };
      pushCapped(_snapshots, { ...data }, MAX_SNAPSHOTS);
      sendJSON(res, { ok: true, stored: _snapshots.length });

    // ── POST /api/command  (analize → API) ───────────────────────────────────
    } else if (method === 'POST' && path === '/api/command') {
      const cmd = await readBody(req);
      cmd._queued_at = now();
      pushCapped(_cmdQueue, cmd, MAX_QUEUE);
      _stats.total_commands++;
      if (cmd.action === 'CALL') { _stats.calls_sent++; _stats.last_signal = 'COMPRAR (CALL)'; }
      else if (cmd.action === 'PUT') { _stats.puts_sent++; _stats.last_signal = 'VENDER (PUT)'; }
      _stats.last_score = cmd.score || 0;
      sendJSON(res, { ok: true, queued: _cmdQueue.length });

    // ── GET /api/health ───────────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/health') {
      const lats  = _latencyLog.map(x => x.ms);
      const avg   = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      const max   = lats.length ? Math.max(...lats) : 0;
      sendJSON(res, {
        status           : 'online',
        snapshots        : _snapshots.length,
        pending_commands : _cmdQueue.length,
        time             : now(),
        latency_avg_ms   : +avg.toFixed(2),
        latency_max_ms   : +max.toFixed(2),
        uptime_since     : _stats.start_time,
      });

    // ── GET /api/latest ───────────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/latest') {
      sendJSON(res, Object.keys(_latest).length ? _latest : { error: 'sem dados ainda' });

    // ── GET /api/history?limit=200 ────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/history') {
      const limit = parseInt(parsed.query.limit || '200', 10);
      sendJSON(res, _snapshots.slice(-limit));

    // ── GET /api/command  (HTML faz poll) ────────────────────────────────────
    } else if (method === 'GET' && path === '/api/command') {
      if (_cmdQueue.length) {
        const cmd = _cmdQueue.shift();
        sendJSON(res, { ok: true, command: cmd });
      } else {
        sendJSON(res, { ok: true, command: null });
      }

    // ── GET /api/dashboard ───────────────────────────────────────────────────
    } else if (method === 'GET' && path === '/api/dashboard') {
      const lats = _latencyLog.map(x => x.ms);
      const avg  = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      const mx   = lats.length ? Math.max(...lats) : 0;
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
      });

    } else {
      sendJSON(res, { error: 'endpoint desconhecido' }, 404);
    }

  } catch (err) {
    sendJSON(res, { ok: false, error: err.message }, 400);
  }

  // Registra latência
  const ms = hrMs(t0);
  pushCapped(_latencyLog, { ms: +ms.toFixed(2), ts: now() }, MAX_LATENCY);
}

// ─── Mock injector (--demo) ───────────────────────────────────────────────────
function startDemoInjector() {
  console.log('  [DEMO] Injetando 200 ticks sintéticos...');
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

    _latest = { ...payload };
    pushCapped(_snapshots, { ...payload }, MAX_SNAPSHOTS);

    if (++count >= 200) {
      clearInterval(interval);
      console.log('  [DEMO] ✅ 200 ticks injetados.');
    }
  }, 50);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const demo  = args.includes('--demo');
const pIdx  = args.indexOf('--port');
const PORT  = pIdx !== -1 ? parseInt(args[pIdx + 1], 10) : 5050;

const server = http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(58);
  console.log(line);
  console.log('  OCTOCOOKIE API SERVER v2.0 (Node.js)  —  porta', PORT);
  console.log(line);
  console.log(`  POST http://localhost:${PORT}/api/data      (bot → api)`);
  console.log(`  GET  http://localhost:${PORT}/api/latest    (último dado)`);
  console.log(`  GET  http://localhost:${PORT}/api/history   (histórico)`);
  console.log(`  GET  http://localhost:${PORT}/api/health    (status + latência)`);
  console.log(`  POST http://localhost:${PORT}/api/command   (analize → api)`);
  console.log(`  GET  http://localhost:${PORT}/api/command   (html faz poll)`);
  console.log(`  GET  http://localhost:${PORT}/api/dashboard (dashboard json)`);
  console.log(line);

  if (demo) startDemoInjector();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORT} já está em uso. Tente: node server.js --port 5051`);
  } else {
    console.error('Erro no servidor:', err);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[API] Servidor encerrado.');
  server.close();
  process.exit(0);
});

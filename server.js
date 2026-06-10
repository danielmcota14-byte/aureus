#!/usr/bin/env node
/**
 * CRYPTEX + OCTOCOOKIE  —  servidor principal  v3.0  AUTO-HEALING
 * ================================================================
 * Porta: process.env.PORT || 3000
 *
 * ✅ Protocolos automáticos:
 *   - Auto-restart do backend.js se morrer (até 10 tentativas com backoff)
 *   - Health check contínuo do backend.js na porta 5050
 *   - Auto-reparo via /api/repair se backend travar
 *   - Reconexão automática com exponential backoff
 *   - Watchdog que detecta processo zumbi e o mata/reinicia
 *   - Graceful shutdown com cleanup de processos filhos
 */

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const { spawn }  = require('child_process');
const http       = require('http');

try { require('dotenv').config(); } catch(e) {}

const app  = express();
const port = process.env.PORT || 3000;

const moonpayPublicKey = process.env.MOONPAY_PUBLIC_KEY || '';
const moonpayWidgetUrl = process.env.MOONPAY_WIDGET_URL || 'https://buy-sandbox.moonpay.com';

if (!moonpayPublicKey) console.warn('⚠️  MOONPAY_PUBLIC_KEY não definida.');

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ─── Estado do backend.js ─────────────────────────────────────────────────────
let _backendProcess   = null;
let _restartCount     = 0;
let _lastRestartAt    = 0;
let _autoStartEnabled = true;   // se false, não reinicia automaticamente
const MAX_RESTARTS    = 10;
const MIN_UPTIME_MS   = 3000;   // considera crash se morreu em < 3s
const BACKEND_PORT    = 5050;

// Backoff exponencial: 1s, 2s, 4s, 8s, 16s, 30s, 30s...
function backoffMs(attempt) {
  return Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
}

// ─── Inicia backend.js ────────────────────────────────────────────────────────
function startBackendProcess(reason = 'manual') {
  if (_backendProcess) {
    return { ok: false, running: true, message: 'backend.js já está rodando', pid: _backendProcess.pid };
  }

  if (!_autoStartEnabled) {
    return { ok: false, running: false, message: 'Auto-start desabilitado' };
  }

  if (_restartCount >= MAX_RESTARTS) {
    console.error(`[WD] ❌ Limite de ${MAX_RESTARTS} reinicializações atingido. Reparo manual necessário.`);
    return { ok: false, running: false, message: `Limite de ${MAX_RESTARTS} restarts atingido. Chame POST /bot/reset-restarts` };
  }

  const backendPath = path.join(__dirname, 'backend.js');
  const startedAt   = Date.now();

  console.log(`[WD] 🚀 Iniciando backend.js (motivo: ${reason}, tentativa #${_restartCount + 1})`);

  try {
    _backendProcess = spawn(process.execPath, [backendPath, '--port', String(BACKEND_PORT)], {
      cwd  : __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('[WD] Falha ao spawnar backend.js:', err.message);
    return { ok: false, running: false, message: err.message };
  }

  _restartCount++;
  _lastRestartAt = Date.now();

  _backendProcess.stdout.on('data', d => process.stdout.write(`[backend] ${d}`));
  _backendProcess.stderr.on('data', d => process.stderr.write(`[backend:err] ${d}`));

  _backendProcess.on('exit', (code, signal) => {
    const uptime = Date.now() - startedAt;
    console.warn(`[WD] ⚠️  backend.js encerrado — código:${code} signal:${signal} uptime:${uptime}ms`);
    _backendProcess = null;

    if (!_autoStartEnabled) return;

    // Se morreu rápido demais = crash grave
    if (uptime < MIN_UPTIME_MS) {
      console.error(`[WD] ❌ backend.js morreu em ${uptime}ms — possível crash na inicialização`);
    }

    // Agenda reinicialização com backoff
    const delay = backoffMs(_restartCount);
    console.log(`[WD] ⏳ Reagendando backend.js em ${delay}ms...`);
    setTimeout(() => startBackendProcess('auto-restart'), delay);
  });

  _backendProcess.on('error', err => {
    console.error('[WD] Erro no processo backend.js:', err.message);
    _backendProcess = null;
  });

  return { ok: true, running: true, message: `backend.js iniciado (porta ${BACKEND_PORT})`, pid: _backendProcess.pid };
}

function stopBackendProcess() {
  _autoStartEnabled = false; // pausa auto-restart
  if (!_backendProcess) return { ok: false, running: false, message: 'backend.js não está rodando' };
  _backendProcess.kill('SIGTERM');
  _backendProcess = null;
  return { ok: true, running: false, message: 'backend.js encerrado (auto-restart pausado)' };
}

// ─── Health check periódico do backend ───────────────────────────────────────
function checkBackendHealth() {
  const options = { hostname: '127.0.0.1', port: BACKEND_PORT, path: '/api/health', method: 'GET', timeout: 3000 };
  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (json.status !== 'online') {
          console.warn('[HC] ⚠️  backend.js retornou status não-online:', json.status);
          triggerRepair();
        }
        // Se circuito aberto, solicita reparo
        if (json.circuit_breaker === 'OPEN') {
          console.warn('[HC] ⚡ Circuit Breaker OPEN detectado — solicitando reparo');
          triggerRepair();
        }
      } catch (e) {
        console.warn('[HC] Resposta inválida do health check:', body.substring(0, 100));
      }
    });
  });

  req.on('error', (err) => {
    // Backend não responde — se processo existe, pode estar travado
    if (_backendProcess && _autoStartEnabled) {
      console.error(`[HC] ❌ Backend não responde: ${err.message} — reiniciando`);
      try { _backendProcess.kill('SIGKILL'); } catch(e) {}
      _backendProcess = null;
      setTimeout(() => startBackendProcess('health-check-failed'), 1000);
    } else if (!_backendProcess && _autoStartEnabled) {
      console.warn('[HC] Backend não está rodando — iniciando');
      startBackendProcess('health-check-start');
    }
  });

  req.on('timeout', () => {
    console.warn('[HC] ⏱️  Health check timeout — backend pode estar travado');
    req.destroy();
    if (_backendProcess && _autoStartEnabled) {
      try { _backendProcess.kill('SIGKILL'); } catch(e) {}
      _backendProcess = null;
      setTimeout(() => startBackendProcess('health-check-timeout'), 2000);
    }
  });

  req.end();
}

function triggerRepair() {
  const options = {
    hostname: '127.0.0.1', port: BACKEND_PORT,
    path: '/api/repair', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
    timeout: 3000,
  };
  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => console.log('[HC] ♻️  Reparo solicitado:', body.substring(0, 120)));
  });
  req.on('error', () => {});
  req.write('{}');
  req.end();
}

// ─── Endpoints bot automático ─────────────────────────────────────────────────
app.get('/bot/status', (_req, res) => {
  res.json({
    running       : !!_backendProcess,
    pid           : _backendProcess ? _backendProcess.pid : null,
    restart_count : _restartCount,
    last_restart  : _lastRestartAt ? new Date(_lastRestartAt).toISOString() : null,
    auto_start    : _autoStartEnabled,
    max_restarts  : MAX_RESTARTS,
  });
});

app.post('/bot/start', (_req, res) => {
  _autoStartEnabled = true;
  res.json(startBackendProcess('manual'));
});

app.post('/bot/stop', (_req, res) => res.json(stopBackendProcess()));

app.post('/bot/restart', (_req, res) => {
  _autoStartEnabled = true;
  stopBackendProcess();
  setTimeout(() => {
    _autoStartEnabled = true;
    res.json(startBackendProcess('manual-restart'));
  }, 1500);
});

// Reset do contador de restarts (para emergências)
app.post('/bot/reset-restarts', (_req, res) => {
  const before = _restartCount;
  _restartCount     = 0;
  _autoStartEnabled = true;
  res.json({ ok: true, resets_cleared: before, message: 'Contador zerado. POST /bot/start para reiniciar.' });
});

// Proxy para /api/repair no backend
app.post('/bot/repair', (_req, res) => {
  triggerRepair();
  res.json({ ok: true, message: 'Reparo solicitado ao backend' });
});

// ─── MoonPay helpers ──────────────────────────────────────────────────────────
function buildMoonpayUrl(amount, walletAddress, currencyCode = 'ETH', baseCurrencyCode = 'BRL') {
  const u = new URL(moonpayWidgetUrl);
  u.searchParams.set('apiKey', moonpayPublicKey);
  u.searchParams.set('currencyCode', currencyCode);
  u.searchParams.set('baseCurrencyCode', baseCurrencyCode);
  u.searchParams.set('baseCurrencyAmount', amount.toFixed(2));
  u.searchParams.set('walletAddress', walletAddress);
  u.searchParams.set('defaultPaymentMethod', 'PIX');
  return u.toString();
}

// ─── MoonPay endpoints ────────────────────────────────────────────────────────
app.get('/moonpay/url', (req, res) => {
  const amount = parseFloat(req.query.amount);
  const walletAddress = (req.query.walletAddress || '').trim();
  const currencyCode  = (req.query.currency || 'ETH').toUpperCase();
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });
  if (!walletAddress) return res.status(400).json({ error: 'Endereço de carteira inválido' });
  if (!moonpayPublicKey) return res.status(500).json({ error: 'Chave pública MoonPay não configurada' });
  return res.json({ url: buildMoonpayUrl(amount, walletAddress, currencyCode) });
});

app.get('/moonpay/open', (req, res) => {
  const amount = parseFloat(req.query.amount);
  const walletAddress = (req.query.walletAddress || '').trim();
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });
  if (!walletAddress) return res.status(400).json({ error: 'Endereço de carteira inválido' });
  if (!moonpayPublicKey) return res.status(500).json({ error: 'Chave pública MoonPay não configurada' });
  return res.redirect(buildMoonpayUrl(amount, walletAddress));
});

app.get('/moonpay/config', (_req, res) => res.json({ widgetUrl: moonpayWidgetUrl }));

app.post('/moonpay/transaction', async (req, res) => {
  const { baseCurrencyAmount, currencyCode = 'BRL', walletAddress } = req.body || {};
  if (!baseCurrencyAmount || !walletAddress)
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  const secret = process.env.MOONPAY_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: 'MOONPAY_SECRET_KEY não configurada' });
  try {
    const resp = await fetch('https://api.moonpay.io/v3/transactions', {
      method : 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ baseCurrencyAmount, currencyCode, walletAddress }),
    });
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/moonpay/webhook', (req, res) => {
  const signature = req.get('x-moonpay-signature') || req.get('x-signature') || req.get('x-mp-signature');
  const webhookKey = process.env.MOONPAY_WEBHOOK_KEY;
  if (!webhookKey) return res.status(500).json({ error: 'MOONPAY_WEBHOOK_KEY não configurada' });
  if (!signature)  return res.status(400).json({ error: 'Assinatura ausente' });
  const raw  = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const hmac = crypto.createHmac('sha256', webhookKey).update(raw).digest('hex');
  if (hmac !== signature) return res.status(400).json({ error: 'Assinatura inválida' });
  console.log('Webhook MoonPay válido:', req.body);
  return res.status(200).json({ received: true });
});

// ─── Estáticos + páginas ──────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.get('/',                          (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cryptex.html',              (_req, res) => res.sendFile(path.join(__dirname, 'CRYPTEX.html')));
app.get('/CRYPTEX.html',              (_req, res) => res.sendFile(path.join(__dirname, 'CRYPTEX.html')));
app.get('/octocookie.html',           (_req, res) => res.sendFile(path.join(__dirname, 'octocookie.html')));
app.get('/dashboard_analisador.html', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard_analisador.html')));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function onShutdown(signal) {
  console.log(`\n[SRV] ${signal} recebido — encerrando graciosamente...`);
  _autoStartEnabled = false;
  if (_backendProcess) {
    console.log('[SRV] Encerrando backend.js...');
    _backendProcess.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT',  () => onShutdown('SIGINT'));
process.on('SIGTERM', () => onShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[SRV] Erro não capturado:', err.message);
  // Não sai — mantém o servidor rodando
});

process.on('unhandledRejection', (reason) => {
  console.error('[SRV] Promise rejeitada:', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
  const line = '='.repeat(60);
  console.log(line);
  console.log(`  CRYPTEX + OCTOCOOKIE  v3.0  AUTO-HEALING  —  porta ${port}`);
  console.log(line);
  console.log(`  🌐  http://localhost:${port}`);
  console.log(`  POST /bot/start           → inicia backend.js`);
  console.log(`  POST /bot/stop            → para backend.js`);
  console.log(`  POST /bot/restart         → reinicia backend.js`);
  console.log(`  GET  /bot/status          → status + contador de restarts`);
  console.log(`  POST /bot/repair          → solicita reparo ao backend`);
  console.log(`  POST /bot/reset-restarts  → zera contador de restarts`);
  console.log(line);

  // Inicia backend.js automaticamente
  console.log('[SRV] 🚀 Iniciando backend.js automaticamente...');
  startBackendProcess('auto-boot');

  // Health check periódico do backend (a cada 20s)
  setInterval(checkBackendHealth, 20000);
});
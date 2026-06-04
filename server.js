#!/usr/bin/env node
/**
 * CRYPTEX + OCTOCOOKIE  —  servidor principal
 * Porta: process.env.PORT || 3000
 *
 * Rotas especiais:
 *   GET  /bot/status  → status do backend.js (porta 5050)
 *   POST /bot/start   → inicia backend.js como processo filho
 *   POST /bot/stop    → encerra backend.js
 *
 * Servindo estáticos: index.html, CRYPTEX.html, octocookie.html,
 *                     dashboard_analisador.html, e todos os demais arquivos.
 */

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const { spawn }  = require('child_process');

// dotenv opcional — carrega se existir
try { require('dotenv').config(); } catch(e) {}

const app  = express();
const port = process.env.PORT || 3000;

const moonpayPublicKey = process.env.MOONPAY_PUBLIC_KEY || '';
const moonpayWidgetUrl = process.env.MOONPAY_WIDGET_URL || 'https://buy-sandbox.moonpay.com';

if (!moonpayPublicKey) console.warn('Aviso: MOONPAY_PUBLIC_KEY não definida.');

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ─── Controle do processo backend.js ─────────────────────────────────────────
let _backendProcess = null;

function startBackendProcess() {
  if (_backendProcess) return { ok: false, running: true, message: 'backend.js já está rodando', pid: _backendProcess.pid };
  const backendPath = path.join(__dirname, 'backend.js');
  _backendProcess = spawn(process.execPath, [backendPath, '--port', '5050'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _backendProcess.stdout.on('data', d => process.stdout.write(`[backend] ${d}`));
  _backendProcess.stderr.on('data', d => process.stderr.write(`[backend:err] ${d}`));
  _backendProcess.on('exit', code => {
    console.log(`[backend] Processo encerrado (código ${code})`);
    _backendProcess = null;
  });
  return { ok: true, running: true, message: `backend.js iniciado na porta 5050`, pid: _backendProcess.pid };
}

function stopBackendProcess() {
  if (!_backendProcess) return { ok: false, running: false, message: 'backend.js não está rodando' };
  _backendProcess.kill('SIGTERM');
  _backendProcess = null;
  return { ok: true, running: false, message: 'backend.js encerrado' };
}

// ─── Endpoints bot automático ─────────────────────────────────────────────────
app.get('/bot/status', (_req, res) => {
  res.json({ running: !!_backendProcess, pid: _backendProcess ? _backendProcess.pid : null });
});
app.post('/bot/start', (_req, res) => res.json(startBackendProcess()));
app.post('/bot/stop',  (_req, res) => res.json(stopBackendProcess()));

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
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseCurrencyAmount, currencyCode, walletAddress }),
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
  if (!signature) return res.status(400).json({ error: 'Assinatura ausente' });
  const raw  = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const hmac = crypto.createHmac('sha256', webhookKey).update(raw).digest('hex');
  if (hmac !== signature) return res.status(400).json({ error: 'Assinatura inválida' });
  console.log('Webhook MoonPay válido:', req.body);
  return res.status(200).json({ received: true });
});

// ─── Estáticos + rotas de página ──────────────────────────────────────────────
app.use(express.static(__dirname));

app.get('/',                      (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cryptex.html',          (_req, res) => res.sendFile(path.join(__dirname, 'CRYPTEX.html')));
app.get('/CRYPTEX.html',          (_req, res) => res.sendFile(path.join(__dirname, 'CRYPTEX.html')));
app.get('/octocookie.html',       (_req, res) => res.sendFile(path.join(__dirname, 'octocookie.html')));
app.get('/dashboard_analisador.html', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard_analisador.html')));

// ─── Shutdown gracioso ────────────────────────────────────────────────────────
function onShutdown() {
  if (_backendProcess) _backendProcess.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT',  onShutdown);
process.on('SIGTERM', onShutdown);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
  console.log('='.repeat(56));
  console.log(`  CRYPTEX + OCTOCOOKIE Server  —  porta ${port}`);
  console.log('='.repeat(56));
  console.log(`  Abra: http://localhost:${port}`);
  console.log(`  POST /bot/start  → inicia backend.js (porta 5050)`);
  console.log(`  POST /bot/stop   → encerra backend.js`);
  console.log(`  GET  /bot/status → status do backend.js`);
  console.log('='.repeat(56));
});
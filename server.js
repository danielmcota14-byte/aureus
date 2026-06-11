// netlify/functions/api.js
const express = require('express');
const serverless = require('serverless-http');
const crypto = require('crypto');
const path = require('path');

const app = express();

// ─── Configurações ────────────────────────────────────────────────────────────
const moonpayPublicKey     = process.env.MOONPAY_PUBLIC_KEY || '';
const moonpayWidgetUrl     = process.env.MOONPAY_WIDGET_URL || 'https://buy-sandbox.moonpay.com';
const moonpayWebhookSecret = process.env.MOONPAY_WEBHOOK_SECRET;

if (!moonpayPublicKey) console.warn('⚠️  MOONPAY_PUBLIC_KEY não definida.');

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos da raiz do projeto
const publicPath = path.resolve(__dirname, '../..');
app.use(express.static(publicPath));

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'octocookie.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    backendRunning: false,
    restartCount: 0,
    timestamp: new Date().toISOString(),
    note: 'Modo serverless (Netlify Functions) - código único'
  });
});

app.post('/api/moonpay-webhook', (req, res) => {
  const signature = req.headers['moonpay-signature'];
  console.log('[MoonPay] Webhook recebido', { signature: signature?.substring(0, 20) });

  if (!signature) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  if (moonpayWebhookSecret && req.rawBody) {
    const expectedSignature = crypto
      .createHmac('sha256', moonpayWebhookSecret)
      .update(req.rawBody)
      .digest('base64');

    if (signature !== expectedSignature) {
      console.error('[MoonPay] ❌ Assinatura inválida');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    console.log('[MoonPay] ✅ Assinatura verificada');
  }

  const event = req.body;
  console.log('[MoonPay] Evento:', event.type);

  if (event.type === 'transaction_created') {
    console.log('[MoonPay] Transação criada:', event.data);
  } else if (event.type === 'transaction_updated') {
    console.log('[MoonPay] Transação atualizada:', event.data);
  }

  res.json({ received: true });
});

app.post('/api/repair', (req, res) => {
  console.log('[API] 🔧 Reparo solicitado (modo serverless - sem efeito)');
  res.status(501).json({
    error: 'Repair not available in serverless environment',
    message: 'Use /bot/reset-restarts to reset counters'
  });
});

app.post('/bot/reset-restarts', (req, res) => {
  console.log('[API] 🔄 Reset restarts (simulado)');
  res.json({
    ok: true,
    restartCount: 0,
    autoStartEnabled: true,
    note: 'Netlify serverless mode – no persistent process'
  });
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'octocookie.html'));
});

// ─── Export para Netlify Function ─────────────────────────────────────────────
exports.handler = serverless(app);

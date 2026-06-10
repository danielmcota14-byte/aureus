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

  return { ok: true, running: true, pid: _backendProcess.pid };
}

// ─── Função para matar o backend.js ──────────────────────────────────────────
function killBackendProcess() {
  if (_backendProcess) {
    console.log(`[WD] 💀 Matando backend.js PID: ${_backendProcess.pid}`);
    try {
      _backendProcess.kill('SIGTERM');
      setTimeout(() => {
        if (_backendProcess && !_backendProcess.killed) {
          console.log(`[WD] 💀 Forçando kill do backend.js`);
          _backendProcess.kill('SIGKILL');
        }
        _backendProcess = null;
      }, 3000);
    } catch (err) {
      console.error(`[WD] Erro ao matar processo: ${err.message}`);
      _backendProcess = null;
    }
  }
}

// ─── API de reparo e monitoramento ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    backend: {
      running: !!_backendProcess,
      pid: _backendProcess ? _backendProcess.pid : null,
      restartCount: _restartCount,
      lastRestartAt: _lastRestartAt,
      autoStartEnabled: _autoStartEnabled
    },
    moonpay: {
      hasPublicKey: !!moonpayPublicKey,
      widgetUrl: moonpayWidgetUrl
    },
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.post('/api/repair', async (req, res) => {
  console.log('[API] 🔧 Reparo manual solicitado');
  
  // Mata o processo se estiver rodando
  if (_backendProcess) {
    killBackendProcess();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Reset parcial do contador
  _restartCount = Math.max(0, _restartCount - 2);
  
  // Reinicia
  const result = startBackendProcess('manual-repair');
  
  res.json({
    message: 'Reparo executado',
    result,
    restartCount: _restartCount
  });
});

app.post('/api/restart-backend', (req, res) => {
  console.log('[API] 🔄 Reinício do backend solicitado');
  
  if (_backendProcess) {
    killBackendProcess();
    setTimeout(() => {
      const result = startBackendProcess('manual-restart');
      res.json({ message: 'Backend reiniciado', result });
    }, 1000);
  } else {
    const result = startBackendProcess('manual-start');
    res.json({ message: 'Backend iniciado', result });
  }
});

app.post('/bot/reset-restarts', (req, res) => {
  _restartCount = 0;
  _autoStartEnabled = true;
  console.log('[API] 🔄 Contador de restarts resetado');
  res.json({ ok: true, restartCount: 0, autoStartEnabled: true });
});

app.post('/bot/disable-auto-start', (req, res) => {
  _autoStartEnabled = false;
  console.log('[API] ⏸️ Auto-start desabilitado');
  res.json({ ok: true, autoStartEnabled: false });
});

app.post('/bot/enable-auto-start', (req, res) => {
  _autoStartEnabled = true;
  console.log('[API] ▶️ Auto-start habilitado');
  res.json({ ok: true, autoStartEnabled: true });
});

// Health check simples para o Render
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    backend: !!_backendProcess,
    timestamp: new Date().toISOString()
  });
});

// Health check detalhado
app.get('/health/deep', async (req, res) => {
  let backendHealthy = false;
  
  if (_backendProcess) {
    try {
      const backendHealthUrl = `http://localhost:${BACKEND_PORT}/health`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(backendHealthUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      backendHealthy = response.ok;
    } catch (err) {
      backendHealthy = false;
    }
  }
  
  res.json({
    status: backendHealthy ? 'healthy' : 'degraded',
    backend: {
      running: !!_backendProcess,
      healthy: backendHealthy,
      pid: _backendProcess ? _backendProcess.pid : null
    },
    restartCount: _restartCount,
    autoStartEnabled: _autoStartEnabled,
    uptime: process.uptime()
  });
});

// ─── Webhook MoonPay (mantido original) ──────────────────────────────────────
app.post('/api/moonpay/webhook', (req, res) => {
  const signature = req.headers['moonpay-signature'];
  
  console.log('[MoonPay] Webhook recebido', {
    signature: signature ? signature.substring(0, 20) + '...' : 'missing',
    body: req.body
  });
  
  // Verifica assinatura se tiver secret configurado
  const webhookSecret = process.env.MOONPAY_WEBHOOK_SECRET;
  if (webhookSecret && req.rawBody) {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('base64');
    
    if (signature !== expectedSignature) {
      console.error('[MoonPay] ❌ Assinatura inválida');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    console.log('[MoonPay] ✅ Assinatura verificada');
  }
  
  // Processa evento
  const { type, data } = req.body;
  
  switch (type) {
    case 'transaction.created':
      console.log('[MoonPay] 📝 Transação criada:', data.id);
      // Aqui você pode adicionar lógica de banco de dados
      break;
    case 'transaction.updated':
      console.log('[MoonPay] 🔄 Transação atualizada:', data.id, 'status:', data.status);
      break;
    case 'transaction.failed':
      console.log('[MoonPay] ❌ Transação falhou:', data.id);
      break;
    case 'transaction.completed':
      console.log('[MoonPay] ✅ Transação completada:', data.id);
      break;
    default:
      console.log('[MoonPay] 📦 Evento desconhecido:', type);
  }
  
  res.json({ received: true, type });
});

// ─── Rota para gerar assinatura MoonPay (client-side) ────────────────────────
app.get('/api/moonpay/signature', (req, res) => {
  const { walletAddress, currencyCode = 'eth', baseCurrencyCode = 'usd' } = req.query;
  
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress é obrigatório' });
  }
  
  if (!moonpayPublicKey) {
    return res.status(500).json({ error: 'MoonPay não configurado' });
  }
  
  const payload = {
    apiKey: moonpayPublicKey,
    currencyCode,
    baseCurrencyCode,
    walletAddress,
    baseCurrencyAmount: 100, // $100 USD default
    redirectUrl: `${req.protocol}://${req.get('host')}/payment/callback`,
    theme: 'dark'
  };
  
  // Assinatura para MoonPay (se tiver secret key)
  const secretKey = process.env.MOONPAY_SECRET_KEY;
  let signature = null;
  
  if (secretKey) {
    const queryString = new URLSearchParams(payload).toString();
    signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');
  }
  
  res.json({
    ...payload,
    signature,
    widgetUrl: moonpayWidgetUrl
  });
});

// ─── Servir arquivos estáticos ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/payment/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.get('/payment/callback', (req, res) => {
  console.log('[Payment] Callback recebido:', req.query);
  res.redirect('/dashboard?payment=completed');
});

// ─── API para verificar saúde do backend via proxy ───────────────────────────
app.get('/api/backend/health', async (req, res) => {
  if (!_backendProcess) {
    return res.status(503).json({ error: 'Backend não está rodando', backendRunning: false });
  }
  
  try {
    const backendHealthUrl = `http://localhost:${BACKEND_PORT}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(backendHealthUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    const data = await response.json();
    res.json({ backendRunning: true, ...data });
  } catch (err) {
    res.status(502).json({ error: 'Backend não responde', backendRunning: true, message: err.message });
  }
});

// ─── Proxy para rotas do backend (se necessário) ─────────────────────────────
app.use('/api/backend/*', async (req, res) => {
  if (!_backendProcess) {
    return res.status(503).json({ error: 'Backend indisponível' });
  }
  
  const backendUrl = `http://localhost:${BACKEND_PORT}${req.originalUrl}`;
  const method = req.method;
  const headers = {
    'Content-Type': 'application/json',
    ...req.headers
  };
  delete headers.host;
  delete headers['content-length'];
  
  try {
    const fetchOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(10000)
    };
    
    if (method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }
    
    const response = await fetch(backendUrl, fetchOptions);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[Proxy] Erro:', err.message);
    res.status(502).json({ error: 'Erro ao comunicar com backend', message: err.message });
  }
});

// ─── Watchdog passivo + agressivo ────────────────────────────────────────────
let healthCheckInterval = null;

function startWatchdog() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  
  healthCheckInterval = setInterval(async () => {
    // Se não tem processo, tenta iniciar
    if (!_backendProcess && _autoStartEnabled) {
      console.log('[WD] backend.js não está rodando, iniciando...');
      startBackendProcess('watchdog');
      return;
    }
    
    // Se tem processo mas pode estar zumbi, faz health check
    if (_backendProcess && _autoStartEnabled) {
      try {
        const backendHealthUrl = `http://localhost:${BACKEND_PORT}/health`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(backendHealthUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          console.warn(`[WD] backend.js health check falhou (status ${response.status})`);
          killBackendProcess();
          setTimeout(() => startBackendProcess('health-failed'), 1000);
        } else {
          // Reduz contador de restarts gradualmente quando está estável
          if (_restartCount > 0 && Date.now() - _lastRestartAt > 60000) {
            _restartCount = Math.max(0, _restartCount - 1);
            console.log(`[WD] ✅ Sistema estável, restartCount reduzido para ${_restartCount}`);
          }
        }
      } catch (err) {
        console.warn(`[WD] backend.js health check falhou: ${err.message}`);
        killBackendProcess();
        setTimeout(() => startBackendProcess('health-failed'), 1000);
      }
    }
  }, 30000); // A cada 30 segundos
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Recebido ${signal}, iniciando encerramento graceful...`);
  
  _autoStartEnabled = false;
  
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  
  if (_backendProcess) {
    console.log('[SHUTDOWN] Encerrando backend.js...');
    killBackendProcess();
    
    // Força saída após timeout
    setTimeout(() => {
      console.log('[SHUTDOWN] Forçando saída...');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Tratamento de exceções não capturadas
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Exceção não capturada:', err);
  // Não morre, apenas loga e continua
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Promise rejection não tratada:', reason);
});

// ─── Inicialização ────────────────────────────────────────────────────────────
function main() {
  console.log('═'.repeat(60));
  console.log('🚀 CRYPTEX + OCTOCOOKIE v3.0 AUTO-HEALING');
  console.log('═'.repeat(60));
  console.log(`📡 Porta: ${port} (host: 0.0.0.0 - Render compatível)`);
  console.log(`🤖 Backend: porta ${BACKEND_PORT}`);
  console.log(`🌙 MoonPay: ${moonpayPublicKey ? '✅ Configurado' : '❌ Não configurado'}`);
  console.log(`🔄 Max restarts: ${MAX_RESTARTS}`);
  console.log(`⏱️  Backoff inicial: ${backoffMs(1)}ms`);
  console.log('═'.repeat(60));
  
  // Inicia watchdog
  startWatchdog();
  
  // Inicia backend pela primeira vez
  startBackendProcess('initial-start');
  
  // Inicia servidor HTTP (0.0.0.0 para Render)
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`\n✅ Servidor rodando em http://0.0.0.0:${port}`);
    console.log(`🏥 Health check: http://0.0.0.0:${port}/health`);
    console.log(`📊 Status API: http://0.0.0.0:${port}/api/status`);
    console.log('═'.repeat(60));
  });
  
  server.on('error', (err) => {
    console.error('[FATAL] Erro no servidor:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Porta ${port} já está em uso!`);
      process.exit(1);
    }
  });
}

// Só muda isso: host 0.0.0.0 no app.listen (já está feito acima)
main();

#!/usr/bin/env node
/**
 * CRYPTEX + OCTOCOOKIE  —  servidor principal  v3.0  AUTO-HEALING
 * ================================================================
 * Porta: process.env.PORT || 3000
 * 
 * ✅ Adaptado para Render.com
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
      env: { ...process.env, PORT: String(BACKEND_PORT) } // Passa variáveis de ambiente
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

// ─── API de reparo e health check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    backendRunning: !!_backendProcess,
    restartCount: _restartCount,
    port: port,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/repair', async (req, res) => {
  console.log('[API] 🔧 Reparo manual solicitado');
  
  if (_backendProcess) {
    console.log('[API] backend.js está rodando, matando para reiniciar...');
    killBackendProcess();
  }
  
  // Reset restart count em reparo manual
  _restartCount = Math.max(0, _restartCount - 2);
  
  setTimeout(() => {
    const result = startBackendProcess('manual-repair');
    res.json({ message: 'Reparo concluído', result });
  }, 500);
});

app.post('/bot/reset-restarts', (req, res) => {
  _restartCount = 0;
  _autoStartEnabled = true;
  console.log('[API] 🔄 Contador de restarts resetado e auto-start reativado');
  res.json({ ok: true, restartCount: 0, autoStartEnabled: true });
});

// Função para matar o processo backend
function killBackendProcess() {
  if (_backendProcess) {
    console.log(`[WD] 💀 Matando backend.js PID: ${_backendProcess.pid}`);
    _backendProcess.kill('SIGTERM');
    setTimeout(() => {
      if (_backendProcess && !_backendProcess.killed) {
        _backendProcess.kill('SIGKILL');
      }
      _backendProcess = null;
    }, 3000);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Recebido ${signal}, encerrando gracefulmente...`);
  _autoStartEnabled = false;
  
  if (_backendProcess) {
    console.log('[SHUTDOWN] Encerrando backend.js...');
    _backendProcess.kill('SIGTERM');
    setTimeout(() => {
      if (_backendProcess && !_backendProcess.killed) {
        _backendProcess.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Servir arquivos estáticos ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Rota para a interface principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Webhook MoonPay ──────────────────────────────────────────────────────────
app.post('/api/moonpay-webhook', (req, res) => {
  const signature = req.headers['moonpay-signature'];
  console.log('[MoonPay] Webhook recebido', { signature: signature?.substring(0, 20) });
  
  if (!signature) {
    return res.status(400).json({ error: 'Missing signature' });
  }
  
  // Verificação da assinatura (se você configurou webhook secret)
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
  
  const event = req.body;
  console.log('[MoonPay] Evento:', event.type);
  
  // Processar evento (ajuste conforme sua lógica)
  if (event.type === 'transaction_created') {
    console.log('[MoonPay] Transação criada:', event.data);
  } else if (event.type === 'transaction_updated') {
    console.log('[MoonPay] Transação atualizada:', event.data);
  }
  
  res.json({ received: true });
});

// ─── Health check periódico do backend (watchdog passivo) ───────────────────
setInterval(async () => {
  if (!_backendProcess) {
    console.log('[WD] backend.js não está rodando, tentando iniciar...');
    startBackendProcess('watchdog');
    return;
  }
  
  // Verifica se o processo ainda está respondendo via HTTP
  const backendHealthUrl = `http://localhost:${BACKEND_PORT}/health`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const response = await fetch(backendHealthUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.warn(`[WD] backend.js health check falhou com status ${response.status}`);
      killBackendProcess();
      setTimeout(() => startBackendProcess('health-check-failed'), 1000);
    } else {
      // Backend está saudável
      if (_restartCount > 0 && _restartCount < MAX_RESTARTS) {
        // Reduz gradualmente o contador de restarts quando está estável
        setTimeout(() => {
          if (_restartCount > 0) {
            _restartCount = Math.max(0, _restartCount - 1);
            console.log(`[WD] ✅ Sistema estável, reduzindo restartCount para ${_restartCount}`);
          }
        }, 60000); // Espera 1 minuto antes de reduzir
      }
    }
  } catch (err) {
    console.warn(`[WD] backend.js health check falhou: ${err.message}`);
    killBackendProcess();
    setTimeout(() => startBackendProcess('health-check-failed'), 1000);
  }
}, 30000); // A cada 30 segundos

// ─── Inicialização principal ──────────────────────────────────────────────────
function main() {
  console.log(`[MAIN] 🌐 Servidor principal iniciando na porta ${port}`);
  console.log(`[MAIN] 📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[MAIN] 🔧 Backend target: localhost:${BACKEND_PORT}`);
  
  // Iniciar backend.js
  startBackendProcess('initial-start');
  
  // Iniciar servidor HTTP
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[MAIN] ✅ Servidor rodando em http://0.0.0.0:${port}`);
    console.log(`[MAIN] 🏥 Health check disponível em /health`);
  });
  
  server.on('error', (err) => {
    console.error('[MAIN] ❌ Erro no servidor:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`[MAIN] Porta ${port} já está em uso!`);
      process.exit(1);
    }
  });
}

// Iniciar aplicação
main();

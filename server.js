// netlify/functions/api.js
// Um único arquivo para toda a aplicação (API + frontend estático)

const express = require('express');
const serverless = require('serverless-http');
const crypto = require('crypto');
const path = require('path');

const app = express();

// Configurações
const moonpayPublicKey = process.env.MOONPAY_PUBLIC_KEY || '';
const moonpayWidgetUrl = process.env.MOONPAY_WIDGET_URL || 'https://buy-sandbox.moonpay.com';
const moonpayWebhookSecret = process.env.MOONPAY_WEBHOOK_SECRET;

if (!moonpayPublicKey) console.warn('⚠️ MOONPAY_PUBLIC_KEY não definida.');

// Middlewares
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos da pasta 'public' (um nível acima da função)
// No Netlify, o caminho relativo muda; vamos usar path.resolve
const publicPath = path.resolve(__dirname, '../../public');
app.use(express.static(publicPath));

// Rota principal: serve octocookie.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'octocookie.html'));
});

// Rota de health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    backendRunning: false,  // serverless, sem processos filhos
    restartCount: 0,
    timestamp: new Date().toISOString(),
    note: 'Modo serverless (Netlify Functions) - código único'
  });
});

// Webhook MoonPay
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

// Reparo (não aplicável em serverless, mas mantido para compatibilidade)
app.post('/api/repair', (req, res) => {
  console.log('[API] 🔧 Reparo solicitado (modo serverless - sem efeito)');
  res.status(501).json({
    error: 'Repair not available in serverless environment',
    message: 'Use /bot/reset-restarts to reset counters'
  });
});

// Reset de contador de restarts (simulado)
app.post('/bot/reset-restarts', (req, res) => {
  console.log('[API] 🔄 Reset restarts (simulado)');
  res.json({
    ok: true,
    restartCount: 0,
    autoStartEnabled: true,
    note: 'Netlify serverless mode – no persistent process'
  });
});

// Fallback para qualquer outra rota: serve o octocookie.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'octocookie.html'));
});

// Exporta o handler para a Netlify Function
exports.handler = serverless(app);    timestamp: new Date().toISOString()
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

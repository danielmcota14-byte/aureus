# CRYTEX MoonPay Backend

Este backend gera um checkout MoonPay seguro para o frontend CRYTEX.

## Instalação

1. Abra um terminal em `c:\Users\danim\Downloads\cryptex-backend`
2. Execute:

```bash
npm install
```

3. Crie um arquivo `.env` com os valores abaixo:

```env
MOONPAY_PUBLIC_KEY=YOUR_MOONPAY_PUBLIC_KEY
MOONPAY_WIDGET_URL=https://buy-sandbox.moonpay.com
PORT=3000
```

## Executar

```bash
npm start
```

## Endpoints

- `GET /`
  - Serve o front-end `CRYPTEX.html` como página principal.
- `GET /cryptex.html`
  - Serve o front-end `CRYPTEX.html` diretamente.
- `GET /moonpay/url?amount=100.00&walletAddress=0x...`
  - Retorna `{ "url": "https://buy-sandbox.moonpay.com?..." }`
- `GET /moonpay/open?amount=100.00&walletAddress=0x...`
  - Redireciona para a URL do widget MoonPay para abertura direta.
- `GET /moonpay/config`
  - Retorna a URL do widget MoonPay.

> Use apenas MoonPay no frontend e mantenha a chave pública em `.env` no backend.

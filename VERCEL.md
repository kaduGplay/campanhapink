# Publicar na Vercel

O projeto já contém `vercel.json`, uma função Node.js para a API e um build que copia somente os arquivos públicos. Envie/importe **a raiz do projeto**, não apenas `dist`.

## 1. Importar o projeto

No painel Vercel, importe o repositório/pasta como projeto **Other**. A configuração versionada define:

- Node.js: **24.x**.
- Build Command: `npm run build`.
- Output Directory: `dist`.
- API: `api/index.js`, com duração máxima de 60 segundos.

Os nomes das páginas e as URLs atuais foram preservados, incluindo `/parte%201/index.html` e `/checkout.html?kit=1`.

## 2. Conectar o banco

Adicione uma integração **Upstash Redis** ao projeto no Marketplace/Storage da Vercel. O código utiliza a API REST do banco, sem biblioteca adicional.

O Redis guarda os pedidos e eventos autenticados dos webhooks. Isso é necessário porque funções Vercel podem executar em instâncias diferentes e não têm um diretório local permanente para os pedidos. Configure o banco sem remoção automática de chaves por falta de espaço (no eviction); o código não aplica TTL às cobranças nem aos eventos.

Cadastre as variáveis abaixo em **Project Settings → Environment Variables**:

| Variável | Valor |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | URL HTTPS REST fornecida pela integração Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Token REST de leitura e escrita do Upstash |
| `VOIDPAY_PUBLIC_KEY` | A chave pública já usada no `.env` local |
| `VOIDPAY_SECRET_KEY` | A chave privada já usada no `.env` local |
| `GATEWAY_WEBHOOK_TOKEN` | O mesmo token interno fixo já salvo no `.env` |
| `PUBLIC_BASE_URL` | URL pública HTTPS estável do site, sem caminho, por exemplo `https://seu-projeto.vercel.app` |

Integrações antigas que disponibilizam `KV_REST_API_URL` e `KV_REST_API_TOKEN` também são aceitas. Use o token de escrita, não um token somente de leitura.

`PINK_STORAGE_PREFIX` é opcional. O padrão na Vercel é `campanha-pink:production` ou `campanha-pink:preview`, conforme o ambiente. Mantenha o namespace de produção igual entre deploys. Para usar o banco localmente, configure as variáveis Redis; sem elas o modo local continua usando `.data`.

Não envie `.env` ou `.data` para a Vercel. Eles estão bloqueados em `.gitignore` e `.vercelignore`. Os valores secretos precisam ser cadastrados no painel; não vão dentro do HTML ou do build.

## 3. Deploy e webhooks

Faça o deploy. Após conhecer a URL definitiva, confira `PUBLIC_BASE_URL` e faça um **Redeploy** caso tenha alterado as variáveis.

No painel VoidPay, cadastre:

| Evento | URL |
| --- | --- |
| `TRANSACTION_CREATED` | `https://SEU-DOMINIO/api/webhooks/voidpay/created` |
| `TRANSACTION_PAID` | `https://SEU-DOMINIO/api/webhooks/voidpay/paid` |

A VoidPay precisa enviar o token interno em `payload.token`, conforme a integração existente. O token permanece o mesmo em todas as vendas e em todos os deploys. Garanta que a proteção de acesso da Vercel não exija login para essas URLs de produção; o receptor já autentica cada notificação pelo token.

As funções acessam a VoidPay diretamente, somente pelo servidor. Sem Redis configurado, a API retorna uma mensagem de indisponibilidade **antes** de solicitar a cobrança. Não existe fallback para memória ou `/tmp` na Vercel.

## 4. Verificação

```sh
npm run build
npm test
```

O build coloca em `dist` somente HTML, imagens, fontes e scripts públicos. A função da API é publicada separadamente pela Vercel a partir de `api/index.js`.

Os testes cobrem reserva atômica de pedidos no Redis, concorrência entre instâncias, conciliação de webhooks após reinicialização, leitura do corpo das requisições da Vercel, rotas, exclusão de arquivos privados e comportamento sem banco. Os testes usam um Redis simulado; a conexão com o banco real e o deploy precisam ser verificados depois de configurar o projeto na conta Vercel.

Os registros locais anteriores em `.data` não são migrados automaticamente para o Redis. Não reutilize a sessão de um pedido local no ambiente publicado.

## Referências

- [Funções Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js)
- [Configuração do vercel.json](https://vercel.com/docs/project-configuration/vercel-json)
- [Redis na Vercel](https://vercel.com/docs/redis)
- [API REST do Upstash](https://upstash.com/docs/redis/features/restapi)
- [Persistência do Upstash](https://upstash.com/docs/redis/features/durability)

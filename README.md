# Campanha PINK

Cópia local das páginas públicas de https://www.campanhatelepink.site, obtida em 30/09/2026. Mantém o HTML, CSS, imagens, textos, responsividade e animações do original.

## Vercel

O código está adaptado para publicação na Vercel. Siga [VERCEL.md](VERCEL.md) para configurar as variáveis e conectar o Redis. A configuração de deploy está em `vercel.json`; `npm run build` produz apenas os arquivos públicos em `dist`.

## Executar

Com Node.js instalado:

```sh
npm start
```

Abra http://127.0.0.1:58327.

O checkout precisa do servidor Node para gerar o Pix. Live Server/prévias estáticas não executam `/api/pix` e retornam 404/405. Ao abrir `checkout.html` por arquivo local ou prévia em localhost, ele encaminha para o servidor Node na porta padrão 58327, preservando somente kit e identificador do pedido. Inicie `npm start` antes de usar essa prévia. Se configurar outra `PORT`, abra diretamente o endereço do servidor Node nessa porta.

## Páginas

- `/`: modal de entrada e pesquisa com cinco perguntas.
- `/parte%201/index.html`: oferta do kit e seleção de quantidade.
- `/checkout.html?kit=1` ou `?kit=2`: endereço, dados pessoais e pagamento.

O site está sem UTMify. Os identificadores antigos, o repasse de parâmetros de anúncios e os interceptadores de clique/fetch dos rastreadores anteriores foram removidos; o único rastreamento é o Pixel da Meta descrito abaixo. O link `/loja` retorna à oferta local.

## Pixel e API de Conversões da Meta

Pixel `1614475887126253`, definido em `shop-config.js` e carregado por `js/meta-pixel.js` nas três páginas. Prévias locais (`localhost`, arquivo) não enviam eventos.

| Evento | Quando | Navegador | Servidor |
| --- | --- | --- | --- |
| `PageView` | Toda página | Sim | Não |
| `AddToCart` | Ao chegar no checkout, uma vez por visita e kit | Sim | `POST /api/meta/event` |
| `Purchase` | Pagamento confirmado | Sim, na tela de aprovado | Sim, na confirmação do pagamento |

Navegador e servidor usam o mesmo ID de evento (`atc:<uuid>` e `purchase:<pedido>`), e a Meta deduplica. O `Purchase` do servidor é enviado mesmo que a cliente feche a página antes da aprovação, desde que o aviso da VoidPay chegue. Valores e itens vêm do pedido recalculado no servidor, em BRL.

O servidor envia e-mail, telefone, CEP, cidade, estado e país somente em SHA-256, além de IP, user agent e cookies `_fbp`/`_fbc` capturados na requisição da própria cliente ao gerar o Pix. CPF, nome e endereço completo não são enviados. O token fica em `META_ACCESS_TOKEN` apenas no servidor. Sem token, o Pixel do navegador continua funcionando. Falhas da Meta não bloqueiam checkout nem pagamento; um `Purchase` que falhar é reenviado na próxima conferência do pedido.

Para validar no Gerenciador de Eventos, configure temporariamente `META_TEST_EVENT_CODE` com o código de "Testar eventos" e remova-o depois. Enquanto estiver configurado, os eventos do servidor não contam como conversões reais.

## Integração VoidPay

Requer Node.js 24.x. Copie `.env.example` para `.env` e preencha localmente:

```dotenv
VOIDPAY_PUBLIC_KEY=sua_chave_publica
VOIDPAY_SECRET_KEY=sua_chave_secreta
```

Reinicie `npm start` após configurar as chaves. Elas ficam exclusivamente no servidor. Nunca coloque credenciais em `checkout.html` ou `shop-config.js`. Na Vercel, pedidos e eventos são persistidos em Redis compartilhado entre as funções. No modo local sem Redis, continuam em `.data`, que deve permanecer privado. Não execute múltiplos servidores com diretórios locais independentes; para múltiplas instâncias, use o mesmo banco e namespace Redis.

### Implementado

- `POST /api/pix`: envia o nome padrão `Cliente` para todos os pedidos e valida e-mail, telefone, CPF e endereço; recalcula kit, adicionais e frete pelo catálogo; envia a cobrança para `https://dash.voidpayments.com/api/v1/gateway/pix/receive`.
- Os headers `x-public-key` e `x-secret-key` são enviados apenas à VoidPay. O navegador recebe código Pix, validade quando fornecida, valor e identificadores do pedido.
- O QR Code é renderizado localmente a partir de `pix.code`. Não é inventado um prazo quando `expiresAt` não é retornado.
- `Idempotency-Key` é preservado na sessão do checkout. O servidor reserva a tentativa no armazenamento antes da chamada e reutiliza a resposta em repetições. Falhas ambíguas de rede exigem conferência no painel antes de outra cobrança; não há reenvio automático ao gateway.
- `amount` é o total em reais. O frete pago é representado como item de serviço em `products`, de modo que a soma dos itens corresponde a `amount`. O campo opcional `shippingFee` foi omitido porque a documentação fornecida não inclui a fórmula mencionada no link de cálculo do total.
- `GET /api/status` exige identificador do pedido e token Bearer; combina a resposta da criação, os webhooks autenticados já gravados e, se ainda pendente, a consulta autenticada à VoidPay (no máximo a cada 15 segundos). Retorna `pending` ou `paid`.
- `.env`, `.data`, testes e código do servidor não são acessíveis por HTTP.

### Aviso automático por cobrança (`callbackUrl`)

Com `PUBLIC_BASE_URL` configurada em HTTPS, cada Pix é criado com `callbackUrl=${PUBLIC_BASE_URL}/api/webhooks/voidpay`. A VoidPay registra esse endereço na própria transação e envia para ele os avisos de gerada e paga. Não é preciso cadastrar nada no painel.

O corpo do aviso apenas indica qual pedido conferir, pelo identificador ou pelo ID da transação. O status nunca é aceito do corpo: o servidor consulta `GET /api/v1/gateway/transactions?id=` com as chaves da loja e só aprova com `COMPLETED`, mesma transação, mesmo pedido, valor em centavos, BRL e PIX. Se o aviso diz pago e a consulta ainda não confirma, ou se a consulta falha, a rota responde 503 para a VoidPay reenviar.

`GET /api/status` usa a mesma consulta como reserva, no máximo a cada 15 segundos por pedido e instância, enquanto o checkout está aberto. A confirmação dispara o `Purchase` da API de Conversões uma única vez por pedido.

### Webhooks de transação criada e paga (painel, opcional)

As rotas abaixo continuam disponíveis caso você prefira também cadastrar os eventos no painel VoidPay, usando o domínio público desta instalação:

| Evento | Método | URL |
| --- | --- | --- |
| `TRANSACTION_CREATED` | POST | `https://SEU-DOMINIO/api/webhooks/voidpay/created` |
| `TRANSACTION_PAID` | POST | `https://SEU-DOMINIO/api/webhooks/voidpay/paid` |

Um token interno aleatório de 256 bits já foi gerado e salvo em `GATEWAY_WEBHOOK_TOKEN` no `.env`. Ele é fixo para esta instalação, compartilhado por todas as vendas e pelas duas rotas, e não muda ao reiniciar. Preserve o `.env` na implantação; não gere outro token por venda.

No `.env`, preencha a URL pública e reinicie o servidor:

```dotenv
PUBLIC_BASE_URL=https://SEU-DOMINIO
```

A geração interna não registra o token na VoidPay. O mesmo valor precisa estar associado à configuração do webhook no provedor e corresponder ao `payload.token` enviado em ambos os eventos. A documentação recebida não fornece uma API para cadastrar essa configuração automaticamente. Não use a chave pública, a chave privada da API nem os tokens de exemplo da documentação. As duas rotas exigem esse token antes de processar o corpo. A configuração segue os webhooks do painel descritos nos documentos fornecidos; não envia `callbackUrl` na criação do Pix, cujo `webhookToken` por transação é outro fluxo.

`PUBLIC_BASE_URL` indica que esta instalação está publicada por HTTPS e permite habilitar a consulta automática no checkout quando o token também estiver preenchido. Esse campo **não publica o servidor nem cadastra as URLs no painel**. A VoidPay não consegue acessar `localhost`. Se o proxy/hospedagem exigir, configure `HOST=0.0.0.0` no servidor publicado e mantenha HTTPS no proxy.

- A rota de criação aceita somente `TRANSACTION_CREATED`; a rota de pagamento aceita somente `TRANSACTION_PAID` com `transaction.status=COMPLETED` e data de pagamento válida.
- O corpo é validado, incluindo os objetos opcionais. Os tipos estão em `lib/voidpay-webhooks.d.ts`. Como os exemplos fornecidos divergem da tabela, `transaction.identifier` e `pixInformation.id` podem ser omitidos; assinatura, itens e rastreamento são aceitos tanto na raiz quanto dentro de `transaction`.
- As notificações são gravadas em Redis na Vercel ou em `.data/webhooks` no modo local, com criação atômica e identificação por evento + transação. O modo local também sincroniza os registros em disco. HTTP 200 só é retornado após gravação durável ou reconhecimento de uma repetição já gravada. Repetições conflitantes retornam 409.
- Os registros contêm somente os dados de transação necessários à conciliação. Tokens, CPF, telefone, e-mail e payload bruto não são gravados nesses registros nem nos logs. Logs indicam apenas evento, resultado e código HTTP de erro.
- A confirmação exige o mesmo ID de transação retornado na criação, valor em centavos, moeda BRL, método PIX e, quando informado, identificador do pedido. Um evento criado não aprova a compra. Um evento de criação atrasado não reverte um pagamento.
- A conciliação é feita ao consultar o pedido, a partir do registro durável de pagamento. Isso também cobre um webhook recebido antes da resposta da geração do Pix. Essas duas rotas do painel não fazem chamada de saída; a consulta autenticada é usada pelo aviso automático e pelo status.
- O checkout consulta o servidor a cada cinco segundos e abre a tela de pagamento aprovado após a confirmação. A consulta continua após o prazo visual do QR Code para permitir a chegada tardia de uma notificação de pagamento.
- Este receptor cobre apenas criação e pagamento. Eventos de estorno, chargeback e cancelamento não são aceitos nessas rotas.

### Estado da configuração

As chaves da API e o token interno estão configurados localmente e na Vercel. Em produção, `PUBLIC_BASE_URL` ativa o aviso automático por cobrança, e a consulta autenticada confirma pagamentos mesmo sem webhooks do painel. Sem token interno, as rotas do painel retornam 503. Uma cobrança de teste de R$ 34,90 foi gerada com sucesso, conforme o registro de diagnóstico abaixo. Nenhum pagamento foi efetuado; a confirmação real por webhook ainda não foi homologada.

O checkout não solicita nome nem consulta titularidade do CPF; envia o nome padrão `Cliente` definido no servidor. O preenchimento por CEP usa ViaCEP e exige internet.

Os indicadores de contribuições da oferta são simulações presentes no código original, não transações verificadas.

## Testes

```sh
npm test
```

Testes com gateway e webhooks simulados cobrem cálculo, validação, contrato da API, repetição concorrente, persistência, timeout, rejeições, autenticação, notificações fora de ordem, conciliação, falhas de disco e proteção das rotas privadas. Não geram cobranças reais.

## Diagnóstico de recusas do gateway

As recusas registram no armazenamento de pedidos (Redis na Vercel, `.data/orders` localmente) o HTTP, o código do provedor e somente nomes de campos inválidos. O corpo bruto da resposta, mensagens com dados pessoais e credenciais não são registrados. O checkout mostra o código da recusa e orientações específicas para autenticação, dados inválidos, CPF obrigatório e valor mínimo. Repetir uma tentativa recusada não emite outra cobrança automaticamente.

Na validação real com dados fictícios, a conta exigiu `client.document` e informou mínimo de R$ 2,00 por cobrança. O checkout já envia CPF e o kit atual custa R$ 34,90; essas duas exigências, isoladamente, não explicam a primeira recusa de HTTP 400. O motivo daquela resposta foi descartado pela versão anterior e não pode ser recuperado do registro local.

### Resultado do teste autorizado de R$ 2,00

A solicitação com dados fictícios retornou HTTP 500, código `GATEWAY_INTERNAL_SERVER_ERROR`. A mensagem do provedor foi `Expected number to be greater or equal to 0 in path splitAmountTotal. Received: -0.1299999999999999`. Não foram retornados ID de transação nem código Pix. Nenhum pagamento foi efetuado. O resumo está em `.data/diagnostics/voidpay-test-2brl.json`, protegido do acesso HTTP.

Esse erro interno do teste de R$ 2,00 não demonstra a causa do HTTP 400 da tentativa original de R$ 34,90. Não houve repetição automática nem teste com valor maior.

### Teste autorizado no valor original — R$ 34,90

A cobrança foi gerada pelo mesmo código `createPayments` do checkout, com kit 1, frete grátis, sem adicionais e dados fictícios. A VoidPay retornou HTTP 200, status `PENDING` e código Pix. ID da transação: `cmuoo3ikt1l2x01px60vebyjt`. Nenhum pagamento foi efetuado.

O resumo está em `.data/diagnostics/voidpay-test-original-value.json`; o código Pix e o registro do teste estão em `.data/diagnostics/orders/`. O sucesso valida a geração com as credenciais atuais e o valor original, mas não recupera o motivo descartado da tentativa antiga de HTTP 400. A tentativa anterior não foi apagada nem reenviada.

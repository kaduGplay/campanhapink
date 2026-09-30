const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gatewayFailure } = require('../lib/gateway-errors');
test('extrai campos inválidos nos formatos documentado e retornado pela VoidPay', () => {
  const result = gatewayFailure(400, { errorCode: 'GATEWAY_INVALID_DATA', details: [
    { path: 'client.email', error: { message: 'EMAIL PRIVADO' } },
    { path: ['amount'], message: 'Number must be greater than or equal to 0.01' },
    { path: ['client'], unionErrors: [{ issues: [{ path: ['client', 'phone'], received: 'TELEFONE PRIVADO' }] }] }
  ] });
  assert.deepEqual(result.fields, ['client.email', 'amount', 'client.phone']);
  assert.match(result.message, /e-mail, valor, telefone/);
  assert.match(result.message, /GATEWAY_INVALID_DATA \(HTTP 400\)/);
  assert.equal(JSON.stringify(result).includes('PRIVADO'), false);
});
test('erro de autenticação é identificado sem expor mensagem ou segredo do gateway', () => {
  const result = gatewayFailure(403, { errorCode: 'GATEWAY_INVALID_CREDENTIALS', message: 'CHAVE SECRETA', details: [{ path: 'CHAVE SECRETA' }] });
  assert.match(result.message, /autenticação/);
  assert.equal(JSON.stringify(result).includes('CHAVE SECRETA'), false);
});
test('resposta não JSON, código inesperado e limite de requisições recebem diagnóstico seguro', () => {
  assert.match(gatewayFailure(502, null).message, /HTTP 502/);
  assert.equal(gatewayFailure(400, { errorCode: '<script>private</script>' }).code, 'GATEWAY_ERROR');
  assert.equal(gatewayFailure(400, { errorCode: 'SECRET_VALUE' }, ['SECRET_VALUE']).code, 'GATEWAY_ERROR');
  assert.match(gatewayFailure(429, {}).message, /limitando/);
});

test('erros reais de documento obrigatório e valor mínimo geram mensagens específicas', () => {
  const document = gatewayFailure(422, { errorCode: 'GATEWAY_INVALID_ARGUMENT', message: 'Required document.' });
  assert.deepEqual(document.fields, ['client.document']);
  assert.match(document.message, /CPF/);
  const minimum = gatewayFailure(422, { errorCode: 'GATEWAY_INVALID_ARGUMENT', message: 'Valor mínimo para transação é de R$ 2,00' });
  assert.match(minimum.message, /mínimo de R\$ 2,00/);
});

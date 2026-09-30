const FIELD_LABELS = {
  'client.name': 'nome do cliente', 'client.email': 'e-mail', 'client.phone': 'telefone',
  'client.document': 'CPF', identifier: 'identificador do pedido', amount: 'valor',
  products: 'produtos', shippingFee: 'frete', metadata: 'dados do pedido'
};
function gatewayFailure(httpStatus, data, secrets = []) {
  const candidate = typeof data?.errorCode === 'string' ? data.errorCode : '';
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate) && !secrets.some(s => s && candidate.includes(s)) ? candidate : 'GATEWAY_ERROR';
  const fields = new Set();
  function visit(issue, depth = 0) {
    if (!issue || typeof issue !== 'object' || depth > 5) return;
    const name = Array.isArray(issue.path) ? issue.path.join('.') : issue.path;
    if (typeof name === 'string') {
      const root = name.startsWith('products.') ? 'products' : name;
      if (Object.hasOwn(FIELD_LABELS, root)) fields.add(root);
    }
    if (Array.isArray(issue.unionErrors)) for (const branch of issue.unionErrors.slice(0, 20)) {
      if (Array.isArray(branch.issues)) for (const child of branch.issues.slice(0, 20)) visit(child, depth + 1);
    }
  }
  if (Array.isArray(data?.details)) for (const issue of data.details.slice(0, 40)) visit(issue);
  const providerMessage = typeof data?.message === 'string' ? data.message.trim() : '';
  if (code === 'GATEWAY_INVALID_ARGUMENT' && providerMessage === 'Required document.') fields.add('client.document');
  const minimumMatch = code === 'GATEWAY_INVALID_ARGUMENT' && providerMessage.match(/^Valor mínimo para transação é de R\$ (\d{1,7},\d{2})$/);
  const suffix = ` Referência: ${code} (HTTP ${httpStatus}).`;
  let message;
  if (httpStatus === 401 || httpStatus === 403 || /AUTH|CREDENTIAL|PUBLIC_KEY|SECRET_KEY|INVALID_KEY/.test(code)) {
    message = 'A VoidPay recusou a autenticação da loja. É necessário conferir as credenciais e as permissões da conta.';
  } else if (minimumMatch) {
    message = `A VoidPay exige valor mínimo de R$ ${minimumMatch[1]} para gerar o Pix.`;
  } else if (['GATEWAY_INVALID_DATA', 'GATEWAY_INVALID_ARGUMENT'].includes(code) && fields.size) {
    message = 'A VoidPay recusou os seguintes dados: ' + [...fields].map(f => FIELD_LABELS[f]).join(', ') + '. Confira os campos antes de continuar.';
  } else if (httpStatus === 429) {
    message = 'A VoidPay está limitando as solicitações. Aguarde antes de tentar novamente.';
  } else {
    message = 'A VoidPay não disponibilizou o Pix. A loja precisa verificar o motivo informado pelo provedor.';
  }
  // Não retorna/persiste message, details, received ou errorDescription originais:
  // o gateway pode incluir chaves e dados pessoais nesses campos.
  return { httpStatus, code, fields: [...fields], message: message + suffix };
}
module.exports = { gatewayFailure };

/* ======================================================
   ENDEREÇO -> BUSCA DO GOOGLE MAPS
   Usado pela página de obrigado (checkout.html) e pelos testes (tests/map-query.test.js).
   Funções puras: não acessam a página nem registram o endereço em lugar nenhum.
====================================================== */
(function (root) {
  const limpar = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  // "01310100" -> "01310-100". CEP inválido vira '' (é pulado na busca).
  function formatarCep(cep) {
    const d = String(cep == null ? '' : cep).replace(/\D/g, '');
    return d.length === 8 ? d.slice(0, 5) + '-' + d.slice(5) : '';
  }

  // "S/N", "s/n", "SN", "s/nº" contam como sem número
  const semNumero = n => !n || /^s\s*\/?\s*n[º°o.]?$/i.test(n);

  function normalizarEndereco(e) {
    e = e || {};
    const numero = limpar(e.numero);
    return {
      rua: limpar(e.rua),
      numero: semNumero(numero) ? '' : numero,
      complemento: limpar(e.complemento),
      bairro: limpar(e.bairro),
      cidade: limpar(e.cidade),
      uf: limpar(e.uf).toUpperCase(),
      cep: formatarCep(e.cep)
    };
  }

  // Sem rua ou sem cidade a busca do Maps cai em lugar errado: não mostramos o mapa
  function enderecoCompleto(e) {
    const n = normalizarEndereco(e);
    return !!(n.rua && n.cidade);
  }

  /* "{rua}, {número} - {bairro}, {cidade} - {UF}, {CEP}, Brasil", já com encodeURIComponent.
     O complemento (apto, bloco...) fica de fora de propósito: ele confunde a busca do Maps. */
  function buildMapQuery(endereco) {
    const e = normalizarEndereco(endereco);
    const ruaNumero = [e.rua, e.numero].filter(Boolean).join(', ');
    const local = [ruaNumero, e.bairro].filter(Boolean).join(' - ');
    const cidadeUf = [e.cidade, e.uf].filter(Boolean).join(' - ');
    return encodeURIComponent([local, cidadeUf, e.cep, 'Brasil'].filter(Boolean).join(', '));
  }

  const api = { buildMapQuery, normalizarEndereco, enderecoCompleto, formatarCep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapQuery = api;
})(this);

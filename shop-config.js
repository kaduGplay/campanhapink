/* ======================================================
   CONFIGURAÇÃO DA LOJA (preços e frete)
   Usado pelo checkout (exibição) e pelo servidor (cobrança).
   O servidor sempre recalcula o total a partir daqui,
   então o valor não pode ser alterado pelo navegador.
====================================================== */
(function (root) {
  var SHOP_CONFIG = {
    produtoId: 'kit5-body-splash',
    produtoNome: 'Kit 5 Body Splashes Edição Limitada',

    // Pixel da Meta (público). O token da API de Conversões fica só no servidor (META_ACCESS_TOKEN).
    metaPixelId: '1614475887126253',

    // checkout.html?kit=1  /  checkout.html?kit=2
    kits: {
      '1': { nome: 'Kit 5 Body Splashes', quantidade: 1, total: 34.90 },
      '2': { nome: 'Kit 5 Body Splashes (leve 2)', quantidade: 2, total: 58.80 }
    },

    // Order bumps oferecidos na etapa de pagamento (o cliente pode marcar vários)
    orderBumps: {
      'bodysplash': { nome: 'Body Splash Obsessed Desodorante Colônia 200ml', preco: 5.65, imagem: 'odb/bodysplash.webp' },
      'feive':      { nome: 'Feive Desodorante Colônia 100ml', preco: 14.82, imagem: 'odb/feive.webp' },
      'bodycream':  { nome: 'Body Cream VF Golden Desodorante Hidratante 200ml', preco: 5.99, imagem: 'odb/bodycream.webp' }
    },

    // dias: usado na página de obrigado para a previsão e a contagem regressiva da entrega
    fretes: {
      gratis: { nome: 'Frete grátis', prazo: 'Entrega em até 7 dias úteis', valor: 0, dias: 7 },
      sedex:  { nome: 'Sedex', prazo: 'Entrega em até 3 dias úteis', valor: 19.90, dias: 3 }
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SHOP_CONFIG;
  else root.SHOP_CONFIG = SHOP_CONFIG;
})(this);

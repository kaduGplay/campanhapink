/* Pixel da Meta. Requer shop-config.js antes deste arquivo.
   Eventos com ID são enviados uma vez por navegador; o servidor usa o mesmo ID
   na API de Conversões para a Meta deduplicar. Prévias locais não enviam nada. */
(function () {
  var id = window.SHOP_CONFIG && window.SHOP_CONFIG.metaPixelId;
  var local = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) !== -1;
  var enviados = {};
  function jaEnviado(eventId) {
    try { return enviados[eventId] || localStorage.getItem('meta:' + eventId) === '1'; } catch (e) { return enviados[eventId]; }
  }
  function marcar(eventId) {
    enviados[eventId] = true;
    try { localStorage.setItem('meta:' + eventId, '1'); } catch (e) {}
  }
  window.PinkMeta = {
    // servidor: corpo enviado a /api/meta/event para a API de Conversões
    track: function (nome, params, eventId, servidor) {
      if (!id || local || (eventId && jaEnviado(eventId))) return;
      if (eventId) marcar(eventId);
      try { window.fbq('track', nome, params || {}, eventId ? { eventID: eventId } : undefined); } catch (e) {}
      if (servidor) {
        try {
          fetch('/api/meta/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(servidor), keepalive: true }).catch(function () {});
        } catch (e) {}
      }
    }
  };
  if (!id || local) return;
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0;
    t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  window.fbq('init', id);
  window.fbq('track', 'PageView');
})();

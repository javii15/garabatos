// Punto de entrada en Cloudflare: la web la sirve "assets" (carpeta public/)
// y aquí solo se atienden la creación de salas y las conexiones en tiempo real.
export { Sala } from './sala.js';

const LETRAS_CODIGO = 'abcdefghjkmnpqrstuvwxyz';

function nuevoCodigo() {
  const azar = crypto.getRandomValues(new Uint32Array(5));
  return Array.from(azar, (n) => LETRAS_CODIGO[n % LETRAS_CODIGO.length]).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/crear' && request.method === 'POST') {
      for (let intento = 0; intento < 5; intento++) {
        const codigo = nuevoCodigo();
        const sala = env.SALAS.get(env.SALAS.idFromName(codigo));
        if (await sala.crear(codigo)) return Response.json({ codigo });
      }
      return Response.json({ error: 'No se pudo crear la sala, inténtalo otra vez' }, { status: 503 });
    }

    const enlace = url.pathname.match(/^\/ws\/([a-z]{5})$/);
    if (enlace) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Se esperaba WebSocket', { status: 426 });
      return env.SALAS.get(env.SALAS.idFromName(enlace[1])).fetch(request);
    }

    return new Response('No encontrado', { status: 404 });
  },
};

// Simula varios jugadores conectados a la vez y recorre una partida completa
// contra el servidor de Cloudflare ejecutado en local (wrangler dev).
// Uso: npm test
const { spawn } = require('child_process');
const path = require('path');

const PUERTO = 8799;
const URL = `http://localhost:${PUERTO}`;
const normalizar = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
let fallos = 0;

function ok(condicion, texto) {
  console.log(`${condicion ? '✅' : '❌'} ${texto}`);
  if (!condicion) fallos++;
}

function jugador() {
  const s = { estado: null, chats: [], trazos: [], esperando: new Map(), siguienteId: 1, cerradoCon: null };
  s.conectar = (codigo) =>
    new Promise((res, rej) => {
      s.ws = new WebSocket(`ws://localhost:${PUERTO}/ws/${codigo}`);
      s.ws.onopen = () => res();
      s.ws.onerror = () => rej(new Error('No se pudo conectar'));
      s.ws.onclose = (e) => (s.cerradoCon = e.code);
      s.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'respuesta') { s.esperando.get(m.id)(m.d); s.esperando.delete(m.id); }
        else if (m.t === 'estado') s.estado = m.d;
        else if (m.t === 'chat') s.chats.push(m.d);
        else if (m.t === 'trazo:inicio' || m.t === 'trazo:puntos') s.trazos.push(m.d);
      };
    });
  s.emit = (t, d) => s.ws.send(JSON.stringify({ t, d }));
  s.pedir = (t, d) => new Promise((res) => {
    const id = s.siguienteId++;
    s.esperando.set(id, res);
    s.ws.send(JSON.stringify({ t, d, id }));
  });
  s.entrar = async (codigo, datos) => { await s.conectar(codigo); return s.pedir('sala:entrar', datos); };
  s.desconectar = () => s.ws.close();
  return s;
}

function esperar(s, condicion, ms = 15000) {
  return new Promise((res, rej) => {
    const inicio = Date.now();
    const t = setInterval(() => {
      if (s.estado && condicion(s.estado)) { clearInterval(t); res(s.estado); }
      else if (Date.now() - inicio > ms) { clearInterval(t); rej(new Error('Tiempo de espera agotado')); }
    }, 20);
  });
}
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function arrancarServidor() {
  const vars = ['DRAW_TIME:3', 'CHOOSE_TIME:1', 'TURNEND_TIME:1', 'GRACE_TIME:2'].flatMap((v) => ['--var', v]);
  const servidor = spawn(path.join(__dirname, '..', 'node_modules', '.bin', 'wrangler'), ['dev', '--port', String(PUERTO), '--persist-to', path.join(require('os').tmpdir(), 'garabatos-test-' + Date.now()), ...vars], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    await pausa(300);
    try { if ((await fetch(URL)).ok) return servidor; } catch { /* aún arrancando */ }
  }
  throw new Error('El servidor local no arrancó');
}

async function main() {
  const servidor = await arrancarServidor();
  try {
    const pagina = await fetch(`${URL}/sala/abcde`);
    ok(pagina.ok && (await pagina.text()).includes('Garabatos'), 'La URL /sala/abcde sirve la web');

    const ana = jugador();
    const beto = jugador();
    const carla = jugador();

    const { codigo } = await (await fetch(`${URL}/api/crear`, { method: 'POST' })).json();
    ok(/^[a-z]{5}$/.test(codigo), `Sala creada con código de 5 letras: ${codigo}`);
    const r1 = await ana.entrar(codigo, { nombre: 'Ana', color: '#ff6b6b' });
    ok(r1.ok, 'Ana entra en su sala');

    const fantasma = jugador();
    const mal = await fantasma.entrar('zzzzz', { nombre: 'Beto' });
    ok(Boolean(mal.error), 'Código inexistente da error');

    const rB = await beto.entrar(codigo, { nombre: 'Beto' });
    ok(rB.ok, 'Beto entra');
    const repetido = await carla.entrar(codigo, { nombre: 'ana' });
    ok(Boolean(repetido.error), 'No se permite repetir nombre');
    const rC = await carla.pedir('sala:entrar', { nombre: 'Carla', color: '#2e86de' });
    ok(rC.ok, 'Carla entra');

    await esperar(ana, (e) => e.jugadores.length === 3);
    ok(ana.estado.anfitrionId === ana.estado.tuId, 'Ana es la anfitriona');

    beto.emit('partida:empezar');
    await pausa(200);
    ok(ana.estado.fase === 'espera', 'Solo la anfitriona puede empezar');

    ana.emit('partida:empezar');
    const todos = [ana, beto, carla];
    await esperar(ana, (e) => e.fase === 'eligiendo');
    await pausa(100);
    const dibujante = todos.find((s) => s.estado.dibujanteId === s.estado.tuId);
    const adivinos = todos.filter((s) => s !== dibujante);
    ok(dibujante && dibujante.estado.opciones.length === 3, 'El dibujante recibe 3 palabras');
    ok(adivinos.every((s) => s.estado.opciones === null && s.estado.palabra === null), 'Los demás no ven las opciones');

    dibujante.emit('palabra:elegir', 0);
    await esperar(dibujante, (e) => e.fase === 'dibujando');
    await pausa(100);
    const palabra = dibujante.estado.palabra;
    ok(Boolean(palabra), `El dibujante ve la palabra: «${palabra}»`);
    ok(adivinos.every((s) => s.estado.palabra === null && s.estado.pista.every((l) => l === '_' || l === ' ')), 'Los que adivinan solo ven huecos');

    dibujante.emit('trazo:inicio', { c: '#e53935', g: 12, x: 0.1, y: 0.1 });
    dibujante.emit('trazo:puntos', [0.2, 0.2, 0.3, 0.3]);
    adivinos[0].emit('trazo:inicio', { c: '#e53935', g: 12, x: 0.5, y: 0.5 });
    await pausa(200);
    ok(adivinos[1].trazos.length === 2, 'El dibujo llega en tiempo real a los demás');
    ok(dibujante.trazos.length === 0, 'Quien no dibuja no puede pintar');

    // "¡Casi!": cambiamos una letra
    const [g1, g2] = adivinos;
    const casi = palabra.slice(0, -1) + (palabra.endsWith('x') ? 'y' : 'x');
    g1.emit('chat', casi);
    await pausa(200);
    ok(g1.chats.some((m) => m.tipo === 'casi'), `«${casi}» recibe el aviso ¡Casi!`);
    ok(!g2.chats.some((m) => m.tipo === 'casi'), 'El ¡Casi! solo lo ve quien escribe');

    // Acierto con mayúsculas, sin tildes y con espacios de más
    const escrita = `  ${normalizar(palabra).toUpperCase().replace(/ /g, '   ')}  `;
    g1.emit('chat', escrita);
    await esperar(g1, (e) => e.jugadores.find((j) => j.id === e.tuId).acertado);
    const puntosG1 = g1.estado.jugadores.find((j) => j.id === g1.estado.tuId).puntos;
    const puntosDib = g1.estado.jugadores.find((j) => j.id === dibujante.estado.tuId).puntos;
    ok(puntosG1 > 50, `Acierto con «${escrita.trim()}» suma ${puntosG1} puntos`);
    ok(puntosDib === 50, 'El dibujante gana 50 por el acierto');
    ok(!g2.chats.some((m) => m.texto && m.texto.includes(escrita.trim())), 'La respuesta correcta no se muestra a los demás');

    g1.emit('chat', 'ya lo sé jeje');
    await pausa(200);
    ok(!g2.chats.some((m) => m.texto === 'ya lo sé jeje'), 'Quien ya acertó no puede chivarla a los demás');
    ok(dibujante.chats.some((m) => m.texto === 'ya lo sé jeje'), '…pero el dibujante sí lo lee');

    // Recarga de página de g2: se desconecta y vuelve con su identificador
    const idG2 = g2.estado.tuId;
    const nombreG2 = g2.estado.jugadores.find((j) => j.id === idG2).nombre;
    g2.desconectar();
    await pausa(300);
    const g2b = jugador();
    const vuelta = await g2b.entrar(codigo, { nombre: nombreG2, jugadorId: idG2 });
    ok(vuelta.ok && vuelta.jugadorId === idG2, 'Tras recargar vuelve como el mismo jugador');
    await esperar(g2b, (e) => e.fase === 'dibujando');
    ok(g2b.estado.palabra === null, 'Al volver sigue sin ver la palabra');

    // Si vuelve a entrar sin haberse cerrado la conexión anterior, la vieja se sustituye
    const g2c = jugador();
    const doble = await g2c.entrar(codigo, { nombre: nombreG2, jugadorId: idG2 });
    await pausa(200);
    ok(doble.ok && g2b.cerradoCon === 4000, 'Una conexión colgada se sustituye por la nueva');

    g2c.emit('chat', palabra);
    const finTurno = await esperar(dibujante, (e) => e.fase === 'finTurno');
    ok(finTurno.motivoFin === 'todos', 'El turno termina cuando todos aciertan');
    await esperar(g2c, (e) => e.fase === 'finTurno');
    ok(g2c.estado.palabra === palabra, 'Al acabar el turno todos ven la palabra');

    // Pistas: en el siguiente turno, si nadie acierta, se revelan letras
    const otros = [ana, beto, g2c];
    await esperar(ana, (e) => e.fase === 'dibujando', 5000);
    await pausa(2700);
    const adivino = otros.find((s) => s.estado.dibujanteId !== s.estado.tuId);
    const reveladas = adivino.estado.pista ? adivino.estado.pista.filter((l) => l !== '_' && l !== ' ').length : 0;
    const largo = adivino.estado.pista ? adivino.estado.pista.filter((l) => l !== ' ').length : 0;
    ok(largo < 2 || reveladas > 0, `Pistas progresivas: ${reveladas} letra(s) revelada(s) de ${largo}`);

    // Dejamos correr la partida hasta el final (3 vueltas)
    const fin = await esperar(ana, (e) => e.fase === 'final', 60000);
    ok(fin.vuelta === 3, 'La partida termina tras 3 vueltas');
    const yo2 = fin.jugadores.find((j) => j.id === idG2);
    ok(yo2.puntos > 0, `Los puntos se conservan tras recargar (${nombreG2}: ${yo2.puntos})`);

    ana.emit('partida:otraVez');
    const espera = await esperar(ana, (e) => e.fase === 'espera');
    ok(espera.jugadores.every((j) => j.puntos === 0), '«Jugar otra vez» vuelve a la sala con marcador a cero');

    // Si se queda un único jugador conectado, la partida termina sola
    ana.emit('partida:empezar');
    await esperar(ana, (e) => e.fase === 'eligiendo');
    beto.desconectar();
    g2c.desconectar();
    const solo = await esperar(ana, (e) => e.fase === 'final', 6000);
    ok(solo.fase === 'final', 'Con un solo jugador conectado la partida acaba');
    ana.desconectar();
  } catch (e) {
    ok(false, 'Error inesperado: ' + e.message);
  } finally {
    servidor.kill();
    console.log(fallos ? `\n${fallos} prueba(s) fallida(s)` : '\nTodo correcto 🎉');
    process.exit(fallos ? 1 : 0);
  }
}

main();

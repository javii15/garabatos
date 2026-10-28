// Simula varios jugadores conectados a la vez y recorre una partida completa.
// Uso: npm test
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const normalizar = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const PUERTO = 3999;
const URL = `http://localhost:${PUERTO}`;
let fallos = 0;

function ok(condicion, texto) {
  console.log(`${condicion ? '✅' : '❌'} ${texto}`);
  if (!condicion) fallos++;
}

function jugador() {
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  s.estado = null;
  s.chats = [];
  s.trazos = [];
  s.on('estado', (e) => (s.estado = e));
  s.on('chat', (m) => s.chats.push(m));
  s.on('trazo:inicio', (t) => s.trazos.push(t));
  s.on('trazo:puntos', (p) => s.trazos.push(p));
  return s;
}

const pedir = (s, evento, datos) => new Promise((res) => s.emit(evento, datos, res));

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

async function main() {
  const servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: PUERTO, DRAW_TIME: 3, CHOOSE_TIME: 1, TURNEND_TIME: 1, GRACE_TIME: 2 },
    stdio: 'inherit',
  });
  await pausa(800);

  try {
    const pagina = await fetch(`${URL}/sala/abcde`);
    ok(pagina.ok && (await pagina.text()).includes('Garabatos'), 'La URL /sala/abcde sirve la web');

    const ana = jugador();
    const beto = jugador();
    const carla = jugador();

    const r1 = await pedir(ana, 'sala:crear', { nombre: 'Ana', color: '#ff6b6b' });
    ok(/^[a-z]{5}$/.test(r1.codigo), `Sala creada con código de 5 letras: ${r1.codigo}`);
    const codigo = r1.codigo;

    const mal = await pedir(beto, 'sala:entrar', { nombre: 'Beto', codigo: 'zzzzz' });
    ok(Boolean(mal.error), 'Código inexistente da error');
    const rB = await pedir(beto, 'sala:entrar', { nombre: 'Beto', codigo: codigo.toUpperCase() });
    ok(rB.ok, 'Beto entra (código en mayúsculas)');
    const repetido = await pedir(carla, 'sala:entrar', { nombre: 'ana', codigo });
    ok(Boolean(repetido.error), 'No se permite repetir nombre');
    const rC = await pedir(carla, 'sala:entrar', { nombre: 'Carla', codigo, color: '#2e86de' });
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
    g2.disconnect();
    await pausa(300);
    const g2b = jugador();
    const vuelta = await pedir(g2b, 'sala:entrar', { nombre: nombreG2, codigo, jugadorId: idG2 });
    ok(vuelta.ok && vuelta.jugadorId === idG2, 'Tras recargar vuelve como el mismo jugador');
    await esperar(g2b, (e) => e.fase === 'dibujando');
    ok(g2b.estado.palabra === null, 'Al volver sigue sin ver la palabra');

    g2b.emit('chat', palabra);
    const finTurno = await esperar(dibujante, (e) => e.fase === 'finTurno');
    ok(finTurno.motivoFin === 'todos', 'El turno termina cuando todos aciertan');
    ok(g2b.estado.palabra === palabra, 'Al acabar el turno todos ven la palabra');

    // Pistas: en el siguiente turno, si nadie acierta, se revelan letras
    const otros = [ana, beto, g2b];
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
    beto.disconnect();
    g2b.disconnect();
    const solo = await esperar(ana, (e) => e.fase === 'final', 6000);
    ok(solo.fase === 'final', 'Con un solo jugador conectado la partida acaba');
    ana.disconnect();
  } catch (e) {
    ok(false, 'Error inesperado: ' + e.message);
  } finally {
    servidor.kill();
    console.log(fallos ? `\n${fallos} prueba(s) fallida(s)` : '\nTodo correcto 🎉');
    process.exit(fallos ? 1 : 0);
  }
}

main();

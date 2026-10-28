const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const PALABRAS = require('./words');

const PORT = process.env.PORT || 3000;

// Tiempos en segundos (se pueden acortar con variables de entorno para las pruebas)
const T = {
  dibujo: Number(process.env.DRAW_TIME) || 80,
  eleccion: Number(process.env.CHOOSE_TIME) || 15,
  finTurno: Number(process.env.TURNEND_TIME) || 6,
  gracia: Number(process.env.GRACE_TIME) || 20,
  salaVacia: Number(process.env.EMPTY_ROOM_TIME) || 600,
};
const VUELTAS = 3;
const MIN_JUGADORES = 2;
const MAX_JUGADORES = 8;

const COLORES_JUGADOR = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#10ac84', '#48dbfb', '#2e86de', '#5f27cd', '#ff9ff3', '#8395a7'];
const COLORES_PINCEL = ['#222222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#29b6f6', '#1e40af', '#8e24aa', '#ec407a', '#795548', '#ffffff'];
const GROSORES = [4, 12, 28];
const LETRAS_CODIGO = 'abcdefghjkmnpqrstuvwxyz';
const MAX_PUNTOS_LIENZO = 150000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/sala/:codigo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

/** @type {Map<string, any>} */
const salas = new Map();

// ---------- utilidades ----------

function normalizar(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distancia de edición (Levenshtein) para detectar el "¡Casi!"
function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function nuevoCodigo() {
  let codigo;
  do {
    codigo = Array.from({ length: 5 }, () => LETRAS_CODIGO[crypto.randomInt(LETRAS_CODIGO.length)]).join('');
  } while (salas.has(codigo));
  return codigo;
}

function limpiarNombre(nombre) {
  return String(nombre || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function aleatorio(lista) {
  return lista[crypto.randomInt(lista.length)];
}

function conectados(sala) {
  return sala.jugadores.filter((j) => j.conectado);
}

function buscar(sala, id) {
  return sala.jugadores.find((j) => j.id === id);
}

function enPartida(sala) {
  return sala.fase === 'eligiendo' || sala.fase === 'dibujando' || sala.fase === 'finTurno';
}

function pararTemporizadores(sala) {
  clearTimeout(sala.temporizador);
  sala.pistas.forEach(clearTimeout);
  sala.pistas = [];
}

// ---------- estado que se envía a cada jugador ----------

function pistaVisible(sala) {
  if (!sala.palabra) return null;
  return [...sala.palabra].map((letra, i) => {
    if (letra === ' ') return ' ';
    return sala.reveladas.has(i) ? letra : '_';
  });
}

function asegurarAnfitrion(sala) {
  const anfitrion = buscar(sala, sala.anfitrionId);
  if (!anfitrion || !anfitrion.conectado) {
    const otro = sala.jugadores.find((j) => j.conectado);
    if (otro) sala.anfitrionId = otro.id;
  }
}

function estadoPara(sala, jugador) {
  const dibuja = jugador.id === sala.dibujanteId;
  const verPalabra = dibuja || jugador.acertado || sala.fase === 'finTurno';
  return {
    codigo: sala.codigo,
    fase: sala.fase,
    vuelta: sala.vuelta,
    vueltas: VUELTAS,
    anfitrionId: sala.anfitrionId,
    tuId: jugador.id,
    dibujanteId: sala.dibujanteId,
    jugadores: sala.jugadores.map((j) => ({
      id: j.id,
      nombre: j.nombre,
      color: j.color,
      puntos: j.puntos,
      puntosTurno: j.puntosTurno,
      conectado: j.conectado,
      acertado: j.acertado,
    })),
    pista: sala.fase === 'dibujando' ? pistaVisible(sala) : null,
    palabra: verPalabra ? sala.palabra : null,
    opciones: dibuja && sala.fase === 'eligiendo' ? sala.opciones : null,
    tiempoRestante: Math.max(0, sala.terminaEn - Date.now()),
    tiempoTotal: sala.fase === 'dibujando' ? T.dibujo * 1000 : sala.fase === 'eligiendo' ? T.eleccion * 1000 : T.finTurno * 1000,
    motivoFin: sala.fase === 'finTurno' ? sala.motivoFin : null,
    minJugadores: MIN_JUGADORES,
    maxJugadores: MAX_JUGADORES,
  };
}

function enviarEstado(sala) {
  asegurarAnfitrion(sala);
  for (const j of sala.jugadores) {
    if (j.conectado && j.socketId) io.to(j.socketId).emit('estado', estadoPara(sala, j));
  }
}

function avisoSala(sala, texto, tipo = 'sistema') {
  io.to(sala.codigo).emit('chat', { tipo, texto });
}

// ---------- flujo de la partida ----------

function empezarPartida(sala) {
  for (const j of sala.jugadores) {
    j.puntos = 0;
    j.puntosTurno = 0;
    j.acertado = false;
  }
  sala.vuelta = 0;
  sala.cola = [];
  sala.usadas = new Set();
  avisoSala(sala, '¡Empieza la partida! 🎨');
  siguienteTurno(sala);
}

function siguienteTurno(sala) {
  pararTemporizadores(sala);
  for (const j of sala.jugadores) {
    j.acertado = false;
    j.puntosTurno = 0;
  }
  sala.palabra = null;
  sala.opciones = null;
  sala.dibujanteId = null;
  sala.trazos = [];
  io.to(sala.codigo).emit('lienzo:borrar');

  if (conectados(sala).length < MIN_JUGADORES) return terminarPartida(sala);

  let dibujante = null;
  while (!dibujante) {
    if (sala.cola.length === 0) {
      if (sala.vuelta >= VUELTAS) return terminarPartida(sala);
      sala.vuelta++;
      sala.cola = conectados(sala).map((j) => j.id);
      avisoSala(sala, `Vuelta ${sala.vuelta} de ${VUELTAS}`);
    }
    const candidato = buscar(sala, sala.cola.shift());
    if (candidato && candidato.conectado) dibujante = candidato;
  }

  const disponibles = PALABRAS.filter((p) => !sala.usadas.has(p));
  const opciones = [];
  while (opciones.length < 3) {
    const p = aleatorio(disponibles.length >= 3 ? disponibles : PALABRAS);
    if (!opciones.includes(p)) opciones.push(p);
  }

  sala.fase = 'eligiendo';
  sala.dibujanteId = dibujante.id;
  sala.opciones = opciones;
  sala.terminaEn = Date.now() + T.eleccion * 1000;
  sala.temporizador = setTimeout(() => elegirPalabra(sala, crypto.randomInt(3)), T.eleccion * 1000);
  avisoSala(sala, `${dibujante.nombre} está eligiendo una palabra…`);
  enviarEstado(sala);
}

function elegirPalabra(sala, indice) {
  if (sala.fase !== 'eligiendo') return;
  pararTemporizadores(sala);
  const palabra = sala.opciones[indice] || sala.opciones[0];
  sala.usadas.add(palabra);
  sala.palabra = palabra;
  sala.opciones = null;
  sala.reveladas = new Set();
  sala.fase = 'dibujando';
  sala.inicioDibujo = Date.now();
  sala.terminaEn = Date.now() + T.dibujo * 1000;
  sala.temporizador = setTimeout(() => terminarTurno(sala, 'tiempo'), T.dibujo * 1000);

  // Pistas progresivas: se revelan letras en varios momentos del turno
  const posiciones = [...palabra].map((l, i) => (l === ' ' ? -1 : i)).filter((i) => i >= 0);
  const numPistas = Math.min(3, Math.floor(posiciones.length / 2));
  const momentos = [0.45, 0.65, 0.82].slice(0, numPistas);
  sala.pistas = momentos.map((fraccion) =>
    setTimeout(() => {
      const ocultas = posiciones.filter((i) => !sala.reveladas.has(i));
      if (ocultas.length > 1) {
        sala.reveladas.add(aleatorio(ocultas));
        enviarEstado(sala);
      }
    }, fraccion * T.dibujo * 1000)
  );

  const dibujante = buscar(sala, sala.dibujanteId);
  avisoSala(sala, `¡${dibujante ? dibujante.nombre : 'Alguien'} está dibujando!`);
  enviarEstado(sala);
}

function terminarTurno(sala, motivo) {
  if (sala.fase !== 'dibujando' && sala.fase !== 'eligiendo') return;
  pararTemporizadores(sala);
  const habiaPalabra = Boolean(sala.palabra);
  sala.fase = 'finTurno';
  sala.motivoFin = motivo;
  sala.terminaEn = Date.now() + T.finTurno * 1000;
  if (habiaPalabra) avisoSala(sala, `La palabra era «${sala.palabra}»`, 'revelar');
  sala.temporizador = setTimeout(() => siguienteTurno(sala), T.finTurno * 1000);
  enviarEstado(sala);
}

function terminarPartida(sala) {
  pararTemporizadores(sala);
  sala.fase = 'final';
  sala.palabra = null;
  sala.opciones = null;
  sala.dibujanteId = null;
  sala.cola = [];
  avisoSala(sala, '¡Fin de la partida!');
  enviarEstado(sala);
}

function volverALaEspera(sala) {
  pararTemporizadores(sala);
  sala.jugadores = sala.jugadores.filter((j) => j.conectado);
  for (const j of sala.jugadores) {
    j.puntos = 0;
    j.puntosTurno = 0;
    j.acertado = false;
  }
  sala.fase = 'espera';
  sala.vuelta = 0;
  sala.trazos = [];
  io.to(sala.codigo).emit('lienzo:borrar');
  enviarEstado(sala);
}

function comprobarTodosAcertaron(sala) {
  if (sala.fase !== 'dibujando') return;
  const adivinadores = conectados(sala).filter((j) => j.id !== sala.dibujanteId);
  if (adivinadores.length > 0 && adivinadores.every((j) => j.acertado)) terminarTurno(sala, 'todos');
}

// ---------- chat y respuestas ----------

function mensaje(sala, jugador, textoBruto) {
  const texto = String(textoBruto || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!texto) return;
  const base = { nombre: jugador.nombre, color: jugador.color, texto };

  if (sala.fase === 'dibujando') {
    const esDibujante = jugador.id === sala.dibujanteId;
    if (esDibujante || jugador.acertado) {
      // Solo lo ven quienes ya conocen la palabra, para no chivarla
      for (const j of sala.jugadores) {
        if (j.conectado && (j.id === sala.dibujanteId || j.acertado)) io.to(j.socketId).emit('chat', { ...base, tipo: 'secreto' });
      }
      return;
    }
    const intento = normalizar(texto);
    const solucion = normalizar(sala.palabra);
    if (intento === solucion) {
      const transcurrido = Date.now() - sala.inicioDibujo;
      const fraccionRestante = Math.max(0, 1 - transcurrido / (T.dibujo * 1000));
      const yaAcertaron = sala.jugadores.filter((j) => j.acertado).length;
      const puntos = Math.round(50 + 250 * fraccionRestante) + Math.max(0, 30 - yaAcertaron * 10);
      jugador.acertado = true;
      jugador.puntos += puntos;
      jugador.puntosTurno = puntos;
      const dibujante = buscar(sala, sala.dibujanteId);
      if (dibujante) {
        dibujante.puntos += 50;
        dibujante.puntosTurno += 50;
      }
      avisoSala(sala, `¡${jugador.nombre} ha acertado! (+${puntos})`, 'acierto');
      enviarEstado(sala);
      comprobarTodosAcertaron(sala);
      return;
    }
    io.to(sala.codigo).emit('chat', { ...base, tipo: 'mensaje' });
    if (distancia(intento, solucion) === 1) {
      io.to(jugador.socketId).emit('chat', { tipo: 'casi', texto: `¡Casi! «${texto}» está muy cerca` });
    }
    return;
  }

  io.to(sala.codigo).emit('chat', { ...base, tipo: 'mensaje' });
}

// ---------- conexiones ----------

function salaYJugador(socket) {
  const sala = salas.get(socket.data.codigo);
  if (!sala) return {};
  const jugador = buscar(sala, socket.data.jugadorId);
  if (!jugador || jugador.socketId !== socket.id) return {};
  return { sala, jugador };
}

function salir(socket, { voluntario }) {
  const { sala, jugador } = salaYJugador(socket);
  socket.data.codigo = null;
  if (!sala) return;
  socket.leave(sala.codigo);
  jugador.conectado = false;
  jugador.socketId = null;

  if (voluntario && !enPartida(sala)) {
    sala.jugadores = sala.jugadores.filter((j) => j !== jugador);
    avisoSala(sala, `${jugador.nombre} ha salido de la sala`);
  } else {
    avisoSala(sala, `${jugador.nombre} se ha desconectado`);
    clearTimeout(jugador.temporizadorGracia);
    jugador.temporizadorGracia = setTimeout(() => finGracia(sala, jugador), (voluntario ? 0 : T.gracia) * 1000);
  }
  revisarSalaVacia(sala);
  enviarEstado(sala);
}

// Si alguien no vuelve tras el periodo de gracia
function finGracia(sala, jugador) {
  if (jugador.conectado || !salas.has(sala.codigo)) return;
  if (sala.fase === 'espera') {
    sala.jugadores = sala.jugadores.filter((j) => j !== jugador);
  } else if (enPartida(sala)) {
    if (conectados(sala).length < MIN_JUGADORES) {
      avisoSala(sala, 'No quedan suficientes jugadores conectados');
      return terminarPartida(sala);
    }
    if (sala.dibujanteId === jugador.id && (sala.fase === 'dibujando' || sala.fase === 'eligiendo')) {
      avisoSala(sala, `${jugador.nombre} no ha vuelto: se salta su turno`);
      return terminarTurno(sala, 'dibujanteFuera');
    }
    comprobarTodosAcertaron(sala);
  }
  enviarEstado(sala);
}

function revisarSalaVacia(sala) {
  clearTimeout(sala.temporizadorBorrado);
  if (conectados(sala).length === 0) {
    sala.temporizadorBorrado = setTimeout(() => {
      if (conectados(sala).length === 0) {
        pararTemporizadores(sala);
        sala.jugadores.forEach((j) => clearTimeout(j.temporizadorGracia));
        salas.delete(sala.codigo);
      }
    }, T.salaVacia * 1000);
  }
}

function entrar(socket, datos, responder) {
  const codigo = String(datos.codigo || '').toLowerCase().replace(/[^a-z]/g, '');
  const sala = salas.get(codigo);
  if (!sala) return responder({ error: 'Esa sala no existe. Revisa el código.' });
  const nombre = limpiarNombre(datos.nombre);
  if (!nombre) return responder({ error: 'Escribe tu nombre' });
  const color = COLORES_JUGADOR.includes(datos.color) ? datos.color : COLORES_JUGADOR[0];

  if (socket.data.codigo) salir(socket, { voluntario: false });

  // ¿Es alguien que vuelve? Por identificador o, si no, por nombre de un jugador desconectado
  let jugador = sala.jugadores.find((j) => j.id === datos.jugadorId && !j.conectado);
  if (!jugador) jugador = sala.jugadores.find((j) => !j.conectado && normalizar(j.nombre) === normalizar(nombre));
  const vuelve = Boolean(jugador);

  if (!jugador) {
    if (sala.jugadores.some((j) => normalizar(j.nombre) === normalizar(nombre))) {
      return responder({ error: 'Ya hay alguien con ese nombre en la sala' });
    }
    if (sala.jugadores.length >= MAX_JUGADORES) return responder({ error: 'La sala está llena (máximo 8 jugadores)' });
    jugador = { id: crypto.randomUUID(), nombre, puntos: 0, puntosTurno: 0, acertado: false };
    sala.jugadores.push(jugador);
  }

  clearTimeout(jugador.temporizadorGracia);
  clearTimeout(sala.temporizadorBorrado);
  jugador.color = color;
  jugador.conectado = true;
  jugador.socketId = socket.id;
  socket.data.codigo = codigo;
  socket.data.jugadorId = jugador.id;
  socket.join(codigo);
  if (!sala.anfitrionId) sala.anfitrionId = jugador.id;

  responder({ ok: true, codigo, jugadorId: jugador.id });
  socket.emit('lienzo:completo', sala.trazos);
  avisoSala(sala, vuelve ? `${jugador.nombre} ha vuelto 👋` : `${jugador.nombre} se ha unido`);
  enviarEstado(sala);
}

io.on('connection', (socket) => {
  const responderSeguro = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('sala:crear', (datos = {}, cb) => {
    const codigo = nuevoCodigo();
    salas.set(codigo, {
      codigo,
      jugadores: [],
      anfitrionId: null,
      fase: 'espera',
      vuelta: 0,
      cola: [],
      usadas: new Set(),
      dibujanteId: null,
      palabra: null,
      opciones: null,
      reveladas: new Set(),
      trazos: [],
      terminaEn: 0,
      temporizador: null,
      pistas: [],
    });
    entrar(socket, { ...datos, codigo }, responderSeguro(cb));
    const sala = salas.get(codigo);
    if (sala && sala.jugadores.length === 0) salas.delete(codigo);
  });

  socket.on('sala:entrar', (datos = {}, cb) => entrar(socket, datos, responderSeguro(cb)));

  socket.on('sala:salir', () => salir(socket, { voluntario: true }));

  socket.on('partida:empezar', () => {
    const { sala, jugador } = salaYJugador(socket);
    if (!sala || sala.anfitrionId !== jugador.id) return;
    if (sala.fase !== 'espera' && sala.fase !== 'final') return;
    if (conectados(sala).length < MIN_JUGADORES) return;
    empezarPartida(sala);
  });

  socket.on('partida:otraVez', () => {
    const { sala, jugador } = salaYJugador(socket);
    if (!sala || sala.anfitrionId !== jugador.id || sala.fase !== 'final') return;
    volverALaEspera(sala);
  });

  socket.on('palabra:elegir', (indice) => {
    const { sala, jugador } = salaYJugador(socket);
    if (!sala || sala.fase !== 'eligiendo' || sala.dibujanteId !== jugador.id) return;
    const i = Number(indice);
    if (Number.isInteger(i) && i >= 0 && i < 3) elegirPalabra(sala, i);
  });

  socket.on('chat', (texto) => {
    const { sala, jugador } = salaYJugador(socket);
    if (sala) mensaje(sala, jugador, texto);
  });

  // ---- dibujo: solo el dibujante, y solo mientras dibuja ----
  function dibujante() {
    const { sala, jugador } = salaYJugador(socket);
    if (!sala || sala.fase !== 'dibujando' || sala.dibujanteId !== jugador.id) return null;
    return sala;
  }
  const coord = (n) => Math.min(1, Math.max(0, Math.round(Number(n) * 10000) / 10000 || 0));
  const totalPuntos = (sala) => sala.trazos.reduce((s, t) => s + t.p.length, 0);

  socket.on('trazo:inicio', (t = {}) => {
    const sala = dibujante();
    if (!sala || !COLORES_PINCEL.includes(t.c) || !GROSORES.includes(t.g)) return;
    if (totalPuntos(sala) > MAX_PUNTOS_LIENZO) return;
    const trazo = { c: t.c, g: t.g, p: [coord(t.x), coord(t.y)] };
    sala.trazos.push(trazo);
    socket.to(sala.codigo).emit('trazo:inicio', trazo);
  });

  socket.on('trazo:puntos', (puntos) => {
    const sala = dibujante();
    if (!sala || !Array.isArray(puntos) || puntos.length % 2 !== 0 || puntos.length > 400) return;
    const ultimo = sala.trazos[sala.trazos.length - 1];
    if (!ultimo || totalPuntos(sala) > MAX_PUNTOS_LIENZO) return;
    const limpios = puntos.map(coord);
    ultimo.p.push(...limpios);
    socket.to(sala.codigo).emit('trazo:puntos', limpios);
  });

  socket.on('trazo:deshacer', () => {
    const sala = dibujante();
    if (!sala) return;
    sala.trazos.pop();
    io.to(sala.codigo).emit('lienzo:completo', sala.trazos);
  });

  socket.on('lienzo:borrar', () => {
    const sala = dibujante();
    if (!sala) return;
    sala.trazos = [];
    io.to(sala.codigo).emit('lienzo:borrar');
  });

  socket.on('disconnect', () => salir(socket, { voluntario: false }));
});

server.listen(PORT, () => {
  console.log(`Garabatos funcionando en http://localhost:${PORT} (${PALABRAS.length} palabras)`);
});


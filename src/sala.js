// Una sala de juego = un Durable Object de Cloudflare.
// Es la autoridad: guarda la palabra secreta, controla turnos, tiempo y puntos.
// Cuando nadie hace nada, Cloudflare puede "dormir" la sala y se pierde la memoria,
// así que el estado se guarda en su almacenamiento y se recupera al despertar.
import { DurableObject } from 'cloudflare:workers';
import PALABRAS from './palabras.js';

const VUELTAS = 3;
const MIN_JUGADORES = 2;
const MAX_JUGADORES = 8;
const COLORES_JUGADOR = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#10ac84', '#48dbfb', '#2e86de', '#5f27cd', '#ff9ff3', '#8395a7'];
const COLORES_PINCEL = ['#222222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#29b6f6', '#1e40af', '#8e24aa', '#ec407a', '#795548', '#ffffff'];
const GROSORES = [4, 12, 28];
const MAX_PUNTOS_LIENZO = 150000;

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

function azar(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

function aleatorio(lista) {
  return lista[azar(lista.length)];
}

function limpiarNombre(nombre) {
  return String(nombre || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

export class Sala extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Tiempos en segundos (se pueden acortar con variables para las pruebas)
    this.T = {
      dibujo: Number(env.DRAW_TIME) || 80,
      eleccion: Number(env.CHOOSE_TIME) || 15,
      finTurno: Number(env.TURNEND_TIME) || 6,
      gracia: Number(env.GRACE_TIME) || 20,
      salaVacia: Number(env.EMPTY_ROOM_TIME) || 600,
    };
    this.temporizador = null;
    this.pistas = [];
    this.gracias = new Map();
    this.trazos = [];
    // Los "ping" del navegador se contestan sin despertar la sala
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.sala = (await ctx.storage.get('sala')) || null;
      if (this.sala) this.reanudar();
    });
  }

  // ---------- creación (llamada desde index.js) ----------

  async crear(codigo) {
    if (this.sala) return false;
    this.sala = {
      codigo,
      jugadores: [],
      anfitrionId: null,
      fase: 'espera',
      vuelta: 0,
      cola: [],
      usadas: [],
      dibujanteId: null,
      palabra: null,
      opciones: null,
      reveladas: [],
      terminaEn: 0,
      inicioDibujo: 0,
      motivoFin: null,
    };
    await this.ctx.storage.put('sala', this.sala);
    // Si nadie llega a entrar, se borra sola
    await this.ctx.storage.setAlarm(Date.now() + this.T.salaVacia * 1000);
    return true;
  }

  // Tras despertar: reconstruir conexiones y temporizadores
  reanudar() {
    const s = this.sala;
    for (const j of s.jugadores) {
      j.conectado = this.socketsDe(j.id).length > 0;
      if (!j.conectado) this.programarGracia(j);
    }
    const resto = Math.max(0, s.terminaEn - Date.now());
    if (s.fase === 'eligiendo') this.temporizador = setTimeout(() => this.elegirPalabra(azar(3)), resto);
    else if (s.fase === 'dibujando') this.temporizador = setTimeout(() => this.terminarTurno('tiempo'), resto);
    else if (s.fase === 'finTurno') this.temporizador = setTimeout(() => this.siguienteTurno(), resto);
  }

  async alarm() {
    if (this.sala && this.conectados().length === 0) {
      this.pararTemporizadores();
      this.gracias.forEach(clearTimeout);
      this.sala = null;
      await this.ctx.storage.deleteAll();
    }
  }

  // ---------- conexiones ----------

  async fetch() {
    const [cliente, servidor] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(servidor);
    return new Response(null, { status: 101, webSocket: cliente });
  }

  async webSocketMessage(ws, bruto) {
    if (typeof bruto !== 'string' || bruto.length > 20000) return;
    let m;
    try { m = JSON.parse(bruto); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const responder = (d) => { if (m.id) this.enviar(ws, 'respuesta', d, m.id); };

    if (m.t === 'sala:entrar') return this.entrar(ws, m.d || {}, responder);
    if (!this.sala) return;
    const jugador = this.jugadorDe(ws);
    if (!jugador) return;
    const d = m.d;
    const s = this.sala;

    switch (m.t) {
      case 'sala:salir':
        return this.salir(ws, { voluntario: true });
      case 'partida:empezar':
        if (s.anfitrionId !== jugador.id || (s.fase !== 'espera' && s.fase !== 'final')) return;
        if (this.conectados().length < MIN_JUGADORES) return;
        return this.empezarPartida();
      case 'partida:otraVez':
        if (s.anfitrionId === jugador.id && s.fase === 'final') this.volverALaEspera();
        return;
      case 'palabra:elegir': {
        if (s.fase !== 'eligiendo' || s.dibujanteId !== jugador.id) return;
        const i = Number(d);
        if (Number.isInteger(i) && i >= 0 && i < 3) this.elegirPalabra(i);
        return;
      }
      case 'chat':
        return this.mensaje(jugador, d);
    }

    // ---- dibujo: solo el dibujante, y solo mientras dibuja ----
    if (s.fase !== 'dibujando' || s.dibujanteId !== jugador.id) return;
    const coord = (n) => Math.min(1, Math.max(0, Math.round(Number(n) * 10000) / 10000 || 0));
    const totalPuntos = () => this.trazos.reduce((n, t) => n + t.p.length, 0);
    switch (m.t) {
      case 'trazo:inicio': {
        const t = d || {};
        if (!COLORES_PINCEL.includes(t.c) || !GROSORES.includes(t.g) || totalPuntos() > MAX_PUNTOS_LIENZO) return;
        const trazo = { c: t.c, g: t.g, p: [coord(t.x), coord(t.y)] };
        this.trazos.push(trazo);
        return this.aSala('trazo:inicio', trazo, ws);
      }
      case 'trazo:puntos': {
        if (!Array.isArray(d) || d.length % 2 !== 0 || d.length > 400) return;
        const ultimo = this.trazos[this.trazos.length - 1];
        if (!ultimo || totalPuntos() > MAX_PUNTOS_LIENZO) return;
        const limpios = d.map(coord);
        ultimo.p.push(...limpios);
        return this.aSala('trazo:puntos', limpios, ws);
      }
      case 'trazo:deshacer':
        this.trazos.pop();
        return this.aSala('lienzo:completo', this.trazos);
      case 'lienzo:borrar':
        this.trazos = [];
        return this.aSala('lienzo:borrar', null);
    }
  }

  async webSocketClose(ws) {
    this.salir(ws, { voluntario: false });
    try { ws.close(); } catch { /* ya cerrado */ }
  }

  async webSocketError(ws) {
    this.salir(ws, { voluntario: false });
  }

  // ---------- envíos ----------

  enviar(ws, t, d, id) {
    try { ws.send(JSON.stringify(id ? { t, d, id } : { t, d })); } catch { /* conexión caída */ }
  }

  socketsDe(jugadorId) {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.jugadorId === jugadorId);
  }

  aSala(t, d, excepto) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== excepto && ws.deserializeAttachment()?.jugadorId) this.enviar(ws, t, d);
    }
  }

  aJugador(jugador, t, d) {
    for (const ws of this.socketsDe(jugador.id)) this.enviar(ws, t, d);
  }

  aviso(texto, tipo = 'sistema') {
    this.aSala('chat', { tipo, texto });
  }

  // ---------- estado que se envía a cada jugador ----------

  buscar(id) {
    return this.sala.jugadores.find((j) => j.id === id);
  }

  jugadorDe(ws) {
    const id = ws.deserializeAttachment()?.jugadorId;
    return id && this.sala ? this.buscar(id) : null;
  }

  conectados() {
    return this.sala.jugadores.filter((j) => j.conectado);
  }

  enPartida() {
    return ['eligiendo', 'dibujando', 'finTurno'].includes(this.sala.fase);
  }

  pararTemporizadores() {
    clearTimeout(this.temporizador);
    this.pistas.forEach(clearTimeout);
    this.pistas = [];
  }

  // El anfitrión solo cambia si se va del todo o no vuelve tras el periodo de gracia
  asegurarAnfitrion(sinEsperar = false) {
    const s = this.sala;
    const anfitrion = this.buscar(s.anfitrionId);
    if (!anfitrion || (sinEsperar && !anfitrion.conectado)) {
      const otro = s.jugadores.find((j) => j.conectado);
      if (otro) s.anfitrionId = otro.id;
    }
  }

  pistaVisible() {
    const s = this.sala;
    return [...s.palabra].map((letra, i) => (letra === ' ' ? ' ' : s.reveladas.includes(i) ? letra : '_'));
  }

  estadoPara(jugador) {
    const s = this.sala;
    const dibuja = jugador.id === s.dibujanteId;
    const verPalabra = dibuja || jugador.acertado || s.fase === 'finTurno';
    const total = { dibujando: this.T.dibujo, eligiendo: this.T.eleccion, finTurno: this.T.finTurno }[s.fase] || 0;
    return {
      codigo: s.codigo,
      fase: s.fase,
      vuelta: s.vuelta,
      vueltas: VUELTAS,
      anfitrionId: s.anfitrionId,
      tuId: jugador.id,
      dibujanteId: s.dibujanteId,
      jugadores: s.jugadores.map((j) => ({
        id: j.id,
        nombre: j.nombre,
        color: j.color,
        puntos: j.puntos,
        puntosTurno: j.puntosTurno,
        conectado: j.conectado,
        acertado: j.acertado,
      })),
      pista: s.fase === 'dibujando' && s.palabra ? this.pistaVisible() : null,
      palabra: verPalabra ? s.palabra : null,
      opciones: dibuja && s.fase === 'eligiendo' ? s.opciones : null,
      tiempoRestante: Math.max(0, s.terminaEn - Date.now()),
      tiempoTotal: total * 1000,
      motivoFin: s.fase === 'finTurno' ? s.motivoFin : null,
      minJugadores: MIN_JUGADORES,
      maxJugadores: MAX_JUGADORES,
    };
  }

  // Envía a cada uno su versión del estado y lo guarda por si la sala se duerme
  enviarEstado() {
    if (!this.sala) return;
    this.asegurarAnfitrion();
    for (const j of this.sala.jugadores) {
      if (j.conectado) this.aJugador(j, 'estado', this.estadoPara(j));
    }
    this.ctx.storage.put('sala', this.sala);
  }

  // ---------- flujo de la partida ----------

  empezarPartida() {
    const s = this.sala;
    for (const j of s.jugadores) {
      j.puntos = 0;
      j.puntosTurno = 0;
      j.acertado = false;
    }
    s.vuelta = 0;
    s.cola = [];
    s.usadas = [];
    this.aviso('¡Empieza la partida! 🎨');
    this.siguienteTurno();
  }

  siguienteTurno() {
    const s = this.sala;
    this.pararTemporizadores();
    for (const j of s.jugadores) {
      j.acertado = false;
      j.puntosTurno = 0;
    }
    s.palabra = null;
    s.opciones = null;
    s.dibujanteId = null;
    this.trazos = [];
    this.aSala('lienzo:borrar', null);

    if (this.conectados().length < MIN_JUGADORES) return this.terminarPartida();

    let dibujante = null;
    while (!dibujante) {
      if (s.cola.length === 0) {
        if (s.vuelta >= VUELTAS) return this.terminarPartida();
        s.vuelta++;
        s.cola = this.conectados().map((j) => j.id);
        this.aviso(`Vuelta ${s.vuelta} de ${VUELTAS}`);
      }
      const candidato = this.buscar(s.cola.shift());
      if (candidato && candidato.conectado) dibujante = candidato;
    }

    const disponibles = PALABRAS.filter((p) => !s.usadas.includes(p));
    const opciones = [];
    while (opciones.length < 3) {
      const p = aleatorio(disponibles.length >= 3 ? disponibles : PALABRAS);
      if (!opciones.includes(p)) opciones.push(p);
    }

    s.fase = 'eligiendo';
    s.dibujanteId = dibujante.id;
    s.opciones = opciones;
    s.terminaEn = Date.now() + this.T.eleccion * 1000;
    this.temporizador = setTimeout(() => this.elegirPalabra(azar(3)), this.T.eleccion * 1000);
    this.aviso(`${dibujante.nombre} está eligiendo una palabra…`);
    this.enviarEstado();
  }

  elegirPalabra(indice) {
    const s = this.sala;
    if (!s || s.fase !== 'eligiendo') return;
    this.pararTemporizadores();
    const palabra = s.opciones[indice] || s.opciones[0];
    s.usadas.push(palabra);
    s.palabra = palabra;
    s.opciones = null;
    s.reveladas = [];
    s.fase = 'dibujando';
    s.inicioDibujo = Date.now();
    s.terminaEn = Date.now() + this.T.dibujo * 1000;
    this.temporizador = setTimeout(() => this.terminarTurno('tiempo'), this.T.dibujo * 1000);

    // Pistas progresivas: se revelan letras en varios momentos del turno
    const posiciones = [...palabra].map((l, i) => (l === ' ' ? -1 : i)).filter((i) => i >= 0);
    const numPistas = Math.min(3, Math.floor(posiciones.length / 2));
    this.pistas = [0.45, 0.65, 0.82].slice(0, numPistas).map((fraccion) =>
      setTimeout(() => {
        const ocultas = posiciones.filter((i) => !s.reveladas.includes(i));
        if (ocultas.length > 1) {
          s.reveladas.push(aleatorio(ocultas));
          this.enviarEstado();
        }
      }, fraccion * this.T.dibujo * 1000)
    );

    const dibujante = this.buscar(s.dibujanteId);
    this.aviso(`¡${dibujante ? dibujante.nombre : 'Alguien'} está dibujando!`);
    this.enviarEstado();
  }

  terminarTurno(motivo) {
    const s = this.sala;
    if (!s || (s.fase !== 'dibujando' && s.fase !== 'eligiendo')) return;
    this.pararTemporizadores();
    s.fase = 'finTurno';
    s.motivoFin = motivo;
    s.terminaEn = Date.now() + this.T.finTurno * 1000;
    if (s.palabra) this.aviso(`La palabra era «${s.palabra}»`, 'revelar');
    this.temporizador = setTimeout(() => this.siguienteTurno(), this.T.finTurno * 1000);
    this.enviarEstado();
  }

  terminarPartida() {
    const s = this.sala;
    this.pararTemporizadores();
    s.fase = 'final';
    s.palabra = null;
    s.opciones = null;
    s.dibujanteId = null;
    s.cola = [];
    this.aviso('¡Fin de la partida!');
    this.enviarEstado();
  }

  volverALaEspera() {
    const s = this.sala;
    this.pararTemporizadores();
    s.jugadores = s.jugadores.filter((j) => j.conectado);
    for (const j of s.jugadores) {
      j.puntos = 0;
      j.puntosTurno = 0;
      j.acertado = false;
    }
    s.fase = 'espera';
    s.vuelta = 0;
    this.trazos = [];
    this.aSala('lienzo:borrar', null);
    this.enviarEstado();
  }

  comprobarTodosAcertaron() {
    const s = this.sala;
    if (s.fase !== 'dibujando') return;
    const adivinadores = this.conectados().filter((j) => j.id !== s.dibujanteId);
    if (adivinadores.length > 0 && adivinadores.every((j) => j.acertado)) this.terminarTurno('todos');
  }

  // ---------- chat y respuestas ----------

  mensaje(jugador, textoBruto) {
    const s = this.sala;
    const texto = String(textoBruto || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!texto) return;
    const base = { nombre: jugador.nombre, color: jugador.color, texto };

    if (s.fase === 'dibujando') {
      if (jugador.id === s.dibujanteId || jugador.acertado) {
        // Solo lo ven quienes ya conocen la palabra, para no chivarla
        for (const j of s.jugadores) {
          if (j.id === s.dibujanteId || j.acertado) this.aJugador(j, 'chat', { ...base, tipo: 'secreto' });
        }
        return;
      }
      const intento = normalizar(texto);
      const solucion = normalizar(s.palabra);
      if (intento === solucion) {
        const transcurrido = Date.now() - s.inicioDibujo;
        const fraccionRestante = Math.max(0, 1 - transcurrido / (this.T.dibujo * 1000));
        const yaAcertaron = s.jugadores.filter((j) => j.acertado).length;
        const puntos = Math.round(50 + 250 * fraccionRestante) + Math.max(0, 30 - yaAcertaron * 10);
        jugador.acertado = true;
        jugador.puntos += puntos;
        jugador.puntosTurno = puntos;
        const dibujante = this.buscar(s.dibujanteId);
        if (dibujante) {
          dibujante.puntos += 50;
          dibujante.puntosTurno += 50;
        }
        this.aviso(`¡${jugador.nombre} ha acertado! (+${puntos})`, 'acierto');
        this.enviarEstado();
        this.comprobarTodosAcertaron();
        return;
      }
      this.aSala('chat', { ...base, tipo: 'mensaje' });
      if (distancia(intento, solucion) === 1) {
        this.aJugador(jugador, 'chat', { tipo: 'casi', texto: `¡Casi! «${texto}» está muy cerca` });
      }
      return;
    }

    this.aSala('chat', { ...base, tipo: 'mensaje' });
  }

  // ---------- entrar y salir ----------

  entrar(ws, datos, responder) {
    const s = this.sala;
    if (!s) {
      responder({ error: 'Esa sala no existe. Revisa el código.' });
      return ws.close(4004, 'sala inexistente');
    }
    const nombre = limpiarNombre(datos.nombre);
    if (!nombre) return responder({ error: 'Escribe tu nombre' });
    const color = COLORES_JUGADOR.includes(datos.color) ? datos.color : COLORES_JUGADOR[0];

    if (this.jugadorDe(ws)) this.salir(ws, { voluntario: false });

    // ¿Es alguien que vuelve? Por identificador o, si no, por nombre de un jugador desconectado
    let jugador = s.jugadores.find((j) => j.id === datos.jugadorId);
    if (jugador && jugador.conectado) {
      // Su conexión anterior se quedó colgada (p. ej. al recargar): la sustituimos
      for (const viejo of this.socketsDe(jugador.id)) {
        viejo.serializeAttachment(null);
        try { viejo.close(4000, 'sustituida'); } catch { /* ya cerrada */ }
      }
    }
    if (!jugador) jugador = s.jugadores.find((j) => !j.conectado && normalizar(j.nombre) === normalizar(nombre));
    const vuelve = Boolean(jugador);

    if (!jugador) {
      if (s.jugadores.some((j) => normalizar(j.nombre) === normalizar(nombre))) {
        return responder({ error: 'Ya hay alguien con ese nombre en la sala' });
      }
      if (s.jugadores.length >= MAX_JUGADORES) return responder({ error: 'La sala está llena (máximo 8 jugadores)' });
      jugador = { id: crypto.randomUUID(), nombre, puntos: 0, puntosTurno: 0, acertado: false };
      s.jugadores.push(jugador);
    }

    clearTimeout(this.gracias.get(jugador.id));
    this.gracias.delete(jugador.id);
    this.ctx.storage.deleteAlarm();
    jugador.color = color;
    jugador.conectado = true;
    ws.serializeAttachment({ jugadorId: jugador.id });
    if (!s.anfitrionId) s.anfitrionId = jugador.id;

    responder({ ok: true, codigo: s.codigo, jugadorId: jugador.id });
    this.enviar(ws, 'lienzo:completo', this.trazos);
    this.aviso(vuelve ? `${jugador.nombre} ha vuelto 👋` : `${jugador.nombre} se ha unido`);
    this.enviarEstado();
  }

  salir(ws, { voluntario }) {
    const jugador = this.jugadorDe(ws);
    ws.serializeAttachment(null);
    if (!jugador || this.socketsDe(jugador.id).length > 0) return;
    const s = this.sala;
    jugador.conectado = false;

    if (voluntario && !this.enPartida()) {
      s.jugadores = s.jugadores.filter((j) => j !== jugador);
      this.aviso(`${jugador.nombre} ha salido de la sala`);
    } else {
      this.aviso(`${jugador.nombre} se ha desconectado`);
      this.programarGracia(jugador, voluntario ? 0 : this.T.gracia);
    }
    if (this.conectados().length === 0) this.ctx.storage.setAlarm(Date.now() + this.T.salaVacia * 1000);
    this.enviarEstado();
  }

  programarGracia(jugador, segundos = this.T.gracia) {
    clearTimeout(this.gracias.get(jugador.id));
    this.gracias.set(jugador.id, setTimeout(() => this.finGracia(jugador.id), segundos * 1000));
  }

  // Si alguien no vuelve tras el periodo de gracia
  finGracia(id) {
    this.gracias.delete(id);
    const s = this.sala;
    const jugador = s && this.buscar(id);
    if (!jugador || jugador.conectado) return;
    if (s.anfitrionId === id) this.asegurarAnfitrion(true);
    if (s.fase === 'espera') {
      s.jugadores = s.jugadores.filter((j) => j !== jugador);
    } else if (this.enPartida()) {
      if (this.conectados().length < MIN_JUGADORES) {
        this.aviso('No quedan suficientes jugadores conectados');
        return this.terminarPartida();
      }
      if (s.dibujanteId === jugador.id && (s.fase === 'dibujando' || s.fase === 'eligiendo')) {
        this.aviso(`${jugador.nombre} no ha vuelto: se salta su turno`);
        return this.terminarTurno('dibujanteFuera');
      }
      this.comprobarTodosAcertaron();
    }
    this.enviarEstado();
  }
}

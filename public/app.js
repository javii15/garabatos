(() => {
  const COLORES_JUGADOR = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#10ac84', '#48dbfb', '#2e86de', '#5f27cd', '#ff9ff3', '#8395a7'];
  const COLORES_PINCEL = ['#222222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#29b6f6', '#1e40af', '#8e24aa', '#ec407a', '#795548'];
  const GOMA = '#ffffff';
  const GROSORES = [4, 12, 28];

  const $ = (sel) => document.querySelector(sel);
  const crear = (etiqueta, clase, texto) => {
    const el = document.createElement(etiqueta);
    if (clase) el.className = clase;
    if (texto != null) el.textContent = texto;
    return el;
  };

  const almacen = {
    leer(tipo, clave) { try { return window[tipo].getItem(clave); } catch { return null; } },
    guardar(tipo, clave, valor) { try { window[tipo].setItem(clave, valor); } catch { /* sin almacenamiento */ } },
  };

  // ---------- conexión en tiempo real (WebSocket con reconexión automática) ----------
  const socket = (() => {
    const manejadores = {};
    const esperando = new Map();
    let ws = null;
    let siguienteId = 1;
    let reintentos = 0;
    let temporizadorReconexion;
    let alAbrir = null;
    let codigoWs = null;

    function conectar(codigo, cuandoAbra) {
      cerrar();
      codigoWs = codigo;
      alAbrir = cuandoAbra;
      const este = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${codigo}`);
      ws = este;
      este.onopen = () => {
        reintentos = 0;
        $('#sinConexion').classList.add('oculto');
        alAbrir();
      };
      este.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'respuesta') {
          const cb = esperando.get(m.id);
          esperando.delete(m.id);
          if (cb) cb(m.d);
        } else if (manejadores[m.t]) {
          manejadores[m.t](m.d);
        }
      };
      este.onclose = (e) => {
        if (ws !== este) return;
        ws = null;
        if (e.code === 4004) return;
        if (e.code === 4000) {
          aviso('Has abierto esta sala en otra pestaña');
          return;
        }
        if (!salaActual) return;
        $('#sinConexion').classList.remove('oculto');
        clearTimeout(temporizadorReconexion);
        temporizadorReconexion = setTimeout(() => conectar(codigoWs, alAbrir), Math.min(5000, 400 * 2 ** reintentos++));
      };
    }

    function cerrar() {
      clearTimeout(temporizadorReconexion);
      if (ws) {
        const viejo = ws;
        ws = null;
        try { viejo.close(); } catch { /* ya cerrado */ }
      }
    }

    function emit(t, d, cb) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (cb) cb({ error: 'Sin conexión, reintentando…' });
        return;
      }
      const m = { t, d };
      if (cb) {
        m.id = siguienteId++;
        esperando.set(m.id, cb);
      }
      ws.send(JSON.stringify(m));
    }

    // Mantiene viva la conexión y reconecta al volver a la pestaña (móviles)
    setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}'); }, 25000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && salaActual && !ws) {
        reintentos = 0;
        conectar(codigoWs, alAbrir);
      }
    });

    return { conectar, cerrar, emit, on: (t, fn) => (manejadores[t] = fn) };
  })();
  let estado = null;
  let salaActual = null; // { codigo, nombre, color }
  let recibidoEn = 0;
  let colorJugador = almacen.leer('localStorage', 'garabatos:color') || COLORES_JUGADOR[Math.floor(Math.random() * COLORES_JUGADOR.length)];

  // ---------- pantallas ----------
  function mostrar(id) {
    document.querySelectorAll('.pantalla').forEach((p) => p.classList.toggle('activa', p.id === id));
  }

  let temporizadorAviso;
  function aviso(texto) {
    const el = $('#aviso');
    el.textContent = texto;
    el.classList.remove('oculto');
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => el.classList.add('oculto'), 3000);
  }

  function avatar(jugador, clase = 'avatar') {
    const a = crear('div', clase, (jugador.nombre[0] || '?').toUpperCase());
    a.style.background = jugador.color;
    return a;
  }

  // ---------- portada ----------
  const codigoEnUrl = (location.pathname.match(/^\/sala\/([a-z]{5})\/?$/i) || [])[1]?.toLowerCase();
  $('#nombre').value = almacen.leer('localStorage', 'garabatos:nombre') || '';

  function pintarColoresJugador() {
    const cont = $('#coloresJugador');
    cont.replaceChildren();
    for (const c of COLORES_JUGADOR) {
      const b = crear('button', c === colorJugador ? 'sel' : '');
      b.type = 'button';
      b.style.background = c;
      b.setAttribute('aria-label', 'Color ' + c);
      b.onclick = () => { colorJugador = c; almacen.guardar('localStorage', 'garabatos:color', c); pintarColoresJugador(); };
      cont.append(b);
    }
  }
  pintarColoresJugador();

  if (codigoEnUrl) {
    $('#codigo').value = codigoEnUrl;
    $('#invitacionCodigo').textContent = codigoEnUrl.toUpperCase();
    $('#invitacion').classList.remove('oculto');
    $('#bloqueUnirse').classList.add('destacado');
  }

  function datosJugador() {
    const nombre = $('#nombre').value.replace(/\s+/g, ' ').trim();
    if (!nombre) { aviso('Escribe tu nombre primero ✏️'); $('#nombre').focus(); return null; }
    almacen.guardar('localStorage', 'garabatos:nombre', nombre);
    return { nombre, color: colorJugador };
  }

  function alEntrar(respuesta, datos) {
    if (respuesta.error) {
      aviso(respuesta.error);
      salaActual = null;
      socket.cerrar();
      if (location.pathname !== '/') history.replaceState(null, '', '/');
      mostrar('portada');
      return;
    }
    salaActual = { ...datos, codigo: respuesta.codigo };
    almacen.guardar('sessionStorage', 'garabatos:id:' + respuesta.codigo, respuesta.jugadorId);
    if (location.pathname !== '/sala/' + respuesta.codigo) history.replaceState(null, '', '/sala/' + respuesta.codigo);
  }

  function unirse(codigo, datos) {
    const jugadorId = almacen.leer('sessionStorage', 'garabatos:id:' + codigo);
    socket.conectar(codigo, () => {
      const id = almacen.leer('sessionStorage', 'garabatos:id:' + codigo) || jugadorId;
      socket.emit('sala:entrar', { ...datos, jugadorId: id }, (r) => alEntrar(r, datos));
    });
  }

  $('#btnCrear').onclick = () => {
    const datos = datosJugador();
    if (!datos) return;
    $('#btnCrear').disabled = true;
    fetch('/api/crear', { method: 'POST' })
      .then((r) => r.json())
      .then((r) => (r.codigo ? unirse(r.codigo, datos) : aviso(r.error)))
      .catch(() => aviso('No se pudo crear la sala. ¿Tienes conexión?'))
      .finally(() => ($('#btnCrear').disabled = false));
  };
  $('#btnUnirse').onclick = () => {
    const datos = datosJugador();
    if (!datos) return;
    const codigo = $('#codigo').value.toLowerCase().replace(/[^a-z]/g, '');
    if (codigo.length !== 5) { aviso('El código tiene 5 letras'); $('#codigo').focus(); return; }
    unirse(codigo, datos);
  };
  $('#codigo').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnUnirse').click(); });
  $('#nombre').addEventListener('keydown', (e) => { if (e.key === 'Enter') (codigoEnUrl ? $('#btnUnirse') : $('#btnCrear')).click(); });

  // Si recargas la página dentro de una sala, vuelves directamente
  if (codigoEnUrl && almacen.leer('sessionStorage', 'garabatos:id:' + codigoEnUrl) && $('#nombre').value) {
    unirse(codigoEnUrl, { nombre: $('#nombre').value, color: colorJugador });
  }

  document.querySelectorAll('.btnSalir').forEach((b) => (b.onclick = () => {
    socket.emit('sala:salir');
    salaActual = null;
    socket.cerrar();
    estado = null;
    history.replaceState(null, '', '/');
    $('#invitacion').classList.add('oculto');
    $('#bloqueUnirse').classList.remove('destacado');
    $('#codigo').value = '';
    $('#chat').replaceChildren();
    mostrar('portada');
  }));

  // ---------- sala de espera ----------
  function enlaceSala() { return location.origin + '/sala/' + estado.codigo; }
  $('#btnCompartir').onclick = async () => {
    const url = enlaceSala();
    if (navigator.share) {
      try { await navigator.share({ title: 'Garabatos', text: '¡Juega conmigo a Garabatos! 🎨', url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); aviso('¡Enlace copiado! Pégalo en WhatsApp 📋'); }
    catch { prompt('Copia este enlace:', url); }
  };
  $('#btnEmpezar').onclick = () => socket.emit('partida:empezar');
  $('#btnOtraVez').onclick = () => socket.emit('partida:otraVez');

  function pintarEspera() {
    $('#codigoSala').textContent = estado.codigo.toUpperCase();
    $('#contadorJugadores').textContent = `${estado.jugadores.length}/${estado.maxJugadores}`;
    const lista = $('#listaEspera');
    lista.replaceChildren();
    for (const j of estado.jugadores) {
      const li = crear('li', j.conectado ? '' : 'desconectado');
      li.append(avatar(j), crear('span', '', j.nombre));
      if (j.id === estado.anfitrionId) li.append(crear('span', '', '👑'));
      if (j.id === estado.tuId) li.append(crear('span', 'yo', '(tú)'));
      lista.append(li);
    }
    const soyAnfitrion = estado.anfitrionId === estado.tuId;
    const suficientes = estado.jugadores.filter((j) => j.conectado).length >= estado.minJugadores;
    $('#btnEmpezar').classList.toggle('oculto', !soyAnfitrion);
    $('#btnEmpezar').disabled = !suficientes;
    const anfitrion = estado.jugadores.find((j) => j.id === estado.anfitrionId);
    $('#textoEspera').textContent = !suficientes
      ? 'Comparte el enlace: hacen falta al menos 2 jugadores'
      : soyAnfitrion ? 'Cuando estéis todos, pulsa «¡Empezar!»' : `Esperando a que ${anfitrion ? anfitrion.nombre : 'el anfitrión'} empiece…`;
  }

  // ---------- final ----------
  function pintarFinal() {
    const ranking = [...estado.jugadores].sort((a, b) => b.puntos - a.puntos);
    const ganador = ranking[0];
    const empate = ranking.length > 1 && ranking[1].puntos === ganador.puntos;
    $('#ganador').textContent = empate ? '¡Empate en lo más alto!' : `¡${ganador.nombre} gana! 🏆`;
    const podio = $('#podio');
    podio.replaceChildren();
    ranking.forEach((j, i) => {
      const li = crear('li');
      li.append(crear('span', 'medalla', ['🥇', '🥈', '🥉'][i] || `${i + 1}.`), avatar(j), crear('span', '', j.nombre), crear('span', 'pts', `${j.puntos} pts`));
      podio.append(li);
    });
    const soyAnfitrion = estado.anfitrionId === estado.tuId;
    $('#btnOtraVez').classList.toggle('oculto', !soyAnfitrion);
    $('#textoFinal').textContent = soyAnfitrion ? '' : 'El anfitrión puede empezar otra partida';
  }

  // ---------- partida ----------
  const yoDibujo = () => estado && estado.fase === 'dibujando' && estado.dibujanteId === estado.tuId;

  function pintarMarcador() {
    const lista = $('#marcador');
    lista.replaceChildren();
    const ranking = [...estado.jugadores].sort((a, b) => b.puntos - a.puntos);
    ranking.forEach((j, i) => {
      const clases = [];
      if (j.acertado) clases.push('acertado');
      if (j.id === estado.dibujanteId) clases.push('dibuja');
      if (!j.conectado) clases.push('desconectado');
      const li = crear('li', clases.join(' '));
      const info = crear('div', 'info');
      info.append(crear('span', 'nom', j.nombre + (j.id === estado.tuId ? ' (tú)' : '')), crear('span', 'pts', `${j.puntos} pts`));
      li.append(crear('span', 'pos', `#${i + 1}`), avatar(j), info);
      const icono = j.id === estado.dibujanteId ? '✏️' : j.acertado ? '✅' : !j.conectado ? '💤' : '';
      if (icono) li.append(crear('span', 'icono', icono));
      lista.append(li);
    });
  }

  function pintarBarra() {
    $('#vuelta').textContent = `Vuelta ${estado.vuelta}/${estado.vueltas}`;
    const pista = $('#pista');
    pista.replaceChildren();
    const sub = $('#subPista');
    const dibujante = estado.jugadores.find((j) => j.id === estado.dibujanteId);
    if (estado.fase === 'eligiendo') {
      pista.textContent = '🤔';
      sub.textContent = estado.dibujanteId === estado.tuId ? 'Elige qué dibujar' : `${dibujante ? dibujante.nombre : 'Alguien'} está eligiendo`;
    } else if (estado.palabra && estado.fase === 'dibujando') {
      pista.textContent = estado.palabra;
      sub.textContent = yoDibujo() ? '¡Te toca dibujar!' : '¡Has acertado! 🎉';
    } else if (estado.pista) {
      for (const letra of estado.pista) {
        if (letra === ' ') pista.append(crear('span', 'espacio'));
        else pista.append(crear('span', 'hueco', letra === '_' ? ' ' : letra));
      }
      const letras = estado.pista.filter((l) => l !== ' ').length;
      sub.textContent = `${letras} letras · dibuja ${dibujante ? dibujante.nombre : '…'}`;
    } else {
      pista.textContent = estado.palabra || '';
      sub.textContent = '';
    }
  }

  function pintarCapa() {
    const capa = $('#capa');
    capa.replaceChildren();
    const dibujante = estado.jugadores.find((j) => j.id === estado.dibujanteId);
    if (estado.fase === 'eligiendo') {
      if (estado.opciones) {
        capa.append(crear('h3', '', 'Elige una palabra para dibujar'));
        const ops = crear('div', 'opciones');
        estado.opciones.forEach((palabra, i) => {
          const b = crear('button', 'btn', palabra);
          b.onclick = () => socket.emit('palabra:elegir', i);
          ops.append(b);
        });
        capa.append(ops);
      } else {
        capa.append(crear('h3', '', `${dibujante ? dibujante.nombre : 'Alguien'} está eligiendo una palabra…`));
        capa.append(crear('div', 'grande-palabra', '✏️'));
      }
    } else if (estado.fase === 'finTurno') {
      const motivos = { todos: '¡Todos han acertado!', tiempo: '¡Se acabó el tiempo!', dibujanteFuera: 'El dibujante se ha ido' };
      capa.append(crear('h3', '', motivos[estado.motivoFin] || 'Fin del turno'));
      if (estado.palabra) {
        capa.append(crear('div', '', 'La palabra era'));
        capa.append(crear('div', 'grande-palabra', estado.palabra));
      }
      const ul = crear('ul');
      [...estado.jugadores].sort((a, b) => b.puntosTurno - a.puntosTurno).forEach((j) => {
        const li = crear('li');
        li.append(crear('span', '', j.nombre + ' '), crear('span', j.puntosTurno ? 'mas' : 'cero', j.puntosTurno ? `+${j.puntosTurno}` : '+0'));
        ul.append(li);
      });
      capa.append(ul);
    } else {
      capa.classList.add('oculto');
      return;
    }
    capa.classList.remove('oculto');
  }

  function pintarPartida(faseAnterior) {
    pintarBarra();
    pintarMarcador();
    pintarCapa();
    const dibujo = yoDibujo();
    $('#herramientas').classList.toggle('oculto', !dibujo);
    $('#lienzo').classList.toggle('puede', dibujo);
    const entrada = $('#entradaChat');
    const yo = estado.jugadores.find((j) => j.id === estado.tuId);
    entrada.placeholder = dibujo || (yo && yo.acertado && estado.fase === 'dibujando')
      ? 'Chatea sin chivarla 🤫'
      : 'Escribe tu respuesta…';
    if (faseAnterior !== estado.fase && estado.fase === 'dibujando') sonido(dibujo ? 660 : 520, 0.12);
  }

  socket.on('estado', (nuevo) => {
    const anterior = estado;
    estado = nuevo;
    recibidoEn = performance.now();
    if (salaActual) salaActual.codigo = nuevo.codigo;
    const yoAntes = anterior && anterior.jugadores.find((j) => j.id === anterior.tuId);
    const yoAhora = nuevo.jugadores.find((j) => j.id === nuevo.tuId);
    if (yoAhora && yoAhora.acertado && !(yoAntes && yoAntes.acertado)) sonido(880, 0.18);

    if (nuevo.fase === 'espera') { mostrar('espera'); pintarEspera(); }
    else if (nuevo.fase === 'final') { mostrar('final'); pintarFinal(); }
    else { mostrar('partida'); pintarPartida(anterior && anterior.fase); }
    actualizarReloj();
  });

  function actualizarReloj() {
    if (!estado || !['eligiendo', 'dibujando', 'finTurno'].includes(estado.fase)) return;
    const restante = Math.max(0, estado.tiempoRestante - (performance.now() - recibidoEn));
    const segundos = Math.ceil(restante / 1000);
    $('#segundos').textContent = segundos;
    const fraccion = estado.tiempoTotal ? restante / estado.tiempoTotal : 0;
    $('#arcoReloj').style.strokeDashoffset = String(100.53 * (1 - fraccion));
    $('#reloj').classList.toggle('urgente', estado.fase === 'dibujando' && segundos <= 10);
  }
  setInterval(actualizarReloj, 250);

  // ---------- chat ----------
  function anadirChat(m) {
    const chat = $('#chat');
    const abajo = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    const li = crear('li', m.tipo);
    if (m.nombre) {
      const b = crear('b', '', m.nombre + ':');
      if (m.tipo === 'mensaje') b.style.color = m.color;
      li.append(b);
    }
    li.append(document.createTextNode(m.texto));
    chat.append(li);
    while (chat.children.length > 150) chat.firstChild.remove();
    if (abajo || !m.nombre) chat.scrollTop = chat.scrollHeight;
    if (m.tipo === 'casi') sonido(400, 0.08);
  }
  socket.on('chat', anadirChat);
  $('#formChat').addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = $('#entradaChat').value.trim();
    if (!texto) return;
    socket.emit('chat', texto);
    $('#entradaChat').value = '';
  });

  // ---------- sonidos suaves ----------
  let audio;
  function sonido(frecuencia, duracion) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const vol = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = frecuencia;
      vol.gain.setValueAtTime(0.08, audio.currentTime);
      vol.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duracion);
      osc.connect(vol).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duracion);
    } catch { /* sin sonido */ }
  }

  // ---------- lienzo ----------
  const lienzo = $('#lienzo');
  const ctx = lienzo.getContext('2d');
  const W = lienzo.width;
  const H = lienzo.height;
  let trazos = [];

  function limpiar() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  limpiar();

  function pintarTramo(trazo, desde) {
    const p = trazo.p;
    ctx.strokeStyle = trazo.c;
    ctx.fillStyle = trazo.c;
    ctx.lineWidth = trazo.g;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (p.length === 2) {
      ctx.beginPath();
      ctx.arc(p[0] * W, p[1] * H, trazo.g / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const inicio = Math.max(0, desde - 2);
    ctx.beginPath();
    ctx.moveTo(p[inicio] * W, p[inicio + 1] * H);
    for (let i = inicio + 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * H);
    ctx.stroke();
  }

  function repintar() {
    limpiar();
    for (const t of trazos) pintarTramo(t, 0);
  }

  socket.on('lienzo:completo', (lista) => { trazos = lista; repintar(); });
  socket.on('lienzo:borrar', () => { trazos = []; repintar(); });
  socket.on('trazo:inicio', (t) => { trazos.push(t); pintarTramo(t, 0); });
  socket.on('trazo:puntos', (puntos) => {
    const t = trazos[trazos.length - 1];
    if (!t) return;
    const desde = t.p.length;
    t.p.push(...puntos);
    pintarTramo(t, desde);
  });

  // herramientas
  let colorPincel = COLORES_PINCEL[0];
  let grosor = GROSORES[1];
  let goma = false;

  function pintarHerramientas() {
    const paleta = $('#paleta');
    paleta.replaceChildren();
    for (const c of COLORES_PINCEL) {
      const b = crear('button', !goma && c === colorPincel ? 'sel' : '');
      b.style.background = c;
      b.setAttribute('aria-label', 'Color ' + c);
      b.onclick = () => { colorPincel = c; goma = false; pintarHerramientas(); };
      paleta.append(b);
    }
    const gros = $('#grosores');
    gros.replaceChildren();
    GROSORES.forEach((g, i) => {
      const b = crear('button', g === grosor ? 'sel' : '');
      b.setAttribute('aria-label', ['Fino', 'Medio', 'Grueso'][i]);
      const punto = crear('i');
      punto.style.width = punto.style.height = [5, 10, 18][i] + 'px';
      b.append(punto);
      b.onclick = () => { grosor = g; pintarHerramientas(); };
      gros.append(b);
    });
    $('#btnGoma').classList.toggle('sel', goma);
  }
  pintarHerramientas();
  $('#btnGoma').onclick = () => { goma = !goma; pintarHerramientas(); };
  $('#btnDeshacer').onclick = () => { if (yoDibujo()) socket.emit('trazo:deshacer'); };
  $('#btnBorrar').onclick = () => { if (yoDibujo()) socket.emit('lienzo:borrar'); };
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && yoDibujo()) { e.preventDefault(); socket.emit('trazo:deshacer'); }
  });

  // dibujar con ratón o dedo
  let dibujando = false;
  let pendientes = [];
  const r4 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
  function posicion(e) {
    const r = lienzo.getBoundingClientRect();
    return [r4((e.clientX - r.left) / r.width), r4((e.clientY - r.top) / r.height)];
  }
  function enviarPendientes() {
    if (pendientes.length) {
      socket.emit('trazo:puntos', pendientes);
      pendientes = [];
    }
  }
  setInterval(enviarPendientes, 40);

  lienzo.addEventListener('pointerdown', (e) => {
    if (!yoDibujo() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    lienzo.setPointerCapture(e.pointerId);
    dibujando = true;
    const [x, y] = posicion(e);
    const trazo = { c: goma ? GOMA : colorPincel, g: grosor, p: [x, y] };
    trazos.push(trazo);
    pintarTramo(trazo, 0);
    socket.emit('trazo:inicio', { c: trazo.c, g: trazo.g, x, y });
  });
  lienzo.addEventListener('pointermove', (e) => {
    if (!dibujando || !yoDibujo()) return;
    const t = trazos[trazos.length - 1];
    const eventos = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const desde = t.p.length;
    for (const ev of eventos.length ? eventos : [e]) {
      const [x, y] = posicion(ev);
      const n = t.p.length;
      if (Math.abs(t.p[n - 2] - x) + Math.abs(t.p[n - 1] - y) < 0.002) continue;
      t.p.push(x, y);
      pendientes.push(x, y);
    }
    if (t.p.length > desde) pintarTramo(t, desde);
    if (pendientes.length >= 380) enviarPendientes();
  });
  const terminar = () => { if (dibujando) { dibujando = false; enviarPendientes(); } };
  lienzo.addEventListener('pointerup', terminar);
  lienzo.addEventListener('pointercancel', terminar);
})();

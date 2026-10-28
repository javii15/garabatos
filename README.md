# Garabatos 🎨

Juego multijugador de dibujar y adivinar, en español. Sin registros: crea una sala, comparte el enlace y a jugar (2 a 8 jugadores, en el móvil o en el ordenador).

## Probarlo en tu Mac

```bash
npm install
npm start
```

Abre http://localhost:3000 en varias pestañas (o ventanas de incógnito) para simular jugadores.

## Pruebas automáticas

```bash
npm test
```

Simula tres jugadores y recorre una partida completa: aciertos, «¡Casi!», pistas, recargar la página, fin de partida…

## Cómo funciona

- `server.js`: servidor Express + Socket.IO. Es la autoridad: guarda la palabra secreta, controla turnos, tiempo y puntos. Las salas viven en memoria y se borran solas al quedarse vacías 10 minutos.
- `words.js`: lista de palabras.
- `public/`: la web (HTML, CSS y JavaScript sin dependencias).

Publicado en Render (plan gratuito) con `render.yaml`.

# Garabatos 🎨

Juego multijugador de dibujar y adivinar, en español. Sin registros: crea una sala, comparte el enlace y a jugar (2 a 8 jugadores, en el móvil o en el ordenador).

## Probarlo en tu Mac

```bash
npm install
npm run dev
```

Abre http://localhost:8787 en varias ventanas de incógnito para simular jugadores.

## Pruebas automáticas

```bash
npm test
```

Arranca el servidor en local, simula tres jugadores y recorre una partida completa: aciertos, «¡Casi!», pistas, recargar la página, fin de partida…

## Publicar

```bash
npx wrangler login   # solo la primera vez
npm run deploy
```

Se publica gratis en Cloudflare Workers (sin tarjeta).

## Cómo funciona

- `src/index.js`: punto de entrada. Sirve la web (`public/`), crea salas y conecta a cada jugador con su sala por WebSocket.
- `src/sala.js`: cada sala es un Durable Object y es la autoridad: guarda la palabra secreta, controla turnos, tiempo y puntos. Guarda su estado para sobrevivir si Cloudflare la «duerme», y se borra sola tras 10 minutos vacía.
- `src/palabras.js`: lista de palabras.
- `public/`: la web (HTML, CSS y JavaScript sin dependencias).

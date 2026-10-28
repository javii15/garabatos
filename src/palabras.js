// Lista de palabras fáciles de dibujar. Se eliminan duplicados al cargar.
const LISTA = `
perro, gato, ratón, elefante, jirafa, león, tigre, cebra, mono, oso, conejo, tortuga,
serpiente, cocodrilo, pez, tiburón, ballena, delfín, pulpo, cangrejo, caracol, mariposa,
abeja, araña, hormiga, mosca, mosquito, pájaro, loro, búho, pingüino, pato, gallina, gallo,
vaca, cerdo, oveja, caballo, burro, camello, canguro, koala, panda, rana, murciélago, lobo,
zorro, ardilla, erizo, foca, medusa, estrella de mar, caballito de mar, flamenco, pavo real,
dinosaurio, unicornio, dragón, gusano, mariquita, hipopótamo, rinoceronte, avestruz, cisne,
águila, langosta, calamar, caracola, nido, telaraña, pluma,

manzana, plátano, pera, uva, fresa, sandía, piña, naranja, limón, cereza, melón, coco,
zanahoria, tomate, patata, cebolla, ajo, lechuga, brócoli, maíz, champiñón, pimiento,
berenjena, pan, queso, huevo, huevo frito, jamón, salchicha, hamburguesa, pizza,
perrito caliente, patatas fritas, tortilla, paella, bocadillo, sopa, espaguetis, arroz,
helado, tarta, galleta, caramelo, chocolate, churro, donut, palomitas, magdalena, cruasán,
café, leche, zumo, piruleta, sushi, taco, yogur, miel, sándwich, aceituna,

mesa, silla, cama, sofá, lámpara, puerta, ventana, reloj, espejo, televisión, teléfono,
ordenador, teclado, llave, candado, tijeras, lápiz, bolígrafo, libro, cuaderno, mochila,
paraguas, gafas, cepillo de dientes, peine, toalla, jabón, bañera, ducha, váter, nevera,
horno, microondas, sartén, olla, cuchara, tenedor, cuchillo, plato, vaso, taza, botella,
vela, bombilla, enchufe, escoba, cubo, regalo, globo, cometa, pelota, muñeca,
osito de peluche, peonza, dado, carta, sobre, caja, bolsa, cartera, moneda, martillo,
destornillador, clavo, sierra, escalera, cuerda, imán, brújula, mapa, linterna, cámara,
guitarra, piano, tambor, trompeta, violín, flauta, micrófono, auriculares, altavoz, radio,
mando, pila, calculadora, regla, goma de borrar, grapadora, sacapuntas, pincel, cuadro,
alfombra, almohada, manta, percha, ventilador, aspiradora, papelera, maleta, sello,
lupa, telescopio, microscopio, reloj de arena, termómetro, jeringa, tirita, pastilla,
silbato, campana, hamaca, sombrilla, cuna, biberón, chupete, carrito de bebé, chimenea,

camiseta, pantalón, falda, vestido, zapato, bota, calcetín, sombrero, gorra, bufanda,
guante, chaqueta, corbata, cinturón, pijama, bikini, chanclas, anillo, collar, pendiente,
corona, zapatilla, bolso, mochila,

sol, luna, estrella, nube, lluvia, nieve, rayo, arcoíris, montaña, volcán, río, mar, playa,
isla, desierto, bosque, árbol, flor, rosa, girasol, cactus, hoja, seta, palmera, cascada,
cueva, ola, tornado, fuego, piedra, planeta, hielo, charco, lago, arena, copo de nieve,

coche, moto, bicicleta, autobús, tren, avión, barco, submarino, helicóptero, cohete, camión,
tractor, taxi, ambulancia, coche de policía, camión de bomberos, patinete, monopatín,
globo aerostático, velero, metro, caravana, grúa, carrito de la compra, canoa, ovni,

casa, castillo, iglesia, hospital, colegio, faro, puente, torre, pirámide, iglú,
tienda de campaña, granja, parque, columpio, tobogán, piscina, estadio, cine, biblioteca,
aeropuerto, gasolinera, semáforo, farola, buzón, fuente, noria, montaña rusa, circo, zoo,
museo, molino, pozo, valla, tejado, castillo de arena, rascacielos,

ojo, nariz, boca, oreja, mano, pie, dedo, diente, lengua, pelo, corazón, cerebro, hueso,
esqueleto, brazo, pierna, rodilla, barba, bigote, uña, calavera, huella, tatuaje, sonrisa,

médico, bombero, policía, cocinero, pirata, payaso, mago, bruja, fantasma, robot,
astronauta, vampiro, zombi, superhéroe, princesa, rey, sirena, ninja, vaquero, pescador,
pintor, futbolista, enfermera, profesor, cartero, extraterrestre, muñeco de nieve,
espantapájaros, momia, hada, duende, caballero, buzo,

fútbol, baloncesto, tenis, golf, natación, boxeo, esquí, surf, ajedrez, bolos, karate,
portería, raqueta, trofeo, medalla, canasta, patines, diana, dardo, trampolín, balón,

dormir, correr, saltar, nadar, bailar, cantar, llorar, reír, comer, beber, leer, escribir,
volar, pescar, cocinar, estornudar, bostezar, abrazar, aplaudir, gritar,

cumpleaños, boda, árbol de navidad, calabaza, huevo de pascua, bandera, tesoro,
mapa del tesoro, ancla, timón, espada, escudo, arco, flecha, cañón, bomba, burbuja,
pasaporte, billete, corazón roto, wifi, batería, semilla, escalera mecánica, mariachi,
fantasma, varita mágica, lámpara mágica, alfombra voladora, sombrero de copa, gafas de sol
`;

function quitarTildes(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const vistas = new Set();
const PALABRAS = [];
for (const bruta of LISTA.split(',')) {
  const palabra = bruta.trim().replace(/\s+/g, ' ');
  if (!palabra) continue;
  const clave = quitarTildes(palabra.toLowerCase());
  if (vistas.has(clave)) continue;
  vistas.add(clave);
  PALABRAS.push(palabra);
}

export default PALABRAS;

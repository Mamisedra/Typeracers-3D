const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { typeCharacter } = require('./typing');

const port = Number(process.env.PORT) || 7824;
const maxPlayers = 12;
const minimumCars = 5;
const countdownMs = 5000;
const tickMs = 100;
const punctureChoices = [1, 2, 3, 5];
const abandonedRaceMs = 5 * 60 * 1000;
const latencyGraceMs = 300;
const rateWindowMs = 2000;
const maxKeysPerWindow = 40;
const regularityWindow = 30;
const regularityRatio = 0.05;
const keyBackdateMs = 1000;
const palette = [0xff3b1f, 0x2f7bff, 0x2fd67b, 0xffd21a, 0xb04dff, 0x19d3da, 0xff5fa2, 0xf2f2f2, 0xff8c1a, 0x8cff1a, 0x1a3cff, 0x8b5a2b];
const carModels = ['rallye', 'coupe', 'pickup', 'buggy'];
const mapNames = ['foret', 'ville', 'desert'];

const botProfiles = [
  { name: 'Vega', wordsPerMinute: 55, errorRate: 0.008 },
  { name: 'Orion', wordsPerMinute: 46, errorRate: 0.011 },
  { name: 'Lynx', wordsPerMinute: 38, errorRate: 0.014 },
  { name: 'Atlas', wordsPerMinute: 30, errorRate: 0.018 },
];

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts.json'), 'utf8'));
const textLengths = [
  { name: 'court', max: 130 },
  { name: 'moyen', max: 200 },
  { name: 'long', max: 320 },
];
const languageShares = { fr: 0.7, mg: 0.15, en: 0.15 };
const minimumTextsPerLength = 5;
const decks = new Map();

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];
const shuffled = (list) => list.map((item) => [Math.random(), item]).sort(([a], [b]) => a - b).map(([, item]) => item);

function textsOfLength(language, tierIndex) {
  const min = tierIndex === 0 ? 0 : textLengths[tierIndex - 1].max + 1;
  return corpus[language].filter((text) => text.length >= min && text.length <= textLengths[tierIndex].max);
}

function pickLanguage() {
  let roll = Math.random();
  return Object.keys(languageShares).find((language) => (roll -= languageShares[language]) < 0) ?? 'fr';
}

function drawRaceText() {
  const language = pickLanguage();
  const tiers = textLengths.map((_, i) => i).filter((i) => textsOfLength(language, i).length >= minimumTextsPerLength);
  const tier = pickRandom(tiers);
  const key = `${language}-${tier}`;
  if (!decks.get(key)?.length) decks.set(key, shuffled(textsOfLength(language, tier)));
  return decks.get(key).pop();
}

const rooms = new Map();
const players = new Map();

const hostId = (room) => room.members.keys().next().value;

function snapshot(room) {
  const { race } = room;
  return {
    now: Date.now(),
    roomId: room.id,
    solo: room.solo,
    hostId: hostId(room),
    botsEnabled: room.botsEnabled,
    map: room.map,
    punctureSeconds: room.punctureSeconds,
    racePunctureSeconds: race ? race.punctureSeconds : 0,
    players: [...room.members.values()].map(({ id, name, color, model }) => ({ id, name, color, model })),
    text: race ? race.text : '',
    startAt: race ? race.startAt : 0,
    cars: race ? race.cars.map(({ watch, ...car }) => car) : [],
  };
}

function openRooms() {
  return [...rooms.values()].filter((room) => !room.solo && room.members.size > 0).map((room) => ({
    id: room.id,
    host: room.members.get(hostId(room)).name,
    players: room.members.size,
    maxPlayers,
    full: room.members.size >= maxPlayers,
    racing: Boolean(room.race) && !canStartRace(room),
  }));
}

function broadcast(room) {
  const message = `data: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const player of room.members.values()) player.stream.write(message);
}

function createRace(room) {
  const humans = [...room.members.values()].map(({ id, name, color, model }) => ({ id, name, color, model, isBot: false }));
  const freeColors = palette.filter((color) => !humans.some((human) => human.color === color));
  const bots = botProfiles.slice(0, room.botsEnabled ? Math.max(0, minimumCars - humans.length) : 0).map((profile, i) => ({
    ...profile, id: `bot-${profile.name}`, color: freeColors[i], model: pickRandom(carModels), isBot: true, keystrokeBudget: 0,
  }));
  const drivers = [...humans, ...bots];
  const laneSpacing = drivers.length > 1 ? Math.min(3, 14 / (drivers.length - 1)) : 0;
  return {
    text: drawRaceText(),
    startAt: Date.now() + countdownMs,
    punctureSeconds: room.punctureSeconds,
    cars: drivers.map((driver, i) => ({
      ...driver, lane: (i - (drivers.length - 1) / 2) * laneSpacing,
      typed: 0, punctures: 0, penaltyUntil: 0, finished: false, finishTime: 0, unranked: false,
      watch: { received: 0, times: [] },
    })),
  };
}

function canStartRace(room) {
  const { race } = room;
  if (!race || Date.now() - race.startAt > abandonedRaceMs) return true;
  return race.cars.filter((car) => !car.isBot && room.members.has(car.id)).every((car) => car.finished);
}

function startRace(room) {
  room.race = createRace(room);
  broadcast(room);
}

function finish(race, car, now) {
  car.finished = true;
  car.finishTime = (now - race.startAt) / 1000;
}

function botTypes(race, bot, now) {
  if (bot.finished || now < bot.penaltyUntil) return;
  bot.keystrokeBudget += ((bot.wordsPerMinute * 5) / 60) * (tickMs / 1000);
  while (bot.keystrokeBudget >= 1 && !bot.finished) {
    bot.keystrokeBudget--;
    if (Math.random() < bot.errorRate) {
      bot.penaltyUntil = now + race.punctureSeconds * 1000;
      bot.punctures++;
      bot.keystrokeBudget = 0;
    } else if (++bot.typed === race.text.length) {
      finish(race, bot, now);
    }
  }
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.race) continue;
    if (now >= room.race.startAt) for (const car of room.race.cars) if (car.isBot) botTypes(room.race, car, now);
    broadcast(room);
  }
}

function looksInhuman(times) {
  if (times.length > maxKeysPerWindow && times.at(-1) - times.at(-1 - maxKeysPerWindow) < rateWindowMs) return true;
  if (times.length <= regularityWindow) return false;
  const recent = times.slice(-regularityWindow - 1);
  const intervals = recent.slice(1).map((time, i) => time - recent[i]);
  const mean = intervals.reduce((sum, interval) => sum + interval, 0) / regularityWindow;
  const deviation = Math.sqrt(intervals.reduce((sum, interval) => sum + (interval - mean) ** 2, 0) / regularityWindow);
  return deviation <= mean * regularityRatio;
}

function replayKey(race, car, character, now) {
  race.countdown = (race.startAt - now) / 1000;
  race.time = Math.max(0, -race.countdown);
  car.penalty = Math.max(0, (car.penaltyUntil - latencyGraceMs - now) / 1000);
  if (typeCharacter(race, car, character) === 'puncture') car.penaltyUntil = now + race.punctureSeconds * 1000;
}

function recordKeys(player, report) {
  const race = player.room.race;
  const car = race && report.startAt === race.startAt && race.cars.find((candidate) => candidate.id === player.id);
  if (!car || !(report.from >= 0 && report.from <= car.watch.received) || !Array.isArray(report.keys)) return false;
  const { watch } = car;
  const now = Date.now();
  for (const key of report.keys.slice(watch.received - report.from)) {
    const [character, clientTime] = Array.isArray(key) ? key : [];
    watch.received++;
    if (car.finished || typeof character !== 'string' || character.length !== 1) continue;
    watch.times.push(Math.min(now, Math.max(now - keyBackdateMs, watch.times.at(-1) ?? 0, Number(clientTime) || 0)));
    if (looksInhuman(watch.times)) car.unranked = true;
    replayKey(race, car, character, now);
  }
  broadcast(player.room);
  return true;
}

function findOrCreateRoom(requested, map) {
  if (requested !== 'new' && requested !== 'solo') return rooms.get(requested);
  const room = { id: crypto.randomBytes(3).toString('hex'), solo: requested === 'solo', members: new Map(), race: null, botsEnabled: true, punctureSeconds: 2, map: mapNames.includes(map) ? map : 'foret' };
  rooms.set(room.id, room);
  return room;
}

function openEventStream(request, response, url) {
  const room = findOrCreateRoom(url.searchParams.get('room') || 'new', url.searchParams.get('map'));
  if (!room) {
    response.writeHead(404).end();
    return;
  }
  if (room.members.size >= maxPlayers || (room.solo && room.members.size > 0)) {
    response.writeHead(503).end();
    return;
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const name = (url.searchParams.get('name') || '').trim().slice(0, 16) || 'Pilote';
  const freeColors = palette.filter((candidate) => ![...room.members.values()].some((player) => player.color === candidate));
  const requestedColor = Number(url.searchParams.get('color'));
  const requestedModel = url.searchParams.get('model');
  const color = freeColors.includes(requestedColor) ? requestedColor : freeColors[0];
  const model = carModels.includes(requestedModel) ? requestedModel : carModels[0];
  const player = { id, token, name, color, model, stream: response, room };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  response.write(`event: welcome\ndata: ${JSON.stringify({ id, token, roomId: room.id })}\n\n`);
  room.members.set(id, player);
  players.set(token, player);
  request.on('close', () => {
    room.members.delete(id);
    players.delete(token);
    if (room.members.size === 0) rooms.delete(room.id);
    else broadcast(room);
  });
  if (room.solo) startRace(room);
  else broadcast(room);
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20000) request.destroy();
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body) ?? {});
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

const staticDirs = { '/assets/': path.join(__dirname, 'assets'), '/vendor/': path.join(__dirname, 'vendor') };
const assetTypes = { '.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const staticPrefix = Object.keys(staticDirs).find((prefix) => url.pathname.startsWith(prefix));
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(response);
  } else if (request.method === 'GET' && url.pathname === '/typing.js') {
    response.writeHead(200, { 'Content-Type': assetTypes['.js'] });
    fs.createReadStream(path.join(__dirname, 'typing.js')).pipe(response);
  } else if (request.method === 'GET' && staticPrefix) {
    const file = path.resolve(staticDirs[staticPrefix], url.pathname.slice(staticPrefix.length));
    const type = assetTypes[path.extname(file)];
    if (!file.startsWith(staticDirs[staticPrefix] + path.sep) || !type || !fs.existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(response);
  } else if (request.method === 'GET' && url.pathname === '/events') {
    openEventStream(request, response, url);
  } else if (request.method === 'GET' && url.pathname === '/rooms') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(openRooms()));
  } else if (request.method === 'GET' && url.pathname === '/state' && rooms.has(url.searchParams.get('room'))) {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot(rooms.get(url.searchParams.get('room')))));
  } else if (request.method === 'POST' && url.pathname === '/start') {
    const player = players.get((await readJson(request)).token);
    const allowed = Boolean(player) && player.id === hostId(player.room) && canStartRace(player.room);
    if (allowed) startRace(player.room);
    response.writeHead(allowed ? 204 : 409).end();
  } else if (request.method === 'POST' && url.pathname === '/settings') {
    const { token, botsEnabled, punctureSeconds, map } = await readJson(request);
    const player = players.get(token);
    const allowed = Boolean(player) && player.id === hostId(player.room);
    if (allowed) {
      if (typeof botsEnabled === 'boolean') player.room.botsEnabled = botsEnabled;
      if (punctureChoices.includes(punctureSeconds)) player.room.punctureSeconds = punctureSeconds;
      if (mapNames.includes(map)) player.room.map = map;
      broadcast(player.room);
    }
    response.writeHead(allowed ? 204 : 409).end();
  } else if (request.method === 'POST' && url.pathname === '/progress') {
    const report = await readJson(request);
    const player = players.get(report.token);
    response.writeHead(player && recordKeys(player, report) ? 204 : 409).end();
  } else {
    response.writeHead(404).end();
  }
});

setInterval(tick, tickMs).unref();

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => {
    const addresses = Object.values(os.networkInterfaces()).flat().filter((address) => address.family === 'IPv4' && !address.internal);
    for (const { address } of addresses) console.log(`Rallye Nova : http://${address}:${port}`);
  });
}

module.exports = { server, drawRaceText, looksInhuman, replayKey };

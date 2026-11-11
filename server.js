const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const port = Number(process.env.PORT) || 3000;
const maxPlayers = 8;
const minimumCars = 5;
const countdownMs = 5000;
const tickMs = 100;
const punctureMs = 2000;
const abandonedRaceMs = 5 * 60 * 1000;
const palette = [0xff3b1f, 0x2f7bff, 0x2fd67b, 0xffd21a, 0xb04dff, 0x19d3da, 0xff5fa2, 0xf2f2f2];

const botProfiles = [
  { name: 'Vega', wordsPerMinute: 55, errorRate: 0.008 },
  { name: 'Orion', wordsPerMinute: 46, errorRate: 0.011 },
  { name: 'Lynx', wordsPerMinute: 38, errorRate: 0.014 },
  { name: 'Atlas', wordsPerMinute: 30, errorRate: 0.018 },
];

const raceTexts = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts.json'), 'utf8'));
let textDeck = [];

function drawText() {
  if (textDeck.length === 0) {
    textDeck = raceTexts.map((_, i) => i);
    for (let i = textDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [textDeck[i], textDeck[j]] = [textDeck[j], textDeck[i]];
    }
  }
  return raceTexts[textDeck.pop()];
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
    players: [...room.members.values()].map(({ id, name, color }) => ({ id, name, color })),
    text: race ? race.text : '',
    startAt: race ? race.startAt : 0,
    cars: race ? race.cars : [],
  };
}

function openRooms() {
  return [...rooms.values()].filter((room) => !room.solo && room.members.size > 0).map((room) => ({
    id: room.id,
    host: room.members.get(hostId(room)).name,
    players: room.members.size,
    full: room.members.size >= maxPlayers,
    racing: Boolean(room.race) && !canStartRace(room),
  }));
}

function broadcast(room) {
  const message = `data: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const player of room.members.values()) player.stream.write(message);
}

function createRace(room) {
  const humans = [...room.members.values()].map(({ id, name, color }) => ({ id, name, color, isBot: false }));
  const freeColors = palette.filter((color) => !humans.some((human) => human.color === color));
  const bots = botProfiles.slice(0, room.botsEnabled ? Math.max(0, minimumCars - humans.length) : 0).map((profile, i) => ({
    ...profile, id: `bot-${profile.name}`, color: freeColors[i], isBot: true, keystrokeBudget: 0,
  }));
  const drivers = [...humans, ...bots];
  const laneSpacing = drivers.length > 1 ? Math.min(3, 14 / (drivers.length - 1)) : 0;
  return {
    text: drawText(),
    startAt: Date.now() + countdownMs,
    cars: drivers.map((driver, i) => ({
      ...driver, lane: (i - (drivers.length - 1) / 2) * laneSpacing,
      typed: 0, punctures: 0, penaltyUntil: 0, finished: false, finishTime: 0, sequence: 0,
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
      bot.penaltyUntil = now + punctureMs;
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

function recordProgress(report) {
  const player = players.get(report.id);
  const race = player && player.room.race;
  const car = race && report.startAt === race.startAt && race.cars.find((candidate) => candidate.id === report.id && !candidate.isBot);
  if (!car || car.finished || !(report.sequence > car.sequence)) return;
  const now = Date.now();
  car.sequence = report.sequence;
  car.typed = Math.max(0, Math.min(race.text.length, Math.floor(Number(report.typed)) || 0));
  car.punctures = Math.max(0, Math.floor(Number(report.punctures)) || 0);
  car.penaltyUntil = now + Math.max(0, Math.min(punctureMs, Number(report.penaltyMs) || 0));
  if (car.typed === race.text.length) finish(race, car, now);
  broadcast(player.room);
}

function findOrCreateRoom(requested) {
  if (requested !== 'new' && requested !== 'solo') return rooms.get(requested);
  const room = { id: crypto.randomBytes(3).toString('hex'), solo: requested === 'solo', members: new Map(), race: null, botsEnabled: true };
  rooms.set(room.id, room);
  return room;
}

function openEventStream(request, response, url) {
  const room = findOrCreateRoom(url.searchParams.get('room') || 'new');
  if (!room) {
    response.writeHead(404).end();
    return;
  }
  if (room.members.size >= maxPlayers || (room.solo && room.members.size > 0)) {
    response.writeHead(503).end();
    return;
  }
  const id = crypto.randomUUID();
  const name = (url.searchParams.get('name') || '').trim().slice(0, 16) || 'Pilote';
  const color = palette.find((candidate) => ![...room.members.values()].some((player) => player.color === candidate));
  const player = { id, name, color, stream: response, room };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  response.write(`event: welcome\ndata: ${JSON.stringify({ id, roomId: room.id })}\n\n`);
  room.members.set(id, player);
  players.set(id, player);
  request.on('close', () => {
    room.members.delete(id);
    players.delete(id);
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
      if (body.length > 2000) request.destroy();
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(response);
  } else if (request.method === 'GET' && url.pathname === '/events') {
    openEventStream(request, response, url);
  } else if (request.method === 'GET' && url.pathname === '/rooms') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(openRooms()));
  } else if (request.method === 'GET' && url.pathname === '/state' && rooms.has(url.searchParams.get('room'))) {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot(rooms.get(url.searchParams.get('room')))));
  } else if (request.method === 'POST' && url.pathname === '/start') {
    const player = players.get((await readJson(request)).id);
    const allowed = Boolean(player) && player.id === hostId(player.room) && canStartRace(player.room);
    if (allowed) startRace(player.room);
    response.writeHead(allowed ? 204 : 409).end();
  } else if (request.method === 'POST' && url.pathname === '/bots') {
    const { id, enabled } = await readJson(request);
    const player = players.get(id);
    const allowed = Boolean(player) && id === hostId(player.room);
    if (allowed) {
      player.room.botsEnabled = Boolean(enabled);
      broadcast(player.room);
    }
    response.writeHead(allowed ? 204 : 409).end();
  } else if (request.method === 'POST' && url.pathname === '/progress') {
    recordProgress(await readJson(request));
    response.writeHead(204).end();
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

module.exports = { server };

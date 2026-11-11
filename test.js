const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { server } = require('./server');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkPunctureRule() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const threeUrl = html.match(/<script src="([^"]+three[^"]+)"/)[1];
  const scripts = [...html.matchAll(/<script(?: id="simulation")?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  new Function(scripts.join('\n'));
  const context = vm.createContext({});
  vm.runInContext(await (await fetch(threeUrl)).text(), context);
  vm.runInContext(`${scripts[0]}; globalThis.api = { createCar, stepRace, typeCharacter };`, context);

  const { createCar, stepRace, typeCharacter } = context.api;
  const dt = 1 / 60;
  const car = createCar({ id: 'me', lane: 0 });
  const race = { text: 'abc', startAt: 1000, countdown: Infinity, time: 0, cars: [car] };
  let now = 0;
  const advance = (seconds) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
      now += dt * 1000;
      stepRace(race, now, dt, 'me');
    }
  };

  advance(0.5);
  assert.equal(typeCharacter(race, car, 'a'), 'locked', 'clavier bloqué pendant le compte à rebours');
  advance(0.6);
  assert.equal(typeCharacter(race, car, 'a'), 'hit');
  assert.equal(typeCharacter(race, car, '#'), 'puncture');
  advance(1.9);
  assert.equal(typeCharacter(race, car, 'b'), 'locked', 'toujours bloqué avant 2 s');
  assert(car.speed < 1, 'voiture à l’arrêt pendant la crevaison');
  advance(0.2);
  assert.equal(typeCharacter(race, car, 'b'), 'hit', 'clavier débloqué après 2 s');
  assert.equal(typeCharacter(race, car, 'c'), 'hit');
  assert(car.finished && car.punctures === 1);
  assert.equal(car.streak, 2, 'la série repart de zéro après une crevaison');
  const accented = createCar({ id: 'me', lane: 0 });
  const accentRace = { text: 'été', startAt: 0, countdown: 0, time: 1, cars: [accented] };
  const outcomes = ['e', 't', 'é'].map((key) => typeCharacter(accentRace, accented, key));
  assert.deepEqual(outcomes, ['hit', 'hit', 'hit'], `les accents sont facultatifs : ${outcomes}`);
}

async function join(base, name, room) {
  const response = await fetch(`${base}/events?name=${name}&room=${room}`);
  if (response.status !== 200) return { status: response.status };
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('\n\n')) received += Buffer.from((await reader.read()).value).toString();
  reader.read().catch(() => {});
  return { ...JSON.parse(received.match(/data: (.*)/)[1]), leave: () => reader.cancel() };
}

async function checkNetworkRace() {
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', body: JSON.stringify(body) });
  const get = async (route) => (await fetch(base + route)).json();

  const ana = await join(base, 'Ana', 'new');
  const bao = await join(base, 'Bao', ana.roomId);
  const solo = await join(base, 'Solo', 'solo');
  assert.equal((await join(base, 'Zed', 'inexistante')).status, 404, 'une course fermée ne se rejoint pas');
  assert.equal((await join(base, 'Zed', solo.roomId)).status, 503, 'une course solo ne se rejoint pas');

  const listed = await get('/rooms');
  assert.deepEqual(listed.map((room) => [room.host, room.players]), [['Ana', 2]], 'seule la course ouverte est listée');
  const soloState = await get(`/state?room=${solo.roomId}`);
  assert(soloState.startAt > 0 && soloState.cars.length === 5, 'le solo démarre tout seul avec 4 bots');

  assert.equal((await post('/start', { id: bao.id })).status, 409, 'seul l’hôte lance la course');
  assert.equal((await post('/bots', { id: bao.id, enabled: false })).status, 409, 'seul l’hôte règle les bots');
  assert.equal((await post('/start', { id: ana.id })).status, 204);

  const started = await get(`/state?room=${ana.roomId}`);
  assert.equal(started.cars.length, 5, '2 humains + 3 bots');
  assert.equal(new Set(started.cars.map((car) => car.color)).size, 5, 'une couleur par voiture');
  assert.equal((await post('/start', { id: ana.id })).status, 409, 'pas de relance tant que des humains courent');
  assert((await get('/rooms'))[0].racing, 'la liste signale la course en cours');

  await pause(started.startAt - Date.now() + 1500);
  const length = started.text.length;
  await post('/progress', { id: ana.id, startAt: started.startAt, sequence: 2, typed: 40, punctures: 1, penaltyMs: 2000 });
  await post('/progress', { id: ana.id, startAt: started.startAt, sequence: 1, typed: 10, punctures: 0, penaltyMs: 0 });
  await post('/progress', { id: bao.id, startAt: started.startAt, sequence: 1, typed: length, punctures: 0, penaltyMs: 0 });

  const running = await get(`/state?room=${ana.roomId}`);
  const car = (id) => running.cars.find((candidate) => candidate.id === id);
  assert.equal(car(ana.id).typed, 40, 'un rapport arrivé en retard est ignoré');
  assert(car(ana.id).penaltyUntil > running.now, 'la crevaison est relayée');
  assert(car(bao.id).finished && car(bao.id).finishTime > 1, 'le serveur chronomètre l’arrivée');
  assert(running.cars.some((candidate) => candidate.isBot && candidate.typed > 0), 'les bots tapent');

  ana.leave();
  await pause(200);
  assert.equal((await get(`/state?room=${ana.roomId}`)).hostId, bao.id, 'le pilote suivant devient hôte quand l’hôte quitte');
  assert.equal((await post('/bots', { id: bao.id, enabled: false })).status, 204);
  assert.equal((await post('/start', { id: bao.id })).status, 204, 'relance possible quand les humains connectés ont fini');
  const restarted = await get(`/state?room=${ana.roomId}`);
  assert.equal(restarted.cars.length, 1, 'sans bots, seuls les humains courent');
  assert.notEqual(restarted.text, started.text, 'le texte change d’une course à l’autre');

  bao.leave();
  solo.leave();
  await pause(200);
  assert.deepEqual(await get('/rooms'), [], 'une course vide disparaît');
}

function checkTexts() {
  const texts = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts.json'), 'utf8'));
  assert(texts.length >= 40 && new Set(texts).size === texts.length, 'au moins 40 textes distincts');
  for (const text of texts) {
    const typable = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    assert(/^[\x20-\x7e]+$/.test(typable), `caractère impossible à taper : ${text}`);
  }
}

checkPunctureRule()
  .then(checkTexts)
  .then(checkNetworkRace)
  .then(() => {
    console.log('OK');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

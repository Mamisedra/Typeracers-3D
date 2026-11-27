const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { server, drawRaceText, looksInhuman, replayKey } = require('./server');
const { normalizeKey, matchesKey } = require('./typing');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkPunctureRule() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const threeUrl = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  const scripts = [...html.matchAll(/<script(?: id="simulation")?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  new Function(scripts.join('\n'));
  const context = vm.createContext({});
  vm.runInContext(await (await fetch(threeUrl)).text(), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'typing.js'), 'utf8'), context);
  vm.runInContext(`${scripts[0]}; track = buildTrack(); globalThis.api = { createCar, stepRace, typeCharacter };`, context);

  const { createCar, stepRace, typeCharacter } = context.api;
  const dt = 1 / 60;
  const car = createCar({ id: 'me', lane: 0 });
  const race = { text: 'abc', startAt: 1000, punctureSeconds: 2, countdown: Infinity, time: 0, cars: [car] };
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
  const accentRace = { text: 'été', startAt: 0, punctureSeconds: 2, countdown: 0, time: 1, cars: [accented] };
  const outcomes = ['e', 't', 'é'].map((key) => typeCharacter(accentRace, accented, key));
  assert.deepEqual(outcomes, ['hit', 'hit', 'hit'], `les accents sont facultatifs : ${outcomes}`);
}

function checkKeyNormalization() {
  assert(matchesKey('\u2019', "'") && matchesKey("'", '\u2019'), 'apostrophe typographique');
  assert(matchesKey('\u00a0', ' ') && matchesKey('\u202f', ' '), 'espaces insécables');
  assert(matchesKey('\u00ab', '"') && matchesKey('\u00bb', '"') && matchesKey('"', '\u201c'), 'guillemets');
  assert(matchesKey('e', '\u00e9') && !matchesKey('E', 'e') && !matchesKey('a', 'b'), 'accents tolérés, casse et lettres exigées');
  assert.equal(normalizeKey('\u2019'), "'");
}

function checkServerReplay() {
  const race = { text: 'abc', startAt: 1000, punctureSeconds: 2 };
  const car = { typed: 0, punctures: 0, penaltyUntil: 0, finished: false, finishTime: 0 };
  replayKey(race, car, 'a', 500);
  assert.equal(car.typed, 0, 'frappe avant le départ ignorée');
  replayKey(race, car, 'a', 1500);
  replayKey(race, car, '#', 1600);
  assert.deepEqual([car.typed, car.punctures, car.penaltyUntil], [1, 1, 3600], 'erreur : crevaison chronométrée par le serveur');
  replayKey(race, car, 'b', 2000);
  assert.deepEqual([car.typed, car.punctures], [1, 1], 'frappe ignorée pendant la crevaison');
  replayKey(race, car, 'b', 3400);
  replayKey(race, car, 'c', 3500);
  assert(car.finished && car.typed === 3 && car.finishTime === 2.5, 'temps = heure serveur de la dernière frappe − départ');
}

function checkPlausibility() {
  const at = (count, interval, jitter = 0) => Array.from({ length: count }, (_, i) => Math.round(i * interval + (i % 2) * jitter));
  assert(looksInhuman(at(60, 40)), '25 frappes/s soutenues : non classé');
  assert(looksInhuman(at(40, 150)), 'intervalles strictement réguliers : non classé');
  assert(!looksInhuman(at(100, 100, 60)), 'rythme humain alterné : classé');
  assert(!looksInhuman(at(41, 50, 30)), '20 frappes/s irrégulières : classé');
  assert(!looksInhuman(at(10, 10)), 'trop peu de frappes pour juger');
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
  const bao = await join(base, 'Bao', `${ana.roomId}&color=${0xb04dff}&model=buggy`);
  const cy = await join(base, 'Cy', `${ana.roomId}&color=${0xb04dff}&model=fusee`);
  const solo = await join(base, 'Solo', 'solo&map=ville');
  assert.equal((await join(base, 'Zed', 'inexistante')).status, 404, 'une course fermée ne se rejoint pas');
  assert.equal((await join(base, 'Zed', solo.roomId)).status, 503, 'une course solo ne se rejoint pas');

  const listed = await get('/rooms');
  assert.deepEqual(listed.map((room) => [room.host, room.players]), [['Ana', 3]], 'seule la course ouverte est listée');
  let soloState = await get(`/state?room=${solo.roomId}`);
  for (let waited = 0; soloState.startAt === 0 && waited < 12000; waited += 100) {
    await pause(100);
    soloState = await get(`/state?room=${solo.roomId}`);
  }
  assert(soloState.startAt > 0 && soloState.cars.length === 5, 'le solo démarre tout seul avec 4 bots');
  assert.equal(soloState.map, 'ville', 'la carte choisie à la création est celle de la course');

  assert.equal((await post('/start', { token: bao.token })).status, 409, 'seul l’hôte lance la course');
  assert.equal((await post('/settings', { token: bao.token, botsEnabled: false })).status, 409, 'seul l’hôte règle la course');
  for (const forged of [{}, { token: ana.id }, { id: ana.id }, { token: 'x' }]) {
    assert.equal((await post('/start', forged)).status, 409, 'start refusé sans jeton valide');
    assert.equal((await post('/settings', { ...forged, botsEnabled: false })).status, 409, 'settings refusé sans jeton valide');
  }
  assert(!JSON.stringify(await get(`/state?room=${ana.roomId}`)).includes(ana.token), 'le jeton n’est jamais diffusé');
  await post('/settings', { token: ana.token, punctureSeconds: 3 });
  await post('/settings', { token: ana.token, punctureSeconds: 999 });
  assert.equal((await get(`/state?room=${ana.roomId}`)).punctureSeconds, 3, 'durée de crevaison réglable, valeurs hors liste refusées');
  assert.equal((await get(`/state?room=${ana.roomId}`)).map, 'foret', 'la carte par défaut est la forêt');
  await post('/settings', { token: ana.token, map: 'desert' });
  await post('/settings', { token: ana.token, map: 'lune' });
  await post('/settings', { token: bao.token, map: 'ville' });
  assert.equal((await get(`/state?room=${ana.roomId}`)).map, 'desert', 'carte réglable par l’hôte seul, valeurs hors liste refusées');
  assert.equal((await post('/start', { token: ana.token })).status, 204);

  const started = await get(`/state?room=${ana.roomId}`);
  console.log(`texte tiré (${started.text.length} caractères) : ${started.text.slice(0, 90)}…`);
  assert.equal(started.cars.length, 5, '3 humains + 2 bots');
  const skinOf = (id) => started.cars.filter((car) => car.id === id).map((car) => [car.color, car.model])[0];
  assert.deepEqual(skinOf(bao.id), [0xb04dff, 'buggy'], 'le pilote garde la couleur et le modèle choisis');
  assert.deepEqual(skinOf(cy.id), [0x2f7bff, 'rallye'], 'couleur déjà prise ou modèle inconnu : repli sur le premier libre');
  cy.leave();
  await pause(200);
  assert.equal(new Set(started.cars.map((car) => car.color)).size, 5, 'une couleur par voiture');
  assert.equal((await post('/start', { token: ana.token })).status, 409, 'pas de relance tant que des humains courent');
  assert((await get('/rooms'))[0].racing, 'la liste signale la course en cours');

  await pause(started.startAt - Date.now() + 1500);
  const length = started.text.length;
  assert.equal(started.racePunctureSeconds, 3, 'la course garde la durée choisie');
  const text = started.text;
  const keys = (characters) => characters.map((character) => [character, Date.now()]);
  const progress = (player, from, characters, extra = {}) => post('/progress', { token: player.token, startAt: started.startAt, from, keys: keys(characters), ...extra });
  assert.equal((await progress(ana, 0, [text[0], '#', text[1]])).status, 204);
  assert.equal((await progress(ana, 0, [text[0], '#', text[1]])).status, 204, 'un lot rejoué est ignoré');
  assert.equal((await progress(ana, 9, [text[1]])).status, 409, 'un lot avec trou est refusé');
  assert.equal((await post('/progress', { token: ana.id, startAt: started.startAt, from: 3, keys: keys([text[1]]) })).status, 409, 'l’id ne sert pas de jeton');
  assert.equal((await post('/progress', { startAt: started.startAt, from: 3, keys: keys([text[1]]) })).status, 409, 'sans jeton, refus');
  assert.equal((await progress(bao, 0, [...text], { typed: 0 })).status, 204);

  const running = await get(`/state?room=${ana.roomId}`);
  const car = (id) => running.cars.find((candidate) => candidate.id === id);
  assert.deepEqual([car(ana.id).typed, car(ana.id).punctures], [1, 1], 'le serveur rejoue : une bonne frappe, une crevaison, la suite ignorée');
  assert(car(ana.id).penaltyUntil > running.now && car(ana.id).penaltyUntil <= running.now + 3000, 'la crevaison est chronométrée par le serveur');
  assert(!car(ana.id).unranked && car(ana.id).watch === undefined, 'état de contrôle jamais diffusé');
  assert(car(bao.id).finished && car(bao.id).finishTime > 1, 'le serveur chronomètre l’arrivée');
  assert(car(bao.id).unranked, 'texte entier tapé en rafale : non classé');
  assert(running.cars.some((candidate) => candidate.isBot && candidate.typed > 0), 'les bots tapent');

  ana.leave();
  await pause(200);
  assert.equal((await get(`/state?room=${ana.roomId}`)).hostId, bao.id, 'le pilote suivant devient hôte quand l’hôte quitte');
  assert.equal((await post('/settings', { token: bao.token, botsEnabled: false })).status, 204);
  assert.equal((await post('/start', { token: bao.token })).status, 204, 'relance possible quand les humains connectés ont fini');
  const restarted = await get(`/state?room=${ana.roomId}`);
  assert.equal(restarted.cars.length, 1, 'sans bots, seuls les humains courent');
  assert.notEqual(restarted.text, started.text, 'le texte change d’une course à l’autre');

  bao.leave();
  solo.leave();
  await pause(200);
  assert.deepEqual(await get('/rooms'), [], 'une course vide disparaît');
}

function checkTexts() {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'texts.json'), 'utf8'));
  const texts = [...corpus.fr, ...corpus.en, ...corpus.mg];
  assert(corpus.fr.length >= 3 * corpus.en.length, 'le français domine le recueil');
  assert.equal(new Set(texts).size, texts.length, 'aucun texte en double');
  for (const text of texts) {
    const typable = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    assert(/^[\x20-\x7e]+$/.test(typable), `caractère impossible à taper : ${text}`);
    assert(text.split(' ').length >= 10, `moins de 10 mots : ${text}`);
    assert(text.length >= 66 && text.length <= 320, `hors de 2 à 5 lignes : ${text}`);
    assert((text.match(/[A-Z]/g) || []).length <= 1 + (typable.match(/[.!?] [A-Z]/g) || []).length + 2, `trop de majuscules : ${text}`);
  }
  const drawn = Array.from({ length: 400 }, drawRaceText);
  assert(drawn.filter((text) => corpus.fr.includes(text)).length > 240, 'environ 70 % des courses en français');
  assert(drawn.some((text) => corpus.mg.includes(text)), 'des courses en malgache');
  assert(new Set(drawn.slice(0, 20)).size === 20, 'pas de répétition sur 20 courses');
  assert(drawn.some((text) => text.length <= 130) && drawn.some((text) => text.length > 130), 'des textes courts et longs');
}

checkPunctureRule()
  .then(checkKeyNormalization)
  .then(checkServerReplay)
  .then(checkPlausibility)
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

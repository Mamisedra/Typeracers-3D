const keyEquivalents = [[/[‘’ʼ]/g, "'"], [/[«»“”]/g, '"'], [/[  ]/g, ' ']];
const normalizeKey = (character) => keyEquivalents.reduce((text, [pattern, plain]) => text.replace(pattern, plain), character).normalize('NFD').replace(/[̀-ͯ]/g, '');
const matchesKey = (typed, expected) => typed === expected || normalizeKey(typed) === normalizeKey(expected);

function typeCharacter(race, car, character) {
  if (race.countdown > 0 || car.finished || car.penalty > 0) return 'locked';
  if (!matchesKey(character, race.text[car.typed])) {
    car.penalty = race.punctureSeconds;
    car.punctures++;
    car.streak = 0;
    car.mistake = character;
    return 'puncture';
  }
  car.typed++;
  car.streak++;
  if (car.typed === race.text.length) {
    car.finished = true;
    car.finishTime = race.time;
  }
  return 'hit';
}

if (typeof module !== 'undefined') module.exports = { normalizeKey, matchesKey, typeCharacter };

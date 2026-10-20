/**
 * @file js/game/letters.js
 * Pure game logic for the Countdown Letters Round.
 * Zero DOM access. Fully unit-testable.
 *
 * Implements:
 * - Authoritative TV vowel & consonant tile frequency distribution
 * - Stack shuffling at the start of a match (with automatic replenishment if exhausted)
 * - Vowel/Consonant selection constraints:
 *     At least 3 vowels and at least 4 consonants in the final 9 tiles.
 * - Word letter-multiset validation (checks whether a candidate word can be formed
 *   using each drawn tile at most once).
 */

import { shuffle, randomInt } from '../core/rng.js';

/**
 * Standard British TV Countdown tile distribution.
 * Vowels (67 tiles total): A×15, E×21, I×13, O×13, U×5
 * Consonants (74 tiles total): standard weighted distribution across the 21 consonants.
 * Tweak weights here to adjust tile probabilities.
 */
export const LETTER_DISTRIBUTION = Object.freeze({
  vowels: Object.freeze({
    A: 15,
    E: 21,
    I: 13,
    O: 13,
    U: 5
  }),
  consonants: Object.freeze({
    B: 2,
    C: 3,
    D: 6,
    F: 2,
    G: 3,
    H: 2,
    J: 1,
    K: 1,
    L: 5,
    M: 4,
    N: 8,
    P: 4,
    Q: 1,
    R: 9,
    S: 9,
    T: 9,
    V: 1,
    W: 1,
    X: 1,
    Y: 1,
    Z: 1
  })
});

export const MIN_VOWELS = 3;
export const MIN_CONSONANTS = 4;
export const BOARD_SIZE = 9;

/**
 * Expands a frequency map (e.g. { A: 15, E: 21 }) into a flat array of letter tiles.
 * @param {Record<string, number>} freqMap
 * @returns {string[]}
 */
export function expandFrequencyMap(freqMap) {
  const stack = [];
  for (const [letter, count] of Object.entries(freqMap)) {
    for (let i = 0; i < count; i++) {
      stack.push(letter.toUpperCase());
    }
  }
  return stack;
}

/**
 * Creates freshly shuffled vowel and consonant stacks for a match.
 * @param {() => number} [rng=Math.random]
 * @returns {{ vowels: string[], consonants: string[] }}
 */
export function createLetterStacks(rng = Math.random) {
  return {
    vowels: shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.vowels), rng),
    consonants: shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.consonants), rng)
  };
}

/**
 * Evaluates whether the picker is allowed to choose another Vowel or Consonant
 * given the current counts of vowels and consonants on the board.
 *
 * Rule: Final 9 letters must contain >= 3 vowels and >= 4 consonants.
 * Therefore:
 *   max vowels allowed = 9 - 4 = 5
 *   max consonants allowed = 9 - 3 = 6
 *
 * @param {number} vowelCount Current vowels picked
 * @param {number} consonantCount Current consonants picked
 * @returns {{ canPickVowel: boolean, canPickConsonant: boolean, isComplete: boolean }}
 */
export function getPickConstraints(vowelCount, consonantCount) {
  const total = vowelCount + consonantCount;
  if (total >= BOARD_SIZE) {
    return { canPickVowel: false, canPickConsonant: false, isComplete: true };
  }
  const maxVowels = BOARD_SIZE - MIN_CONSONANTS; // 5
  const maxConsonants = BOARD_SIZE - MIN_VOWELS; // 6

  return {
    canPickVowel: vowelCount < maxVowels,
    canPickConsonant: consonantCount < maxConsonants,
    isComplete: false
  };
}

/**
 * Draws a single tile ('V' for Vowel, 'C' for Consonant) from the stacks,
 * enforcing the 3-vowel / 4-consonant rule.
 * @param {'V'|'C'} kind
 * @param {{ vowels: string[], consonants: string[] }} stacks
 * @param {string[]} currentBoard
 * @param {() => number} [rng=Math.random]
 * @returns {{ tile: string, nextBoard: string[], vowelCount: number, consonantCount: number }}
 */
export function pickLetterTile(kind, stacks, currentBoard, rng = Math.random) {
  const vowelsSet = new Set(Object.keys(LETTER_DISTRIBUTION.vowels));
  const vowelCount = currentBoard.filter((ch) => vowelsSet.has(ch)).length;
  const consonantCount = currentBoard.length - vowelCount;
  const constraints = getPickConstraints(vowelCount, consonantCount);

  if (constraints.isComplete) {
    throw new Error('Board already has 9 letters.');
  }
  if (kind === 'V' && !constraints.canPickVowel) {
    throw new Error('Cannot pick another vowel: at least 4 consonants are required.');
  }
  if (kind === 'C' && !constraints.canPickConsonant) {
    throw new Error('Cannot pick another consonant: at least 3 vowels are required.');
  }

  let tile;
  if (kind === 'V') {
    if (stacks.vowels.length === 0) {
      stacks.vowels = shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.vowels), rng);
    }
    tile = stacks.vowels.pop();
  } else {
    if (stacks.consonants.length === 0) {
      stacks.consonants = shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.consonants), rng);
    }
    tile = stacks.consonants.pop();
  }

  const nextBoard = [...currentBoard, tile];
  const nextVowelCount = nextBoard.filter((ch) => vowelsSet.has(ch)).length;
  return {
    tile,
    nextBoard,
    vowelCount: nextVowelCount,
    consonantCount: nextBoard.length - nextVowelCount
  };
}

/**
 * Generates a complete valid 9-letter selection (3, 4, or 5 vowels; remaining consonants).
 * @param {{ vowels: string[], consonants: string[] }} stacks
 * @param {string[]} [existingBoard=[]]
 * @param {() => number} [rng=Math.random]
 * @returns {{ board: string[], vowelCount: number, consonantCount: number }}
 */
export function pickRandomRemainingLetters(stacks, existingBoard = [], rng = Math.random) {
  let board = [...existingBoard];
  const vowelsSet = new Set(Object.keys(LETTER_DISTRIBUTION.vowels));
  let vCount = board.filter((c) => vowelsSet.has(c)).length;
  let cCount = board.length - vCount;

  // Randomise the final vowel count for every Random Mix. The range is the
  // complete set allowed by the original format: 3, 4, or 5 vowels (and
  // therefore 6, 5, or 4 consonants).
  const minTargetV = Math.max(MIN_VOWELS, vCount);
  const maxTargetV = BOARD_SIZE - Math.max(MIN_CONSONANTS, cCount);
  if (minTargetV > maxTargetV) {
    throw new Error('Existing board cannot be completed with 3–5 vowels and 4–6 consonants.');
  }
  const targetVowels = randomInt(minTargetV, maxTargetV, rng);

  const remainingChoices = [];
  for (let i = vCount; i < targetVowels; i++) remainingChoices.push('V');
  while (board.length + remainingChoices.length < BOARD_SIZE) {
    remainingChoices.push('C');
  }

  const shuffledChoices = shuffle(remainingChoices, rng);
  for (const choice of shuffledChoices) {
    const res = pickLetterTile(choice, stacks, board, rng);
    board = res.nextBoard;
    vCount = res.vowelCount;
    cCount = res.consonantCount;
  }

  return { board, vowelCount: vCount, consonantCount: cCount };
}

/**
 * Irregular past tense and past participle verb mappings (inflected form -> base verb).
 * Supports standard English irregular verbs up to 9 letters.
 */
const IRREGULAR_VERBS = new Map([
  ['arose', 'arise'], ['arisen', 'arise'],
  ['ate', 'eat'], ['eaten', 'eat'],
  ['awoke', 'awake'], ['awoken', 'awake'],
  ['bore', 'bear'], ['born', 'bear'], ['borne', 'bear'],
  ['beat', 'beat'], ['beaten', 'beat'],
  ['became', 'become'],
  ['began', 'begin'], ['begun', 'begin'],
  ['bent', 'bend'], ['unbent', 'unbend'],
  ['bet', 'bet'],
  ['bit', 'bite'], ['bitten', 'bite'],
  ['bled', 'bleed'],
  ['blew', 'blow'], ['blown', 'blow'],
  ['broke', 'break'], ['broken', 'break'],
  ['bred', 'breed'],
  ['brought', 'bring'],
  ['broadcast', 'broadcast'],
  ['built', 'build'], ['rebuilt', 'rebuild'],
  ['burnt', 'burn'],
  ['burst', 'burst'],
  ['bought', 'buy'],
  ['cast', 'cast'], ['recast', 'recast'],
  ['caught', 'catch'],
  ['chose', 'choose'], ['chosen', 'choose'],
  ['clung', 'cling'],
  ['came', 'come'], ['overcame', 'overcome'],
  ['cost', 'cost'],
  ['crept', 'creep'],
  ['cut', 'cut'],
  ['dealt', 'deal'],
  ['dug', 'dig'],
  ['did', 'do'], ['done', 'do'], ['undid', 'undo'], ['undone', 'undo'],
  ['outdid', 'outdo'], ['outdone', 'outdo'], ['overdid', 'overdo'], ['overdone', 'overdo'],
  ['drew', 'draw'], ['drawn', 'draw'], ['withdrew', 'withdraw'], ['withdrawn', 'withdraw'],
  ['dreamt', 'dream'],
  ['drank', 'drink'], ['drunk', 'drink'], ['drunken', 'drink'],
  ['drove', 'drive'], ['driven', 'drive'],
  ['dwelt', 'dwell'],
  ['fell', 'fall'], ['fallen', 'fall'],
  ['fed', 'feed'], ['overfed', 'overfeed'], ['underfed', 'underfeed'],
  ['felt', 'feel'],
  ['fought', 'fight'],
  ['found', 'find'],
  ['fled', 'flee'],
  ['flung', 'fling'],
  ['flew', 'fly'], ['flown', 'fly'], ['overflew', 'overfly'], ['overflown', 'overfly'],
  ['forbade', 'forbid'], ['forbidden', 'forbid'],
  ['forecast', 'forecast'],
  ['foresaw', 'foresee'], ['foreseen', 'foresee'],
  ['foretold', 'foretell'],
  ['forgot', 'forget'], ['forgotten', 'forget'],
  ['forgave', 'forgive'], ['forgiven', 'forgive'],
  ['forsook', 'forsake'], ['forsaken', 'forsake'],
  ['froze', 'freeze'], ['frozen', 'freeze'],
  ['got', 'get'], ['gotten', 'get'],
  ['gave', 'give'], ['given', 'give'],
  ['went', 'go'], ['gone', 'go'],
  ['ground', 'grind'],
  ['grew', 'grow'], ['grown', 'grow'], ['outgrew', 'outgrow'], ['overgrew', 'overgrow'],
  ['hung', 'hang'],
  ['had', 'have'],
  ['heard', 'hear'],
  ['hid', 'hide'], ['hidden', 'hide'],
  ['hit', 'hit'],
  ['held', 'hold'], ['upheld', 'uphold'], ['withheld', 'withhold'], ['beheld', 'behold'],
  ['hurt', 'hurt'],
  ['kept', 'keep'],
  ['knelt', 'kneel'],
  ['knit', 'knit'],
  ['knew', 'know'], ['known', 'know'],
  ['laid', 'lay'], ['mislaid', 'mislay'],
  ['led', 'lead'], ['misled', 'mislead'],
  ['leapt', 'leap'],
  ['learnt', 'learn'],
  ['left', 'leave'],
  ['lent', 'lend'],
  ['let', 'let'],
  ['lay', 'lie'], ['lain', 'lie'],
  ['lit', 'light'],
  ['lost', 'lose'],
  ['made', 'make'], ['remade', 'remake'],
  ['meant', 'mean'],
  ['met', 'meet'],
  ['mistook', 'mistake'], ['mistaken', 'mistake'],
  ['mowed', 'mow'], ['mown', 'mow'],
  ['outran', 'outrun'], ['overran', 'overrun'],
  ['oversaw', 'oversee'], ['overseen', 'oversee'],
  ['overslept', 'oversleep'],
  ['overtook', 'overtake'], ['overtaken', 'overtake'],
  ['paid', 'pay'], ['repaid', 'repay'], ['overpaid', 'overpay'], ['underpaid', 'underpay'],
  ['put', 'put'],
  ['quit', 'quit'],
  ['read', 'read'],
  ['reset', 'reset'],
  ['retold', 'retell'],
  ['rid', 'rid'],
  ['rode', 'ride'], ['ridden', 'ride'],
  ['rang', 'ring'], ['rung', 'ring'],
  ['rose', 'rise'], ['risen', 'rise'],
  ['ran', 'run'],
  ['saw', 'see'], ['seen', 'see'],
  ['sought', 'seek'],
  ['sold', 'sell'],
  ['sent', 'send'],
  ['set', 'set'],
  ['sewed', 'sew'], ['sewn', 'sew'],
  ['shook', 'shake'], ['shaken', 'shake'],
  ['shaved', 'shave'], ['shaven', 'shave'],
  ['shed', 'shed'],
  ['shone', 'shine'],
  ['shot', 'shoot'],
  ['showed', 'show'], ['shown', 'show'],
  ['shrank', 'shrink'], ['shrunk', 'shrink'],
  ['shut', 'shut'],
  ['sang', 'sing'], ['sung', 'sing'],
  ['sank', 'sink'], ['sunk', 'sink'], ['sunken', 'sink'],
  ['sat', 'sit'],
  ['slept', 'sleep'],
  ['slid', 'slide'],
  ['slung', 'sling'],
  ['slunk', 'slink'],
  ['slit', 'slit'],
  ['smelt', 'smell'],
  ['smote', 'smite'], ['smitten', 'smite'],
  ['sowed', 'sow'], ['sown', 'sow'],
  ['spoke', 'speak'], ['spoken', 'speak'],
  ['sped', 'speed'],
  ['spelt', 'spell'], ['misspelt', 'misspell'],
  ['spent', 'spend'], ['misspent', 'misspend'],
  ['spilt', 'spill'],
  ['spun', 'spin'],
  ['spat', 'spit'],
  ['split', 'split'],
  ['spoilt', 'spoil'],
  ['spread', 'spread'],
  ['sprang', 'spring'], ['sprung', 'spring'],
  ['stood', 'stand'], ['understood', 'understand'], ['withstood', 'withstand'],
  ['stole', 'steal'], ['stolen', 'steal'],
  ['stuck', 'stick'],
  ['stung', 'sting'],
  ['stank', 'stink'], ['stunk', 'stink'],
  ['struck', 'strike'], ['stricken', 'strike'],
  ['strung', 'string'],
  ['strove', 'strive'], ['striven', 'strive'],
  ['swore', 'swear'], ['sworn', 'swear'],
  ['swept', 'sweep'],
  ['swelled', 'swell'], ['swollen', 'swell'],
  ['swam', 'swim'], ['swum', 'swim'],
  ['swung', 'swing'],
  ['took', 'take'], ['taken', 'take'],
  ['taught', 'teach'],
  ['tore', 'tear'], ['torn', 'tear'],
  ['told', 'tell'],
  ['thought', 'think'],
  ['threw', 'throw'], ['thrown', 'throw'],
  ['thrust', 'thrust'],
  ['trod', 'tread'], ['trodden', 'tread'],
  ['underwent', 'undergo'], ['undergone', 'undergo'],
  ['undertook', 'undertake'], ['undertaken', 'undertake'],
  ['upset', 'upset'],
  ['woke', 'wake'], ['woken', 'wake'],
  ['wore', 'wear'], ['worn', 'wear'], ['outworn', 'outwear'],
  ['wove', 'weave'], ['woven', 'weave'],
  ['wept', 'weep'],
  ['wet', 'wet'],
  ['won', 'win'],
  ['wound', 'wind'], ['unwound', 'unwind'], ['rewound', 'rewind'],
  ['withstood', 'withstand'],
  ['wrung', 'wring'],
  ['wrote', 'write'], ['written', 'write']
]);

/**
 * Irregular plural noun mappings (plural form -> singular base noun).
 * Supports standard English irregular and Latin/Greek plurals up to 9 letters.
 */
const IRREGULAR_PLURALS = new Map([
  ['men', 'man'],
  ['women', 'woman'],
  ['children', 'child'],
  ['teeth', 'tooth'],
  ['feet', 'foot'],
  ['geese', 'goose'],
  ['mice', 'mouse'],
  ['dormice', 'dormouse'],
  ['titmice', 'titmouse'],
  ['lice', 'louse'],
  ['oxen', 'ox'],
  ['people', 'person'],
  ['dice', 'die'],
  ['pence', 'penny'],
  ['cacti', 'cactus'],
  ['fungi', 'fungus'],
  ['foci', 'focus'],
  ['nuclei', 'nucleus'],
  ['radii', 'radius'],
  ['syllabi', 'syllabus'],
  ['alumni', 'alumnus'],
  ['stimuli', 'stimulus'],
  ['crises', 'crisis'],
  ['bases', 'basis'],
  ['theses', 'thesis'],
  ['axes', 'axis'],
  ['oases', 'oasis'],
  ['analyses', 'analysis'],
  ['hypotheses', 'hypothesis'],
  ['diagnoses', 'diagnosis'],
  ['synopses', 'synopsis'],
  ['criteria', 'criterion'],
  ['phenomena', 'phenomenon'],
  ['media', 'medium'],
  ['bacteria', 'bacterium'],
  ['strata', 'stratum'],
  ['curricula', 'curriculum'],
  ['memoranda', 'memorandum'],
  ['antennae', 'antenna'],
  ['formulae', 'formula'],
  ['larvae', 'larva'],
  ['nebulae', 'nebula'],
  ['vertebrae', 'vertebra'],
  ['alumnae', 'alumna'],
  ['indices', 'index'],
  ['matrices', 'matrix'],
  ['appendices', 'appendix'],
  ['vertices', 'vertex'],
  ['vortices', 'vortex']
]);

/**
 * Nouns with strictly irregular plurals that must not be formed with a naive trailing -s/-es.
 */
const STRICT_IRREGULAR_PLURAL_BASES = new Set([
  'foot', 'tooth', 'child', 'mouse', 'dormouse', 'titmouse', 'louse', 'goose', 'ox', 'man', 'woman'
]);

/**
 * Returns candidate base forms for English inflections:
 * - Past tense and past participle verb forms (-ed, -d, -ied, -cked, doubled consonants, irregulars)
 * - Present continuous / participle verb forms (-ing, -ying, -cking, dropped -e, doubled consonants)
 * - Plural noun forms (-s, -es, -ies, -ves, -oes, irregulars, compound *men, Latin/Greek forms)
 *
 * This allows the Letters round to accept inflections even when the lexicon contains
 * only base forms.
 *
 * @param {string} word Lower-case alphabetic word
 * @returns {string[]}
 */
export function getInflectionCandidates(word) {
  const candidates = new Set();
  const add = (candidate) => {
    if (typeof candidate === 'string' && candidate.length >= 2 && candidate !== word) {
      candidates.add(candidate);
    }
  };

  // 1. Direct irregular verb lookup (past tense & participle -> base)
  const irregularVerb = IRREGULAR_VERBS.get(word);
  if (irregularVerb) add(irregularVerb);

  // 2. Direct irregular plural lookup (plural -> singular)
  const irregularPlural = IRREGULAR_PLURALS.get(word);
  if (irregularPlural) add(irregularPlural);

  // 3. Compound nouns ending in "men" -> "man" (gentlemen -> gentleman, etc.)
  if (word.endsWith('men') && word.length > 3) {
    add(`${word.slice(0, -3)}man`);
  }

  // 4. Past tense verb candidates:
  // -ied: try -> tried, study -> studied, cry -> cried
  if (word.endsWith('ied')) {
    add(`${word.slice(0, -3)}y`);
  }
  // -cked: panic -> panicked, picnic -> picnicked, mimic -> mimicked, traffic -> trafficked
  if (word.endsWith('cked') && word.length > 4) {
    add(`${word.slice(0, -4)}c`);
  }
  // Regular -ed: walk -> walked, love -> loved, stop -> stopped, travel -> travelled
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    add(stem);                     // walked -> walk, melted -> melt
    add(`${stem}e`);               // loved -> love, moved -> move, danced -> dance
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
      add(stem.slice(0, -1));      // stopped -> stop, planned -> plan, grabbed -> grab
    }
  }

  // 5. Present participle / continuous (-ing) candidates:
  // -cking: panicking -> panic, picnicking -> picnic, mimicking -> mimic
  if (word.endsWith('cking') && word.length > 5) {
    add(`${word.slice(0, -5)}c`);
  }
  // Regular -ing:
  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    add(stem);                     // walking -> walk, playing -> play, trying -> try
    add(`${stem}e`);               // making -> make, dancing -> dance, writing -> write
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
      add(stem.slice(0, -1));      // running -> run, swimming -> swim, sitting -> sit
    }
    if (stem.endsWith('y')) {
      add(`${stem.slice(0, -1)}ie`); // lying -> lie, dying -> die, tying -> tie
    }
  }

  // 6. Plural noun candidates:
  // -ies: cities -> city, babies -> baby, stories -> story, flies -> fly
  if (word.endsWith('ies')) {
    add(`${word.slice(0, -3)}y`);
  }
  // -ves: knives -> knife, leaves -> leaf, lives -> life, wolves -> wolf
  if (word.endsWith('ves')) {
    add(`${word.slice(0, -3)}f`);
    add(`${word.slice(0, -3)}fe`);
  }
  // -es: boxes -> box, buses -> bus, watches -> watch, dishes -> dish, heroes -> hero
  if (word.endsWith('es')) {
    const stem = word.slice(0, -2);
    if (!STRICT_IRREGULAR_PLURAL_BASES.has(stem)) {
      add(stem);                     // box -> boxes, hero -> heroes
      if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
        add(stem.slice(0, -1));      // quizzes -> quiz, busses -> bus
      }
    }
    // Greek -ses/-xes: crises -> crisis, axes -> axis, bases -> basis
    if (word.endsWith('ses') || word.endsWith('xes')) {
      add(`${word.slice(0, -2)}is`);
    }
  }
  // -ices: indices -> index, matrices -> matrix, vertices -> vertex
  if (word.endsWith('ices') && word.length > 4) {
    add(`${word.slice(0, -4)}ex`);
    add(`${word.slice(0, -4)}ix`);
  }
  // Latin -i -> -us: cacti -> cactus, fungi -> fungus, nuclei -> nucleus
  if (word.endsWith('i') && word.length >= 4) {
    add(`${word.slice(0, -1)}us`);
  }
  // Latin/Greek -a -> -on/-um: criteria -> criterion, bacteria -> bacterium, media -> medium
  if (word.endsWith('a') && word.length >= 4) {
    add(`${word.slice(0, -1)}on`);
    add(`${word.slice(0, -1)}um`);
  }
  // Latin -ae -> -a: formulae -> formula, antennae -> antenna, larvae -> larva
  if (word.endsWith('ae') && word.length >= 4) {
    add(word.slice(0, -1));
  }
  // Regular -s: cats -> cat, dogs -> dog, houses -> house
  if (word.endsWith('s')) {
    const stem = word.slice(0, -1);
    if (!STRICT_IRREGULAR_PLURAL_BASES.has(stem)) {
      add(stem);
    }
  }

  return [...candidates];
}

/**
 * Checks exact lexicon membership plus regular & irregular past tense verbs,
 * present continuous (-ing) verbs, and plural nouns.
 *
 * @param {string} word Lower-case word
 * @param {Set<string>} dictionarySet
 * @returns {boolean}
 */
export function isDictionaryWordOrInflection(word, dictionarySet) {
  if (!dictionarySet) return true;
  if (dictionarySet.has(word)) return true;
  return getInflectionCandidates(word).some((candidate) => dictionarySet.has(candidate));
}

/**
 * Validates whether `word` can be constructed from the 9-letter `board`
 * (using each tile at most once) and optionally checks membership in `dictionarySet`.
 *
 * Explicitly handles edge cases:
 * - Empty string or whitespace
 * - 1-letter words (Countdown requires at least 2 letters, and only words in dictionary)
 * - Non-alphabetic characters
 * - Using a letter more times than it appears on the board
 *
 * @param {string} word
 * @param {string[]} board
 * @param {Set<string>|null} [dictionarySet=null]
 * @returns {{
 *   valid: boolean,
 *   reason: 'ok'|'empty'|'too_short'|'too_long'|'non_alpha'|'missing_letters'|'not_in_dictionary',
 *   missingLetter?: string,
 *   normalizedWord: string
 * }}
 */
export function validateWordSubmission(word, board, dictionarySet = null) {
  if (typeof word !== 'string') {
    return { valid: false, reason: 'empty', normalizedWord: '' };
  }
  const clean = word.trim().toUpperCase();
  if (clean.length === 0) {
    return { valid: false, reason: 'empty', normalizedWord: '' };
  }
  if (!/^[A-Z]+$/.test(clean)) {
    return { valid: false, reason: 'non_alpha', normalizedWord: clean };
  }
  if (clean.length < 2) {
    return { valid: false, reason: 'too_short', normalizedWord: clean };
  }
  if (clean.length > BOARD_SIZE) {
    return { valid: false, reason: 'too_long', normalizedWord: clean };
  }

  // Check tile multiset availability
  const counts = new Map();
  for (const letter of board) {
    const up = String(letter).toUpperCase();
    counts.set(up, (counts.get(up) || 0) + 1);
  }

  for (const ch of clean) {
    const avail = counts.get(ch) || 0;
    if (avail <= 0) {
      return {
        valid: false,
        reason: 'missing_letters',
        missingLetter: ch,
        normalizedWord: clean
      };
    }
    counts.set(ch, avail - 1);
  }

  if (dictionarySet && !isDictionaryWordOrInflection(clean.toLowerCase(), dictionarySet)) {
    return { valid: false, reason: 'not_in_dictionary', normalizedWord: clean };
  }

  return { valid: true, reason: 'ok', normalizedWord: clean };
}

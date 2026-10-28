/**
 * Lexicon health check for the Countdown Letters round.
 *
 * Checks:
 * 1. data/words.txt data quality (duplicates, non-alpha, mixed case, length > 9)
 * 2. Curated common/modern English words (2-9 letters) that must be in the lexicon
 * 3. FALLBACK_WORDS in js/solver/wordSolver.js (junk fragments, names, capitalized entries)
 *
 * Run: node scripts/check-lexicon-gaps.mjs
 * Exits with code 1 when any check fails.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL: ${msg}`);
};

// ---------- 1. words.txt data quality ----------
const raw = readFileSync('data/words.txt', 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const set = new Set(lines);

const seen = new Set();
const duplicates = [];
const nonAlpha = [];
const mixedCase = [];
const tooLong = [];
for (const line of lines) {
  if (seen.has(line)) duplicates.push(line);
  seen.add(line);
  if (!/^[a-z]+$/.test(line)) {
    if (/^[A-Z]/.test(line)) mixedCase.push(line);
    else nonAlpha.push(line);
  }
  if (line.length > 9) tooLong.push(line);
}

console.log(`[1] data/words.txt: ${lines.length} words`);
if (duplicates.length) fail(`duplicates: ${duplicates.slice(0, 20).join(', ')}`);
else console.log('    no duplicates');
if (mixedCase.length) fail(`mixed case: ${mixedCase.slice(0, 20).join(', ')}`);
else console.log('    no mixed-case entries');
if (nonAlpha.length) fail(`non-alpha: ${nonAlpha.slice(0, 20).join(', ')}`);
else console.log('    no non-alpha entries');
if (tooLong.length) fail(`longer than 9 letters: ${tooLong.slice(0, 20).join(', ')}`);
else console.log('    no words longer than 9 letters');

// ---------- 2. Required common words checklist ----------
// High-frequency and modern English words (2-9 letters) that a Countdown
// lexicon must contain. Keep alphabetical.
const REQUIRED = `
barista bitcoin cosplay droid emoticon emoji emojis esports gameplay hashtag hotspot
meme memes mentee milkshake netball paleo phishing pilates photobomb playgroup ramen
roadmap romcom selfie selfies seahorse sudoku taekwondo vlog vlogger vlogging waterski
webinar
absolutely accept access across action active actually address admire adult adventure
advert advice afford afraid afternoon again agenda agree ahead airline airport alarm
album alive allow almost alone along already also always amazing among amount ancient
angry animal announce annual answer anxiety anymore anyway apartment appear apple apply
approach approve architect area argue around arrive article artist asleep aspect assist
assume attach attack attempt attend attention attitude attract audience author autumn
available average avoid awake aware away awful baby back background bad bag balance ball
band bank bar bargain barrier base basic basket bath battle beach beautiful beauty
because become bed bedroom bee beef beer before begin behave behaviour behind belief
believe bell belong below belt bench bend benefit berry beside best better between beyond
bicycle big bike bill bin biology bird birth birthday bit bite bitter black blade blame
blanket bless blind block blood blow blue board boat body boil bomb bone book border
bored borrow boss both bottle bottom bowl box boy brain branch brave bread break
breakfast breath breathe breeze brick bridge brief bright brilliant bring broad broken
bronze broom brother brown brush bubble bucket budget bug build bulb bull bullet bunch
bundle burden burn bus business busy butter button buy cabbage cabin cable cake calculate
calendar call calm camera camp campaign can cancel cancer candidate candle cannot cap
capable capital captain capture car carbon card care career careful cargo carpet carriage
carrot carry cart case cash cast castle casual cat catch category cause ceiling celebrate
cell cement cent centre century ceremony certain chain chair challenge champion chance
change channel chapter character charge charity chart chase cheap check cheese chef
chemical chest chicken chief child chill chimney choice choose church circle circuit
citizen city civil claim class classic clean clear clever click client cliff climb clinic
clock close cloth cloud club clue coach coal coast coat code coffee coin cold collapse
collar colleague collect college colour column comb combine come comedy comfort comic
command comment common community company compare compete complain complete computer
concept concern concert conclude condition conduct confirm conflict confuse connect
consider consist constant contact contain content contest context continue contract
contrast control convention conversation convert cook cool cooperate copy core corner
correct cost cottage cotton couch cough could council count country couple courage course
court cousin cover cow crack craft crash crazy cream create creature credit crew crime
crisis critic crop cross crowd crown cruel cruise crush crystal culture cup cupboard
curious current curtain custom customer cut cute cycle daily damage damp dance danger
dare dark data date daughter day dead deal dear death debate debt decade decide decision
declare decorate deep defeat defend define degree delay delete delicate delicious deliver
demand demo democracy dentist deny depart depend describe desert deserve design desire
desk despite destroy detail detect determine develop device diagram dialogue diary die
differ difficult dig digital dinner direct dirt disagree disappear disaster discount
discuss disease dish dismiss display distance distinct divide do doctor document dog
dollar door double doubt down download dozen draft drag drama draw drawer dream dress
drill drink drive drop drought drum dry duck due dull dust duty each eager ear early earn
earth ease east easy eat economy edge edit education effect effort egg eight either
elbow elect electric elegant element elephant else email embarrass embrace emerge
emergency emotion empire employ empty enable end enemy energy engine engineer enjoy
enough enter entire entrance envelope environment equal equip error escape essay
establish estate estimate evaluate even evening event ever every evidence exact exam
example excellent except exchange excite excuse exercise exist exit expand expect
expensive experience expert explain explore express extend extra extreme eye fabric face
fact factory fail fair fall false family famous fan fancy fantasy far farm fashion fast
fat father fault favour fear feast feather feature fee feed feel female fence festival
fetch fever few fiction field fight figure file fill film final finance find fine finger
finish fire firm first fish fit five fix flag flame flash flat flavour flaw flee flesh
flight float flood floor flour flower fly focus fog fold folk follow food fool foot for
force foreign forest forget fork form former fortune forward fossil foster found fountain
four fox fragile frame free freedom freeze frequent fresh friend frighten from front
frost fruit fuel full fun function fund funeral funny fur furniture further future gain
galaxy gallery game gang gap garage garden garlic gas gate gather general generate
generous genius gentle gentleman genuine geography get gift girl give glad glance glass
globe glory glove goal goat god gold golf good goose gossip govern grade grain grammar
grand grant grape graph grasp grass grateful grave gravity gray great green greet grey
grill grind grip ground group grow guarantee guard guess guest guide guitar gun guy gym
habit hair half hall ham hand handle hang happen happy harbour hard harm harvest hat hate
have head heal health heart heat heaven heavy hedge height hello help hen here hero
hesitate hide high hill hint hire history hit hobby hold hole holiday hollow holy home
honey honour hook hope horse hospital host hot hotel hour house hover how however huge
human humble humour hundred hungry hunt hurry hurt husband ice icon idea ideal identify
idiom ignore ill illegal illness image imagine imitate immediate impact import impose
impress improve impulse inch include income increase indeed index indicate industry
infant infection inform initial inject injure injury ink inner innocent input insect
inside insist inspect inspire install instead institute instruct insult insurance intend
intense interest interfere internal international internet interpret interrupt interval
interview into introduce invent invest invite involve iron island issue item ivory
jacket jail jam jar jaw jazz jealous jeans jelly jet jewel job join joint joke journal
journey joy judge juice jump jungle junior junk jury just justice keen keep kettle key
keyboard kick kid kidney kill kind king kiss kit kitchen kite kitten knee knife knight
knock know knowledge label labour lace lack ladder lady lake lamb lamp land landscape
lane language large laser last late later laugh launch laundry law lawn lawyer lay layer
lazy lead leader leaf league lean learn lease least leather leave lecture left leg legal
legend leisure lemon lend length lens less lesson let letter level liberal library
license lid lie life lift light like limit line link lion lip liquid list listen little
live liver load loaf loan local locate lock log logic lonely long look loop loose lord
lose loss lot loud love lovely low loyal luck luggage lunch lung luxury machine mad
magazine magic magnet maid mail main maintain major make male mall man manage manner
manual many map marble march mark market marriage marry mask mass master match mate
material math matter mature maximum may maybe mayor meal mean measure meat mechanic
medicine medium meet melon melt member memory mention menu merchant mercy mere message
metal method middle midnight might mile milk mill million mind mine mineral minimum
minister minor minute miracle mirror miss missile mission mistake mix mobile model
modern modest modify moment money monitor monkey month monument mood moon moral morning
mortal mortgage most mother motion motor mount mountain mouse mouth move movie much mud
mug murder muscle museum music must mustard mystery myth nail name narrow nasty nation
native natural nature naughty naval navy near nearly neat necessary neck need needle
negative neglect neighbour neither nerve nervous nest net network neutral never new news
next nice niece night nine noble nobody nod noise none noon nor normal north nose not
note nothing notice notion noun now nowhere nuclear number nurse nut oak oath obey object
observe obtain obvious occasion occupy occur ocean october odd offer office officer often
oil okay old olive omit once one onion online only onto open opera operate opinion
opponent opposite option orange orbit orchestra order ordinary organ organise origin
ornament orphan other otherwise ought ounce out outcome outside oval oven over overcome
owe owl own owner ox oxygen oyster ozone pace pack page pain paint pair palace pale palm
pan panel panic paper parade paragraph parcel pardon parent park part partner party pass
passenger passion past pasta paste path patience patient patio pattern pause pay peace
peach peak peanut pearl peasant pen penalty pencil penguin penny people pepper percent
perfect perform perhaps period permit person persuade pet phone photo phrase physical
piano pick picture pie piece pig pigeon pile pilot pin pine pink pint pipe pirate pitch
pity pizza place plain plan plane planet plank plant plastic plate platform play player
plaza please pleasure plenty plot plug plus pocket poem poet point poison poke polar
police policy polish polite political pollution pond pool poor pop popular population
porch pork port portion portrait position positive possess possible post potato
potential pound pour poverty powder power practice praise pray preach precious prefer
pregnant prepare presence present preserve president press pressure pretend pretty
prevent previous price pride priest primary prime prince princess principal print prior
prison private prize probably problem procedure proceed process produce product
profession professor profit program progress project promise promote prompt proof proper
property propose protect protein protest proud prove provide public publish pull pulse
pump pumpkin punch punish pupil purchase pure purple purpose pursue push put puzzle
pyramid quality quantity quarter queen question queue quick quiet quit quite quote
rabbit race rack radar radio rail rain raise rally random range rank rapid rare rate
rather ratio raw ray reach react read ready real realise reality realize really reason
recall receive recent recipe recite record recover recruit red reduce refer reflect
reform refuse regard regime region register regret regular regulate rehearse reject
relate relax release relevant relief religion rely remain remark remedy remember remind
remote remove renew rent repair repeat replace reply report represent request require
rescue research reserve resident resist resolve resort resource respect respond rest
restaurant result resume retail retain retire return reveal revenue reverse review
revise revive revolt reward rhythm rice rich ride ridge rifle right rigid ring riot rise
risk river rival road roar roast rob robot rock rocket rod role roll roof room root rope
rose rot rough round route routine row royal rub rugby rule run rush rural sad saddle
safe safety sage said sail sake salad sale salmon salon salt salute same sample sand
satisfy sauce save say scale scan scare scene scent schedule scheme school science
scissors score scout scrap scrape scratch screen screw script sculpture sea seal search
season seat second secret section secure seed seek seem segment seize seldom select self
sell senate send senior sense sentence separate sequence serene series serious serve
service session set settle several severe sew shade shadow shaft shake shallow shame
shape share shark sharp shave shed sheep sheer sheet shelf shell shelter shield shift
shine ship shirt shock shoe shoot shop shore short shoulder shout show shower shrimp
shrink shrug shut shuttle shy sick side siege sigh sight sign signal silence silent silk
silly silver similar simple simply sin since sincere sing single sink site situation six
size skate sketch ski skill skin skirt skull slave sleep sleeve slice slide slight slim
slip slope slow small smart smile smoke smooth snack snake snow soak soap soccer social
society sock sofa soft soil solar soldier sole solid solve son song soon sorry sort soul
sound soup source south space spare spark speak special species specific speech speed
spell spend sphere spice spider spill spin spirit spite split spoil sponsor spoon sport
spot spouse spray spread spring sprinkle square squeeze stable stadium staff stage stairs
stamp stand staple star stare start state station statue status stay steady steak steal
steam steel steep steer stem step stereo stick stiff still sting stir stock stomach stone
stool stop store storm story stove straight strain strange stream street stress stretch
strict strike string strip stroke strong structure struggle student study stuff stumble
stupid style subject submit substance succeed success such sudden suffer sufficient sugar
suggest suit summit sun super supply support suppose sure surf surprise survive suspect
swallow swear sweat sweep sweet swell swim swing switch sword symbol sympathy symptom
system table tackle tactic tag tail take tale talent talk tall tank tap tape target task
taste tattoo tax taxi tea teach team tear tease tech technique technology teeth telephone
television tell temper temple tempt tend tender tennis tense tent term terrible territory
terror test text texture than thank that theatre their theme then theory there therefore
thermal these thick thief thigh thin thing think third thirst this thorn thorough though
thought thousand thread threat thrill throat through throw thumb thunder ticket tide tidy
tie tiger tight tile till timber time tin tiny tip tired tissue title toast today toe
together toilet tomato tomb tone tongue tonight tool tooth top topic torch total touch
tough tour tourist toward towel tower town toy trace track trade tradition traffic
tragedy trail train trait transform translate transport trap travel tray treat treaty
tremble trend trial triangle tribe trick trigger trim trip triumph troop trouble trousers
truck true trumpet trunk trust truth try tube tuesday tune tunnel turkey turn turtle
tutor twice twig twin twist type typical tyre ugly ultimate umbrella unable uncle under
understand uniform union unique unit unite unity universe university unless until unusual
up update upper upset urban urge urgent usage use useful usual utility utter vacant
vacuum vain valid valley value valve van vanish vapour vary vast vault vegetable vehicle
veil vein velvet vendor venture venue verb verdict verse version very vessel vest veteran
veto via viable vibrant vicious victim victory video view village vintage violence violin
virtue virus visa visible vision visit visual vital vivid vocal voice volcano volume
voluntary vote vow voyage wade wage wagon waist wait wake walk wall wallet walnut want
war ward warm warn warrant warrior wash waste watch water wave wax way weak wealth weapon
wear weather weave website wedge week weep weigh weird welcome welfare well west wet
whale wheat wheel when where whether while whisper whistle white whole who wholesale wide
widow width wife wild will win wind window wine wing winter wipe wire wisdom wise wish
wit with witness wolf woman wonder wood wool word work world worry worse worship worth
wound wrap wreck wrist write wrong yacht yard yawn year yell yellow yes yesterday yet
yield yoga young your youth zebra zone zoo
`.split(/\s+/).filter(Boolean);

const requiredMissing = [...new Set(REQUIRED)].filter((w) => w.length >= 2 && w.length <= 9 && !set.has(w));
console.log(`\n[2] Required common words: ${REQUIRED.length} checked`);
if (requiredMissing.length) fail(`missing from words.txt: ${requiredMissing.join(', ')}`);
else console.log('    all present');

// ---------- 3. FALLBACK_WORDS lint ----------
const src = readFileSync('js/solver/wordSolver.js', 'utf8');
const m = src.match(/const FALLBACK_WORDS = \[([\s\S]*?)\n\];/);
if (!m) {
  fail('FALLBACK_WORDS array not found in js/solver/wordSolver.js');
} else {
  const fallback = m[1].match(/'([^']*)'/g).map((s) => s.slice(1, -1));
  const capitalized = fallback.filter((w) => /^[A-Z]/.test(w));
  const knownJunk = new Set(['els', 'ike', 'ut', 'ise', 'ow', 'ack', 'auti', 'orial', 'uffin', 'adox', 'pre', 'sim', 'simon']);
  console.log(`\n[3] FALLBACK_WORDS: ${fallback.length} entries`);
  if (capitalized.length) fail(`capitalized entries: ${capitalized.join(', ')}`);
  else console.log('    no capitalized entries');
  const junkFound = fallback.filter((w) => knownJunk.has(w));
  if (junkFound.length) fail(`junk fragments/names present: ${junkFound.join(', ')}`);
  else console.log('    no junk fragments or names');
  // every fallback word must be a real lexicon word or a valid 2-9 letter word shape
  const notInLexicon = fallback.filter((w) => /^[a-z]{2,9}$/.test(w) && !set.has(w));
  if (notInLexicon.length) {
    console.log(`    note: ${notInLexicon.length} fallback words not in words.txt (allowed for minimal fallback): ${notInLexicon.slice(0, 15).join(', ')}${notInLexicon.length > 15 ? '...' : ''}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

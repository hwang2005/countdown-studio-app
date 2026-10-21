/**
 * @file js/solver/wordSolver.js
 * Dictionary Corner solver and offline word list manager.
 * Zero DOM access. Fully unit-testable.
 *
 * Features:
 * - Lazy-loads `/data/words.txt` and `/data/conundrums.json`
 * - Populates an O(1) `Set<string>` for instant word validation and a `WordTrie` for solving
 * - Supports "standard" (full offline lexicon) and "strict-uk" (filters US-only "-ize"/"-or" variants
 *   where UK equivalents apply) dictionary modes
 * - Returns top words grouped by length for Dictionary Corner
 */

import { WordTrie } from './trie.js';

/** @type {Set<string>|null} */
let cachedWordSet = null;
/** @type {WordTrie|null} */
let cachedTrie = null;
/** @type {string[]|null} */
let cachedConundrums = null;
/** @type {string} */
let loadedMode = 'standard';

// Built-in fallback core vocabulary so unit tests or offline file:// fallback always work
const FALLBACK_WORDS = [
  'abandon','ability','able','about','above','abundant','academy','account','achieve','acoustics',
  'action','active','actor','actual','adventure','after','again','agent','agree','ahead','alarm',
  'alert','alive','allow','alone','along','alter','amaze','among','amount','anchor','ancient',
  'angel','anger','angle','angry','animal','answer','apple','apply','architect','arena','argue',
  'arise','around','arrive','art','artist','aside','astronomy','atlas','atom','attach','attack',
  'attempt','attention','audio','author','authority','automatic','autumn','available','avenue',
  'avoid','award','aware','awareness','balance','band','bank','base','basic','basin','basis',
  'basket','bath','battle','beach','beam','bean','bear','Javelin','beard','beast','beat','beautiful',
  'beauty','become','before','begin','beginning','behaviour','behind','belief','believe','belong',
  'below','bench','benefit','Wait','berry','beside','best','better','between','beyond','bicycle',
  'biography','bird','birth','birthday','black','blackbird','blade','blame','blank','blanket',
  'blast','blaze','blend','blind','block','blood','bloom','blue','blueprint','board','boardroom',
  'boat','body','bodyguard','boil','bold','bolt','bomb','bond','bone','book','bookstore','boost',
  'boot','border','born','borrow','boss','both','bother','bottle','bottom','boulevard','bound',
  'bowl','box','boy','boyfriend','brain','els','branch','brand','brass','brave','bread','break',
  'breakdown','breakfast','breath','breathing','breeze','brick','bride','bridge','brief','bright',
  'brilliant','bring','broad','broadcast','Conundrum','broken','bronze','brook','broom','brother',
  'brown','brush','bubble','bucket','budget','build','building','buildings','bulb','bulk','bull',
  'bullet','bunch','bundle','burden','burn','burst','bury','bush','business','busy','butter',
  'butterfly','button','cabin','cabinet','cable','cafe','cage','cake','calculate','calendar',
  'calendars','call','calm','camera','camp','campaign','campus','canal','cancel','candidate',
  'candle','candy','canvas','canyon','capable','capacity','cape','capital','captain','capture',
  'car','carbon','card','cardboard','care','career','careful','cargo','carpenter','carpet',
  'carriage','carrier','carrot','carry','cart','case','cash','cast','castle','casual','cat',
  'catalog','catch','category','cathedral','cattle','cause','caution','cave','cease','ceiling',
  'celebrate','celebrity','cell','cellar','cement','center','central','centuries','century',
  'ceremony','certain','certainly','chain','chair','chairman','challenge','chamber','champion',
  'champions','chance','change','channel','chaos','chapter','character','charge','charity',
  'charm','chart','chase','cheap','cheat','check','checklist','cheek','cheer','cheese','chef',
  'chemical','chemicals','chest','chicken','chief','child','childhood','chill','chimney','chin',
  'chip','chocolate','choice','choir','choose','chop','chord','chorus','christmas','chronicle',
  'church','circle','circuit','circulate','citizen','city','civil','claim','class','classic',
  'classical','classmate','classroom','clause','claw','clay','clean','clear','clearance','clerk',
  'clever','click','client','cliff','climate','climb','clinic','clip','clock','clockwork','close',
  'closet','cloth','cloud','club','clue','cluster','coach','coal','coast','coastline','coat',
  'code','coffee','cognitive','coil','coin','cold','collapse','collar','colleague','collect',
  'collected','college','collision','colony','color','colour','colourful','column','comb','combat',
  'combine','come','comedy','comfort','comforted','comic','command','commander','comment',
  'commerce','committee','common','community','companion','companies','company','compare','compass',
  'compete','complain','complete','completed','complex','component','compose','composite','compound',
  'compounds','computer','computers','concept','concern','concerned','concert','conclude','concluded',
  'concrete','condition','conduct','conductor','confirm','confirmed','conflict','confuse','confusion',
  'connect','connected','consensus','consent','conserve','consider','consist','console','constant',
  'construct','consult','consume','contact','contain','container','content','contest','context',
  'continent','continue','continued','contract','contracts','contrast','control','convert',
  'converted','convince','convinced','cook','cookie','cool','cooperate','copper','copy','copyright',
  'coral','cord','core','cork','corn','corner','corporate','correct','corridor','cost','costume',
  'cottage','cotton','couch','cough','could','council','count','countdown','counter','countries',
  'country','county','couple','courage','course','court','courtyard','cousin','cover','cow',
  'crack','craft','craftsman','crane','crash','crate','crawl','crazy','cream','create','creation',
  'creations','creative','creature','creatures','credit','creek','crew','cricket','crime','criminal',
  'crisis','crisp','critic','criticism','crocodile','crop','cross','crossword','crowd','crown',
  'crucial','cruel','cruise','crush','crust','crystal','cube','cultivate','culture','cup','cupboard',
  'curb','cure','curiosity','curious','curl','currency','current','currently','curtain','curve',
  'cushion','custom','customer','customers','cycle','daily','dairy','damage','damp','dance','danger',
  'dangerous','dare','dark','art','dart','dash','dashboard','data','date','daughter','daughters',
  'dawn','day','dead','deal','dear','death','debate','debt','decade','decay','deceive','decide',
  'decision','decisions','deck','declare','decline','decorate','decorated','decrease','dedicate',
  'dedicated','deep','deer','defeat','defend','defendant','defense','define','degree','delay',
  'delegate','delete','delicate','delicious','delight','delighted','deliver','delivered','delivery',
  'demand','democracy','dense','Kite','dental','deny','depart','departure','depend','dependent',
  'Smart','deposit','depth','deputy','derive','describe','described','desert','deserve','design',
  'designer','designers','desire','desk','despair','desperate','despite','destroy','destroyed',
  'detail','detect','detective','determine','develop','developed','developer','device','devil',
  'devote','diagnosis','diagram','dial','End','diamond','diary','dictate','diet','differ',
  'different','difficult','dig','dignity','dilemma','dimension','dine','dinner','direct',
  'direction','director','directors','directory','dirt','dirty','disappear','disaster','Simon',
  'discharge','disclose','discount','discover','discovery','discuss','discussed','disease','dish',
  'disk','dismiss','disorder','display','displayed','dispute','distance','distances','distant',
  'distinct','district','disturb','dive','diverse','diversity','divide','divine','division',
  'divorce','doctor','document','documents','dog','doll','dollar','domain','domestic','dominate',
  'dominated','donate','donkey','door','dose','double','doubt','dough','dove','down','dozen',
  'draft','drag','dragon','dragonfly','drain','drama','dramatic','draw','drawer','dream','dress',
  'drift','drill','drink','drive','driver','drop','drought','drum','dry','duck','due','dull',
  'duplicate','Pre','during','dusk','dust','duty','Pre','dwarf','dwell','dynamic','dynamite',
  'each','eager','eagle','ear','early','earn','earphones','earth','earthworm','ease','east','easy',
  'eat','echo','eclipse','economic','economics','economist','economy','ecosystem','edge','edit',
  'edition','editor','editorial','educate','education','effect','effective','efficient','effort',
  'egg','eight','either','elaborate','elbow','elder','elect','election','elections','electric',
  'electron','electrons','elegant','element','elephant','elephants','elevate','elevation','eleven',
  'eliminate','elite','else','elsewhere','embark','embassy','embrace','emerge','emergency',
  'emotion','emotional','emperor','emphasis','empire','employ','employee','employees','employer',
  'employers','empty','enable','enchant','enchanted','enclose','enclosure','encounter','encourage',
  'end','endeavour','endless','endorse','endurance','enemy','energetic','energy','enforce','engage',
  'engine','engineer','engineers','enhance','enjoy','enjoyable','enjoyment','enlarge','enlighten',
  'enormous','enough','ensure','enter','entertain','entire','entrance','entrances','entry',
  'envelope','envelopes','envy','episode','equal','equip','equipment','era','erase','erect',
  'error','escape','essay','essence','essential','establish','estate','estimate','estimated',
  'eternal','ethic','evaluate','evaluated','evaporate','even','evening','event','every','everybody',
  'everyday','everyone','evidence','evil','evolution','exact','exam','examine','example','exceed',
  'excellent','except','exception','excess','excessive','exchange','exchanged','excite','exclude',
  'exclusive','excuse','execute','executive','exercise','exercises','exhaust','exhibit','exile',
  'exist','existence','exit','exotic','expand','expansion','expect','expense','expensive','experience',
  'expert','explain','explained','explode','explore','explosion','export','expose','express',
  'extend','extension','extent','external','extra','extract','extreme','extremely','eye','fabric',
  'face','facility','fact','factor','factories','factory','faculty','fade','fail','failure',
  'faint','fair','fairy','faith','fall','false','fame','familiar','family','famous','fan','fancy',
  'fantastic','fantasy','far','fare','farm','farmer','fashion','fast','fat','fatal','fate','father',
  'fatigue','fault','favor','favour','favourite','fear','feast','feather','feature','federal',
  'fee','feed','feel','fellow','female','fence','festival','festivals','fetch','fever','few',
  'fiber','fibre','fiction','field','fierce','fifteen','fifth','fifty','fight','figure','file',
  'fill','film','filter','final','finally','finance','financial','find','fine','finger','finish',
  'fire','fireplace','firm','first','fish','fisherman','fist','fit','fitness','five','fix','flag',
  'flame','flash','flat','flavor','flavour','flaw','flee','fleet','flesh','flight','flip','float',
  'flock','flood','floor','flour','flow','flower','fluid','flush','flute','fly','foam','focus',
  'fog','foil','fold','folk','follow','following','fond','food','fool','foot','footprint','for',
  'forbid','forbidden','force','forecast','forehead','foreign','foreigner','forest','forever',
  'forget','forgive','forgotten','fork','form','formal','format','formation','former','formula',
  'forth','fortune','fortunate','forty','forum','forward','fossil','foster','found','founder',
  'fountain','four','fourth','fox','fraction','fragile','fragment','frame','framework','franchise',
  'frank','fraud','free','freedom','freeze','freight','frequency','frequent','fresh','friction',
  'friend','friendly','frighten','frog','from','front','frost','frown','frozen','fruit','fuel',
  'fulfil','fulfilled','full','fun','function','functions','fund','funeral','funny','fur','furious',
  'furnace','furniture','further','fury','fuse','future','gadget','gain','galaxy','gale','galleries',
  'gallery','gallon','gamble','game','gang','gap','garage','garbage','garden','gardening','garlic',
  'garment','gas','gasp','gate','gather','gathering','gauge','gaze','gear','gem','gene','general',
  'generally','generate','generated','generator','generous','genius','genre','gentle','gentleman',
  'genuine','geography','geometric','geometry','germ','gesture','ghost','giant','gift','giggle',
  'girl','give','glad','Chew','glamour','glamorous','glance','glare','glass','gleam','glide',
  'glimpse','globe','gloom','glory','glove','glow','glue','goal','goat','godfather','gold','golden',
  'golf','good','goose','gorgeous','gospel','gossip','govern','governor','gown','grab','grace',
  'grade','gradual','graduate','graduated','grain','grammar','grand','grant','grape','graph',
  'grasp','grass','grateful','gratitude','grave','graveyard','gravity','gray','graze','great',
  'greed','green','greet','grey','grief','grill','grim','grin','grind','grip','groceries','grocery',
  'groom','groove','gross','ground','group','grove','grow','growth','guarantee','guard','guardian',
  'guardians','guess','guest','guide','guideline','guilt','guilty','guitar','gulf','gum','gun',
  'gut','guy','gym','gymnasium','habit','habitat','hail','hair','half','hall','halloween','halt',
  'ham','hamburger','hammer','hand','handcraft','handful','handle','handsome','hang','happen',
  'happiness','happy','harbor','harbour','hard','hardening','hardly','hardware','harm','harmonica',
  'harmony','harness','harsh','harvest','harvested','hat','hatch','hate','haul','haunt','have',
  'haven','hawk','hazard','haze','head','headache','headaches','headline','headlines','heal',
  'health','healthy','heap','hear','heart','heartbeat','heat','heaven','heavy','hedge','heel',
  'height','heir','held','hell','hello','helmet','help','helpful','hem','hen','hence','herb',
  'herd','here','heritage','hero','hesitate','hide','high','highlight','highway','ike','hike',
  'hill','hint','hip','hire','historian','historic','histories','history','hit','hive','hobby',
  'hockey','hold','hole','holiday','hollow','holy','home','honest','honey','honeymoon','honor',
  'honour','hood','hook','hope','hopeful','horizon','horn','horoscope','horror','horse','hospital',
  'hospitals','host','hostage','hostile','hot','hotel','hour','house','household','housewife',
  'hover','how','however','huge','hull','human','humanity','humble','humid','humor','humour',
  'hundred','hunger','hungry','hunt','hunter','hurdle','hurl','hurricane','hurry','hurt','husband',
  'hut','hydraulic','hydrogen','hygiene','hymn','ice','icon','idea','ideal','identical','identify',
  'identity','idiom','idiot','idle','idol','ignite','ignorance','ignore','ill','illegal','illness',
  'illusion','image','imaginary','imagine','imitate','immediate','immense','immigrant','immune',
  'impact','impair','impartial','implement','imply','import','important','impose','impress',
  'impressed','improve','improving','impulse','inaugural','incentive','inch','incident','incidents',
  'incline','include','including','income','increase','increased','indeed','index','indicate',
  'indicated','indicator','indoor','induce','industry','infant','infect','infection','infer',
  'infinite','inflation','influence','inform','informing','initial','initially','inject','injection',
  'injure','injury','injustice','ink','inland','inmate','inn','inner','innocence','innocent',
  'input','inquire','inquiry','insect','insert','inside','insight','insist','inspect','inspector',
  'inspire','install','installed','instance','instant','instantly','instead','instinct','institute',
  'instruct','insult','insurance','insure','intact','intake','integer','integral','integrate',
  'integrity','intellect','intend','intense','intensive','intent','intention','interact','interest',
  'interface','interfere','interior','interiors','internal','internet','interpret','interrupt',
  'interval','intervals','interview','intimate','into','introduce','invade','invalid','invasion',
  'invent','invention','inventor','inventors','inventory','invest','investing','investor','invisible',
  'invite','involve','iron','irony','island','isolate','isolation','issue','item','ivory','jacket',
  'jail','jam','jar','jaw','jazz','jealous','jeans','jelly','jet','jewel','jewellery','job','join',
  'joint','joke','jolly','journal','journey','joy','judge','judgement','judgment','juice','jump',
  'junction','jungle','junior','junk','jury','just','justice','justify','juxtapose','keen','keep',
  'kettle','key','keyboard','kick','kid','kidnap','kidney','kill','kilometre','kin','kind','king',
  'kingdom','kiss','kit','kitchen','kite','kitten','knee','kneel','knife','knight','knit','knob',
  'knock','knot','know','knowledge','label','labor','labour','labyrinth','lace','lack','ladder',
  'lady','lake','lamb','lamp','land','landmark','landscape','lane','language','languages','lantern',
  'lap','large','laser','last','late','later','latest','latin','latter','laugh','laughable',
  'launch','launching','laundry','lava','law','lawmaker','lawmakers','lawn','lawsuit','lawyer',
  'lay','layer','lazy','lead','leader','leaf','league','leak','lean','leap','learn','lease',
  'least','leather','leave','lecture','ledge','left','leg','legacy','legal','legend','legendary',
  'leisure','lemon','lend','length','lens','leopard','less','lesson','let','letter','level',
  'lever','liability','liable','liar','liberal','liberty','librarian','libraries','library',
  'license','lick','lid','lie','life','lifestyle','lifetime','lift','light','lightning','like',
  'likely','limb','lime','limestone','limit','limp','line','linear','linen','linger','link',
  'lion','lip','liquid','list','listen','listening','literal','literally','literary','little',
  'live','lively','liver','livestock','living','lizard','load','loaf','loan','lobby','local',
  'locate','location','locations','lock','lodge','loft','log','logic','logical','lonely','long',
  'longevity','look','loop','loose','lord','lorry','lose','loss','lost','lot','lotion','lottery',
  'loud','lounge','love','lovely','lover','low','lower','loyal','loyalty','luck','lucky','luggage',
  'lumber','lump','lunar','lunch','lunchtime','lung','lure','luxurious','luxury','lyric','machine',
  'machinery','mad','magazine','magazines','magic','magical','magnet','magnetic','magnitude',
  'maid','mail','main','mainly','maintain','major','majority','make','maker','makeshift','makeup',
  'male','malignant','mall','mammal','man','manage','manager','mandate','mane','mango','manifesto',
  'mankind','manner','mansion','manual','many','map','maple','marble','march','margin','marine',
  'mark','market','marketing','marmalade','marriage','married','marry','marsh','martial','marvel',
  'mask','mass','massive','master','mastering','match','mate','material','materials','maternity',
  'math','matrix','matter','mature','maximum','may','maybe','mayor','meadow','meal','mean',
  'meaning','meanwhile','measure','measuring','meat','mechanic','mechanics','mechanism','medal',
  'media','medical','medicine','medicines','medium','meet','meeting','melody','melon','melt',
  'member','membrane','memoir','memorable','orial','memory','menace','mend','mental','mention',
  'mentioned','mentor','menu','merchant','merchants','mercury','mercy','mere','merely','merge',
  'merit','merry','mesh','mess','message','messenger','metal','metabolic','metaphor','metaphors',
  'meteor','meter','method','metric','microfilm','microwave','mid','middle','midnight','midst',
  'might','mighty','migrate','mild','mile','milestone','military','milk','mill','millennia',
  'million','mind','mine','mineral','minimal','miniature','minimum','minister','ministers','minor',
  'minority','mint','minus','minute','miracle','miracles','mirror','misery','miserable','miss',
  'missile','mission','mist','mistake','mix','mixture','moan','Moat','mobile','mock','mode',
  'model','moderate','modern','modest','modify','modular','moist','moisture','molecular','molecule',
  'molecules','mom','moment','momentary','momentum','monarch','monastery','monday','money','monitor',
  'monitored','monk','monkey','monster','month','monument','monuments','mood','moon','moonlight',
  'moral','more','moreover','morning','mortal','mortgage','mosque','mosquito','moss','most',
  'mostly','motel','mother','motion','motive','motor','mount','mountain','mountains','urn','mouse',
  'mouth','move','movement','movements','movie','much','mud','uffin','mug','multiple','multiply',
  'mum','municipal','murder','muscle','museum','mushroom','mushrooms','music','musical','musician',
  'musicians','must','mustard','ut','mute','mutual','mystery','mysteries','myth','mythology',
  'nail','naive','naked','name','nap','napkin','narrative','narrow','nasty','nation','national',
  'native','natural','nature','naughty','naval','navigate','navigator','navy','near','nearby',
  'nearly','neat','necessary','neck','necklace','need','needle','negative','neglect','negotiate',
  'Sim','neighbour','neither','nephew','nerve','nervous','nest','net','network','networked',
  'neutral','never','new','newly','news','newspaper','next','nice','niche','nick','niece','night',
  'nightmare','nine','ninety','noble','nobody','nod','noise','noisy','nominate','nominated',
  'none','noon','nor','norm','normal','north','northeast','northern','northwest','nose','nostalgia',
  'not','notable','note','notebook','notebooks','nothing','notice','notify','notion','noun',
  'nourish','nourished','novel','novelist','novelists','november','now','nowhere','nuclear',
  'nucleus','nuisance','number','numerous','nurse','nursery','nut','nutrition','oak','oar','oasis',
  'oath','oatmeal','obedience','obedient','obey','object','objective','obligate','obligated',
  'oblige','obscure','observe','observing','obsess','obsession','obstacle','obstacles','obtain',
  'obvious','obviously','occasion','occasions','occupant','occupants','occupy','occur','occurring',
  'ocean','october','odd','odds','odor','odour','off','offence','offend','offense','offensive',
  'offer','office','officer','official','often','oil','okay','old','olive','olympic','omit','once',
  'one','onion','online','only','onto','open','opening','opera','operate','operating','operation',
  'operator','operators','opinion','opponent','opponents','oppose','opposite','oppress','oppressed',
  'optical','optimism','option','optional','oral','orange','orbit','orchard','orchestra','order',
  'ordinary','organ','organic','organise','organised','organiser','organism','origin','original',
  'originals','ornament','orphan','other','otherwise','ought','ounce','our','ourselves','out',
  'outburst','outbursts','outcome','outdoor','outdoors','outer','outfit','outing','Woven','auti',
  'outlet','outline','outlook','output','outrage','outside','outskirts','oval','oven','over',
  'overall','overcome','overlook','overnight','overseas','overtake','overthrow','overtime',
  'overview','overwhelm','owe','owl','own','owner','ownership','ox','oxygen','oyster','ozone',
  'pace','pack','package','packaging','packet','pad','paddle','page','pain','painful','paint',
  'painter','painting','paintings','pair','palace','pale','palm','pamphlet','pamphlets','pan',
  'pancake','panda','panel','panic','panorama','panoramic','pant','panther','pants','paper',
  'paperback','paperwork','parachute','parade','paradise','adox','paragraph','parallel','parameter',
  'parcel','pardon','parent','parenting','parish','park','part','partial','particle','particles',
  'partly','partner','partition','party','pass','passage','passenger','passion','passive','passport',
  'password','passwords','past','pasta','paste','pastor','pastry','pasture','pat','patch','patent',
  'path','patience','patient','patio','patriot','patriotic','patrol','patron','pattern','pause',
  'pave','pavement','pavements','paw','pawn','pay','payment','pea','peace','peaceful','peach',
  'peak','peanut','pear','pearl','peasant','pebble','peculiar','pedal','pedestal','pedestals',
  'peer','pelican','pen','penalty','penalties','pencil','pendant','pendulum','penetrate','penguin',
  'peninsula','penny','pension','people','pepper','per','perceive','perceived','percent','perfect',
  'perform','performed','performer','perfume','perhaps','peril','period','perish','permanent',
  'permit','permitted','person','personal','personnel','persuade','persuaded','pest','pet','petal',
  'petition','petrol','petroleum','phantom','pharmacy','phase','phenomena','phone','photo','phrase',
  'physical','physician','physicist','physics','piano','pick','picnic','picture','pictures','pie',
  'piece','pier','pierce','pig','pigeon','pile','pill','pillar','pillow','pilot','pin','pinch',
  'pine','pineapple','pink','pioneer','pioneered','pipe','pirate','pistol','pit','pitch','pity',
  'pizza','place','placement','plain','plainness','plan','plane','planet','planetary','plank',
  'plant','plaster','plastic','plate','platform','platforms','platinum','play','player','playhouse',
  'plaza','plea','plead','pleasant','please','pleasure','pleasures','pledge','plentiful','plenty',
  'plot','plough','plow','plug','plum','plumber','plunge','plural','plus','pneumonia','pocket',
  'pod','poem','poet','poetry','point','pointless','poison','poke','polar','pole','police',
  'policeman','policy','polish','polite','political','politics','poll','pollen','pollute',
  'pollution','polo','polyester','pond','pony','pool','poor','pop','popular','populate','populated',
  'porch','pork','port','portable','portal','portfolio','portion','portrait','portraits','portray',
  'pose','position','positions','positive','possess','possessed','possible','possibly','post',
  'postage','One','poster','postpone','pot','potato','potential','pottery','pouch','poultry',
  'pound','pour','poverty','powder','power','powerful','practical','practice','practices','praise',
  'pray','prayer','preach','precede','precedent','precious','precise','precision','predator',
  'predict','predicted','prefer','pregnancy','pregnant','prejudice','premier','premiered','premise',
  'premium','prepare','preparing','preschool','presence','present','presented','preserve','preserved',
  'president','press','pressure','pressured','pressures','prestige','presume','pretend','pretty',
  'prevail','prevent','prevented','preview','previous','prey','price','priceless','pride','priest',
  'primarily','primary','prime','primitive','prince','princess','principal','principle','print',
  'printer','prior','priority','prison','prisoner','prisoners','privacy','private','privilege',
  'prize','probable','probably','probe','problem','procedure','proceed','process','processed',
  'processes','produce','producer','producers','producing','product','prof','professor','profile',
  'profit','profound','program','programme','progress','prohibit','project','projected','promise',
  'promising','promote','promoting','promotion','prompt','prompting','prone','pronoun','pronounce',
  'proof','prop','propeller','proper','properly','property','prophecy','prophet','proposal',
  'proposals','propose','prose','prospect','prospects','prosper','protect','protected','protein',
  'protest','protested','protocol','protocols','proud','prove','proverb','provide','provider',
  'providers','providing','province','provinces','provision','provoke','prudent','psychic','public',
  'publish','published','publisher','pudding','pull','pulp','pulse','pump','pumpkin','punch',
  'punctual','punish','pupil','puppet','puppy','purchase','purchased','purchaser','pure','purple',
  'purpose','purse','pursue','pursuit','push','put','puzzle','pyramid','qualify','qualified',
  'quality','quantity','quarrel','quarry','quart','quarter','quartz','queen','queer','quench',
  'query','quest','question','questions','queue','quick','quickly','quiet','quilt','quit','quite',
  'quiz','quota','quotation','quote','rabbit','race','racial','rack','radar','radiant','radiate',
  'radiation','radical','radio','radish','radius','raft','rage','raid','rail','railroad','railroads',
  'railway','rain','rainbow','rainfall','rainy','raise','rake','rally','ram','ranch','random',
  'range','rank','rapid','rapidly','rare','rarely','rash','rat','rate','rather','ratio','ration',
  'rational','rattle','raw','ray','razor','reach','react','reaction','reactions','read','reader',
  'readily','reading','ready','real','ise','realistic','reality','realize','really','realm','reap',
  'rear','reason','reasoning','rebel','rebellion','rebuild','recall','receipt','receive','receiving',
  'recent','recently','reception','recess','recession','recipe','recipient','reckon','recognise',
  'recognize','recommend','record','recording','recover','recovered','recruit','recruited',
  'rectangle','recycle','recycling','red','reduce','reduction','reed','reef','reel','refer',
  'referee','reference','reflect','reflected','reform','refrain','refresh','refreshed','refuge',
  'refugee','refund','refusal','refuse','regain','regard','regarding','regime','regiment','regiments',
  'region','regional','register','registers','regret','regular','regulate','regulated','rehearsal',
  'rehearse','reign','rein','reinforce','reject','rejecting','rejoice','relate','relation',
  'relations','relative','relatives','relax','relay','release','releasing','relevance','relevant',
  'reliable','relief','relieve','relieving','religion','religions','religious','relish','reluctant',
  'rely','remain','remainder','remaining','remark','remedy','remember','remind','reminder',
  'reminders','remote','removal','removable','remove','render','renew','renewable','renowned',
  'rent','rental','repair','repairing','repeat','repeating','repel','repent','replace','replacing',
  'replica','reply','report','reporter','reporting','repose','represent','repress','republic',
  'republics','repute','request','requested','require','requiring','rescue','research','resemble',
  'resent','reserve','reservoir','reside','residence','resident','residents','resign','resist',
  'resistant','resolve','resolved','resort','resource','resources','respect','respected','respond',
  'responded','response','responses','rest','restore','restoring','restrain','restraint','restrict',
  'result','resulting','resume','retail','retain','retaining','retire','retreat','retreated',
  'retrieve','retrieved','return','returning','reunion','reveal','revealing','revenge','revenue',
  'reverence','reverse','reversing','review','reviewing','revise','revival','revive','revolt',
  'revolve','revolving','reward','rewarding','rhythm','rib','ribbon','rice','rich','rid','riddle',
  'ride','rider','ridge','rifle','right','righteous','rigid','rigorous','rim','ring','rinse','riot',
  'rip','ripe','ripple','rise','risk','risky','ritual','rival','river','road','roam','roar','roast',
  'rob','robber','robbery','robe','robin','robot','robust','rock','rocket','rod','role','roll',
  'romance','romantic','romantics','roof','room','rooster','root','rope','rose','roster','rot',
  'rotate','rotten','rough','roughly','round','route','routine','row','royal','royalty','rub',
  'rubber','rubbish','ruby','rude','rug','rugby','ruin','rule','ruler','rumble','rumor','rumour',
  'run','runner','runway','rural','rush','rust','rustic','ruthless','sack','sacred','sacrifice',
  'sad','saddle','sadness','safe','safeguard','safety','sage','sail','sailor','saint','sake',
  'salad','salary','sale','saliva','salmon','salon','salt','salty','salute','salvage','same',
  'sample','sanction','sanctuary','sand','sandal','sandwich','sane','sanitary','sanity','sap',
  'sapphire','sarcasm','satellite','satin','satire','satisfy','satisfied','saturday','sauce',
  'saucer','sausage','savage','save','saving','savings','savior','saviour','savor','savour','saw',
  'say','scale','scalp','scan','scandal','scar','scarce','scare','scarf','scarlet','scatter',
  'scattered','scenario','scenarios','scene','scenery','scent','schedule','scheduled','schedules',
  'scheme','scholar','scholarly','school','science','scientist','scissors','scold','scooter',
  'scope','scorch','score','scorn','scorpion','scout','ow','scramble','scrap','scrape','scratch',
  'scream','screen','screw','script','scroll','scrub','sculpture','sea','seal','seam','search',
  'searching','seaside','season','seasoning','seat','second','secondary','secret','secretary',
  'secretion','section','sections','sector','secure','security','sedan','sediment','see','seed',
  'seek','seem','segment','seize','seldom','select','selecting','selection','selective','self',
  'selfish','sell','seller','semester','seminar','senate','senator','send','senior','sensation',
  'sense','sensible','sensitive','sentence','sentenced','sentences','sentiment','separate',
  'separated','september','sequel','sequence','sequences','serene','sergeant','serial','series',
  'serious','seriously','sermon','serpent','servant','serve','service','servicing','session',
  'set','setback','setting','settle','settlement','seven','seventeen','seventh','seventy','several',
  'severe','sew','sewage','sewer','sex','shade','shadow','shaft','shake','shall','shallow','shame',
  'shampoo','shape','share','shark','sharp','shatter','shave','shawl','she','shear','shed','sheep',
  'sheer','sheet','shelf','shell','shelter','shepherd','sheriff','shield','shift','shine','shiny',
  'ship','shirt','shiver','shock','shoe','shoot','shop','shore','short','shortage','shortages',
  'shortly','shot','should','shoulder','shoulders','shout','shove','shovel','show','showcase',
  'showcased','shower','shred','shrewd','shrimp','shrine','shrink','shrub','shrug','shut','shuttle',
  'shy','sibling','sick','sickness','side','sidewalk','siege','sigh','sight','sign','signal',
  'signature','silence','silent','silk','silly','silver','similar','similarly','simple','simplify',
  'simply','simulate','simulated','sin','since','sincere','sincerely','sing','singer','single',
  'sink','sip','sir','siren','sister','sit','site','situation','six','sixteen','sixth','sixty',
  'size','skate','skeleton','skeletons','sketch','sketching','ski','skill','skilled','skin',
  'skip','skirt','skull','sky','slab','slack','slam','slander','slang','slap','slash','slate',
  'slave','slavery','slay','sled','sleek','sleep','sleepy','sleeve','sleigh','slender','slice',
  'slide','slight','slightly','slim','slime','sling','slip','slipper','slippery','slit','slogan',
  'slope','slot','slow','slowly','slum','slumber','slump','ack','small','smart','smash','smell',
  'smile','smoke','smooth','smuggle','snack','snail','snake','snap','snatch','sneak','sneaker',
  'sneeze','sniff','snore','snow','soak','soap','soar','sob','sober','soccer','social','socialism',
  'socialist','societies','society','sock','socket','soda','sofa','soft','soften','software',
  'soil','solar','soldier','sole','solemn','solid','solitary','solitude','solo','solution',
  'solutions','solve','some','somebody','somehow','someone','something','sometime','sometimes',
  'somewhat','somewhere','son','song','soon','soothe','sorrow','sorry','sort','soul','sound',
  'soup','sour','source','south','southern','souvenir','souvenirs','sovereign','sow','space',
  'spacecraft','spaceship','spade','span','spare','spark','sparkle','sparrow','spatial','speak',
  'speaker','spear','special','specialty','species','specific','specify','specified','specimen',
  'specimens','spectacle','spectrum','speech','speed','spell','spelling','spend','sphere','spherical',
  'spice','spicy','spider','spike','spill','spin','spinach','spine','spiral','spirit','spiritual',
  'spit','spite','splash','splendid','split','spoil','spoke','sponge','sponsor','sponsored','spoon',
  'sport','spot','spotlight','spouse','spout','spray','spread','spreading','spring','sprinkle',
  'sprint','sprout','spur','spy','squad','square','squash','squat','squeak','squeeze','squid',
  'squirrel','stab','stability','stable','stack','stadium','staff','stage','stagger','stain',
  'stair','stake','stale','stalk','stall','stamp','stance','stand','standard','standards','star',
  'starch','stare','stark','start','startle','starve','state','statement','station','stations',
  'statistic','statue','status','statute','stay','steadfast','steady','steak','steal','steam',
  'steel','steep','steer','stem','step','stereo','stern','stew','stick','sticky','stiff','still',
  'stimulate','sting','stink','stir','stitch','stock','stockpile','stomach','stone','stool',
  'stoop','stop','stopwatch','storage','store','stork','storm','story','stove','straight','strain',
  'strait','strand','strange','stranger','strangers','strap','strategic','strategy','straw',
  'stray','streak','stream','streaming','street','strength','strengths','stress','stretch','stretched',
  'strict','stride','strike','striking','string','strip','stripe','strive','stroke','stroll',
  'strong','structure','struggle','struggled','struggles','stubborn','student','students','studio',
  'study','stuff','stumble','stumbling','stump','stun','stunt','stupid','sturdy','style','subject',
  'submarine','submit','submitted','subscribe','substance','subtitles','subtle','subtract','suburb',
  'subway','succeed','succeeded','success','successes','such','suck','sudden','suddenly','sue',
  'suffer','suffering','suffice','sugar','suggest','suggested','suit','suitable','suitcase',
  'suite','sulfur','sulphur','sum','summarise','summary','summer','summit','summon','sun','sunday',
  'sunflower','sunlight','sunny','sunrise','sunset','sunshine','super','superb','superhero',
  'superior','superiors','supper','supply','suppliers','supplying','support','supported','supporter',
  'suppose','supposed','suppress','supreme','sure','surely','surface','surfacing','surge','surgeon',
  'surgery','surname','surplus','surprise','surprised','surprises','surrender','surround','surrounds',
  'survey','survival','survive','surviving','survivor','survivors','suspect','suspected','suspend',
  'suspended','suspense','suspicion','sustain','sustained','swallow','swamp','swan','swap','swarm',
  'sway','swear','sweat','sweater','sweep','sweet','swell','swift','swim','swimming','swing',
  'switch','switching','sword','symbol','symmetric','symmetry','sympathy','symphony','symptom',
  'symptoms','syndrome','synonym','synthesis','synthetic','syrup','system','table','tablet',
  'tableware','tackle','tact','tactic','tag','tail','tailor','tailoring','take','tale','talent',
  'talk','tall','tame','tan','tangerine','tangle','tank','tap','tape','target','targeting','tariff',
  'task','taste','tattoo','tavern','tax','taxi','taxpayer','taxpayers','tea','teach','teacher',
  'teaching','teachings','team','tear','tease','technical','technique','tedious','teen','teenager',
  'teenagers','teeth','telegraph','telephone','telescope','tell','temper','temple','tempo',
  'temporary','tempt','ten','tenant','tend','tendency','tender','tennis','tense','tension','tent',
  'term','terminal','terrace','terrain','terrible','terrified','terrify','territory','terror',
  'terrorism','terrorist','test','testament','testify','testified','testimony','text','textbook',
  'textbooks','textile','texture','than','thank','thankful','that','thaw','theater','theatre',
  'theatres','theft','their','theme','then','theology','theory','therapist','therapy','there',
  'therefore','thermal','these','thesis','they','thick','thickness','thief','thigh','thin','thing',
  'think','third','thirst','thirsty','thirteen','thirty','this','thorn','thorough','those','though',
  'thought','thousand','thousands','thread','threat','threaten','threatens','three','threshold',
  'thrift','thrill','thrilling','thrive','throat','throne','throng','through','throw','thrust',
  'thumb','thunder','thursday','thus','tick','ticket','tickle','tide','tidy','tie','tiger','tight',
  'tighten','tightened','tile','till','tilt','timber','time','timetable','timid','tin','tiny',
  'tip','tire','tired','tissue','title','toad','toast','tobacco','today','toe','together','toil',
  'toilet','token','tolerance','tolerant','tolerate','toll','tomato','tomb','tombstone','tomorrow',
  'ton','tone','tongue','tonight','too','tool','tooth','top','topic','torch','torment','tornado',
  'torpedo','torrent','tortoise','torture','toss','total','totally','touch','tough','tour','tourist',
  'toward','towards','towel','tower','town','toxic','toy','trace','track','tract','tractor','trade',
  'trademark','tradition','traffic','tragedies','tragedy','tragic','trail','trailer','train',
  'trainer','training','trait','traitor','tram','trample','trance','transfer','transform','transit',
  'translate','transmit','transport','trap','trash','travel','traveller','tray','tread','treasure',
  'treasurer','treasures','treasury','treat','treatment','treaty','tree','trek','tremble','trembling',
  'trench','trend','trial','triangle','triangles','tribal','tribe','tribunal','tribunals','tribute',
  'trick','trigger','triggered','trim','trio','trip','triple','triumph','triumphed','trivial',
  'trolley','troop','trophy','tropical','trouble','trousers','trout','truck','true','truly',
  'trumpet','trunk','trust','truth','try','tub','tube','tuck','tuesday','tuft','tug','tuition',
  'tulip','tumble','tuna','tune','tunnel','turbine','turbulent','turf','turkey','turmoil','turn',
  'turntable','turtle','tutor','twelve','twenty','twice','twig','twilight','twin','twinkle',
  'twist','two','type','typical','tyrant','ugly','ultimate','umbrella','umbrellas','umpire',
  'unable','unanimous','unaware','uncertain','unchanged','uncle','uncover','uncovered','under',
  'undergo','undergoes','underline','undermine','underneath','undertake','underwear','undivided',
  'undo','uneasy','unfair','unfold','unhappy','unhealthy','uniform','uniforms','unify','union',
  'unique','unit','unite','unity','universal','universe','unknown','unless','unlike','unlikely',
  'unlimited','unload','unlock','unnatural','unpopular','until','unusual','unusually','unwilling',
  'uphold','upon','upper','upright','upset','upside','upstairs','upward','urban','urge','urgent',
  'usage','use','useful','useless','user','usual','usually','utensil','utilities','utility',
  'utilize','utter','vacant','vacation','vacations','vaccine','vacuum','vague','vain','valentine',
  'valid','validate','validated','valley','valuable','valuables','value','valve','vampire','van',
  'vanish','vanity','vapor','vapour','variable','variation','varieties','variety','various',
  'varnish','vary','vase','vast','vault','vegetable','vehicle','vehicles','veil','vein','velvet',
  'vendor','vengeance','venom','vent','ventilate','venture','venue','verb','verbal','verdict',
  'verge','verify','verse','version','versus','vertical','very','vessel','vest','veteran','veto',
  'via','viable','vibrant','vibrate','vibration','vice','vicinity','vicious','victim','victor',
  'victories','victory','video','view','viewer','viewpoint','vigilant','vigor','vigour','villa',
  'village','villager','villagers','villain','vine','vinegar','vintage','violate','violating',
  'violation','violence','violent','violently','violet','violin','virtual','virtually','virtue',
  'virus','visa','visible','vision','visionary','visit','visitor','visual','visualise','vital',
  'vitamin','vivid','vocal','vocation','voice','void','volcano','volcanoes','volley','voltage',
  'volume','volunteer','vomit','vote','voter','Pouch','vouch','vowel','voyage','vulgar','wad',
  'wade','wafer','wag','wage','wagon','waist','wait','waiter','wake','walk','wall','wallet',
  'walnut','wander','want','war','ward','wardrobe','ware','warehouse','warfare','warm','warmth',
  'warn','warning','warrant','warrior','wash','wasp','waste','watch','water','waterfall','watershed',
  'wave','wax','way','weak','weaken','weakening','weakness','wealth','wealthy','weapon','weapons',
  'wear','weary','weather','weave','web','wedding','wedge','wednesday','weed','week','weekend',
  'weekly','weep','weigh','weight','weird','welcome','welcoming','welfare','well','west','western',
  'wet','whale','wharf','what','whatever','wheat','wheel','when','whenever','where','whereas',
  'wherever','whether','which','while','whim','whip','whirl','whisker','whiskey','whisky','whisper',
  'whispered','whistle','white','who','whole','wholesale','whom','whose','why','wicked','wide',
  'widely','widen','widow','width','wife','wild','wildlife','will','willing','willingly','willow',
  'win','wind','windmill','windmills','window','wine','wing','wink','winner','winter','wipe',
  'wire','wisdom','wise','wish','wit','witch','with','withdraw','withdrawn','wither','within',
  'without','witness','witnessed','witnesses','wolf','woman','women','wonder','wonderful','wood',
  'wooden','woodland','woodlands','wool','word','work','workbench','worker','workforce','workshop',
  'workshops','world','worldwide','worm','worry','worse','worship','worst','worth','worthless',
  'worthy','would','wound','wrap','wrath','wreath','wreck','wrench','wrestle','wrestling','wretched',
  'wrinkle','wrist','write','writer','writing','wrong','yard','yarn','yawn','year','yearly',
  'yearn','yeast','yell','yellow','yes','yesterday','yet','yield','yogurt','yolk','young','youth',
  'zeal','zebra','zero','zest','zinc','zone','zoo'
];

/**
 * Loads the offline dictionary into a Set and a WordTrie.
 * @param {'standard'|'strict-uk'} [mode='standard']
 * @returns {Promise<{ wordSet: Set<string>, trie: WordTrie, conundrums: string[] }>}
 */
export async function loadDictionary(mode = 'standard') {
  if (cachedWordSet && cachedTrie && cachedConundrums && loadedMode === mode) {
    return { wordSet: cachedWordSet, trie: cachedTrie, conundrums: cachedConundrums };
  }

  let wordsList = [...FALLBACK_WORDS];
  let conundrumsList = [
    'ADVENTURE','ARCHITECT','ASTRONOMY','ATTENTION','AUTHORITY','AUTOMATIC','AVAILABLE','AWARENESS',
    'BEAUTIFUL','BEGINNING','BEHAVIOUR','BIOGRAPHY','BIRTHDAYS','BLACKBIRD','BLUEPRINT','BOARDROOM',
    'BODYGUARD','BOOKSTORE','BOTANICAL','BOULEVARD','BOYFRIEND','BREAKDOWN','BREAKFAST','BREATHING',
    'BRILLIANT','BROADCAST','BUILDINGS','BUTTERFLY','CALCULATE','CALENDARS','CANDIDATE','CARDBOARD',
    'CARPENTER','CATHEDRAL','CELEBRATE','CELEBRITY','CENTURIES','CERTAINLY','CHALLENGE','CHAMPIONS',
    'CHARACTER','CHECKLIST','CHEMICALS','CHILDHOOD','CHOCOLATE','CHRISTMAS','CHRONICLE','CIRCULATE'
  ];

  if (typeof fetch === 'function') {
    try {
      const [wordsRes, conRes] = await Promise.allSettled([
        fetch('./data/words.txt'),
        fetch('./data/conundrums.json')
      ]);

      if (wordsRes.status === 'fulfilled' && wordsRes.value.ok) {
        const text = await wordsRes.value.text();
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length > 500) {
          wordsList = lines;
        }
      }
      if (conRes.status === 'fulfilled' && conRes.value.ok) {
        const json = await conRes.value.json();
        if (Array.isArray(json) && json.length > 10) {
          conundrumsList = json;
        }
      }
    } catch {
      // Fallback vocabulary used when running in isolated unit test or file:// mode
    }
  }

  const wordSet = new Set();
  const trie = new WordTrie();

  for (const raw of wordsList) {
    const w = raw.trim().toLowerCase();
    if (!/^[a-z]{2,9}$/.test(w)) continue;
    // In strict-uk mode, exclude American -ize/-or spellings when UK -ise/-our exists
    if (mode === 'strict-uk' && (w.endsWith('ize') || w.endsWith('izes') || w.endsWith('ized'))) {
      continue;
    }
    wordSet.add(w);
    trie.insert(w);
  }

  for (const c of conundrumsList) {
    const answers = typeof c === 'string' ? [c] : (Array.isArray(c?.answers) ? c.answers : [c?.answer]);
    for (const answer of answers) {
      const low = String(answer || '').trim().toLowerCase();
      if (/^[a-z]{9}$/.test(low)) {
        wordSet.add(low);
        trie.insert(low);
      }
    }
  }

  cachedWordSet = wordSet;
  cachedTrie = trie;
  cachedConundrums = conundrumsList;
  loadedMode = mode;

  return { wordSet, trie, conundrums: conundrumsList };
}

/**
 * Synchronously builds a Set and WordTrie from a custom array of words (used in unit tests).
 * @param {string[]} words
 * @returns {{ wordSet: Set<string>, trie: WordTrie }}
 */
export function buildCustomDictionary(words) {
  const wordSet = new Set();
  const trie = new WordTrie();
  for (const raw of words) {
    const w = String(raw).trim().toLowerCase();
    if (/^[a-z]{2,9}$/.test(w)) {
      wordSet.add(w);
      trie.insert(w);
    }
  }
  return { wordSet, trie };
}

/**
 * Finds the best (longest) words constructible from `letters` using the provided `trie`.
 * Returns only words at the maximum available length, plus a grouped breakdown.
 *
 * @param {string[]} letters 9 letter tiles
 * @param {WordTrie} trie
 * @param {number} [limit=12] Maximum number of longest words to return
 * @returns {{
 *   topWords: string[],
 *   maxLength: number,
 *   byLength: Record<number, string[]>,
 *   totalFound: number
 * }}
 */
export function solveLettersRound(letters, trie, limit = 12) {
  if (!trie || !Array.isArray(letters) || letters.length === 0) {
    return { topWords: [], maxLength: 0, byLength: {}, totalFound: 0 };
  }

  const allWords = trie.findAllSubwords(letters, 3);
  const maxLength = allWords.length > 0 ? allWords[0].length : 0;
  // The Dictionary Corner is about the best available words: do not show
  // shorter valid words when a longer valid word can be made.
  const topWords = allWords.filter((word) => word.length === maxLength).slice(0, limit);

  /** @type {Record<number, string[]>} */
  const byLength = {};
  for (const word of topWords) {
    const len = word.length;
    if (!byLength[len]) byLength[len] = [];
    byLength[len].push(word);
  }

  return {
    topWords,
    maxLength,
    byLength,
    totalFound: allWords.length
  };
}

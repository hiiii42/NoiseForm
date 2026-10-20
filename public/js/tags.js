// Offline tag dictionary for autocomplete (used when no API token / suggest endpoint unavailable).
// name|category|approx post count. category: 0 general, 1 artist, 3 copyright, 4 character, 5 meta.
const RAW = `1girl|0|6100000
solo|0|5200000
long hair|0|4300000
breasts|0|3600000
looking at viewer|0|3500000
blush|0|3300000
smile|0|3200000
short hair|0|2300000
open mouth|0|2400000
bangs|0|1900000
blue eyes|0|1700000
skirt|0|1600000
multiple girls|0|1500000
shirt|0|1500000
large breasts|0|1400000
blonde hair|0|1400000
simple background|0|1700000
brown hair|0|1400000
black hair|0|1300000
long sleeves|0|1300000
hair ornament|0|1200000
red eyes|0|1200000
thighhighs|0|1100000
white background|0|1300000
1boy|0|1200000
gloves|0|1000000
dress|0|1000000
holding|0|900000
navel|0|1000000
hat|0|900000
medium breasts|0|900000
bow|0|950000
closed mouth|0|900000
jewelry|0|850000
very long hair|0|820000
cleavage|0|800000
hair between eyes|0|800000
twintails|0|700000
green eyes|0|700000
purple eyes|0|650000
standing|0|650000
sitting|0|600000
ribbon|0|600000
school uniform|0|620000
jacket|0|650000
upper body|0|700000
full body|0|500000
cowboy shot|0|480000
portrait|0|160000
close-up|0|110000
from above|0|160000
from below|0|160000
from side|0|260000
from behind|0|230000
dutch angle|0|180000
pink hair|0|500000
silver hair|0|330000
white hair|0|620000
blue hair|0|480000
red hair|0|380000
purple hair|0|380000
green hair|0|210000
multicolored hair|0|300000
gradient hair|0|120000
streaked hair|0|110000
ponytail|0|460000
braid|0|380000
side ponytail|0|90000
twin braids|0|110000
hair bun|0|200000
ahoge|0|360000
animal ears|0|720000
cat ears|0|320000
fox ears|0|110000
wolf ears|0|60000
horns|0|330000
wings|0|330000
tail|0|600000
halo|0|120000
glasses|0|260000
earrings|0|360000
choker|0|200000
necklace|0|220000
hairband|0|200000
hair flower|0|210000
hair ribbon|0|260000
hairclip|0|240000
heterochromia|0|90000
yellow eyes|0|450000
brown eyes|0|550000
black eyes|0|160000
orange eyes|0|80000
aqua eyes|0|120000
grey eyes|0|130000
eyelashes|0|200000
eyebrows visible through hair|0|300000
parted lips|0|300000
teeth|0|300000
tongue|0|180000
fang|0|180000
tears|0|170000
:d|0|380000
;d|0|60000
:o|0|90000
expressionless|0|60000
serious|0|50000
angry|0|60000
crying|0|60000
embarrassed|0|50000
grin|0|130000
smug|0|30000
pout|0|40000
closed eyes|0|420000
one eye closed|0|170000
half-closed eyes|0|90000
wink|0|30000
outdoors|0|500000
indoors|0|300000
sky|0|360000
cloud|0|260000
day|0|260000
night|0|200000
night sky|0|80000
starry sky|0|50000
sunset|0|50000
water|0|180000
ocean|0|100000
beach|0|90000
tree|0|200000
forest|0|60000
flower|0|380000
cherry blossoms|0|80000
petals|0|110000
rain|0|40000
snow|0|50000
city|0|50000
cityscape|0|40000
street|0|40000
building|0|70000
window|0|140000
classroom|0|30000
bedroom|0|30000
bed|0|160000
chair|0|90000
table|0|90000
scenery|0|100000
landscape|0|30000
no humans|0|260000
depth of field|0|120000
blurry background|0|130000
blurry|0|260000
bokeh|0|20000
light particles|0|50000
sunlight|0|90000
backlighting|0|50000
lens flare|0|30000
chromatic aberration|0|30000
glowing|0|130000
glowing eyes|0|50000
sparkle|0|90000
wind|0|60000
floating hair|0|120000
gradient background|0|130000
grey background|0|160000
black background|0|80000
dark|0|30000
abstract|0|8000
dress shirt|0|80000
collared shirt|0|200000
white shirt|0|300000
black shirt|0|80000
t-shirt|0|60000
hoodie|0|70000
sweater|0|100000
coat|0|110000
cape|0|100000
cloak|0|50000
kimono|0|110000
japanese clothes|0|200000
serafuku|0|150000
sailor collar|0|130000
necktie|0|130000
bowtie|0|80000
pleated skirt|0|220000
miniskirt|0|110000
shorts|0|160000
pants|0|140000
jeans|0|20000
pantyhose|0|190000
socks|0|120000
boots|0|220000
shoes|0|150000
high heels|0|110000
barefoot|0|110000
detached sleeves|0|160000
sleeveless|0|240000
off shoulder|0|90000
bare shoulders|0|420000
frills|0|240000
lace|0|60000
apron|0|90000
maid|0|70000
maid headdress|0|60000
witch hat|0|40000
beret|0|50000
baseball cap|0|25000
headphones|0|60000
scarf|0|80000
armor|0|110000
uniform|0|130000
military uniform|0|60000
swimsuit|0|210000
bikini|0|150000
bodysuit|0|70000
leotard|0|70000
china dress|0|30000
hakama|0|20000
fur trim|0|80000
weapon|0|300000
sword|0|190000
katana|0|50000
gun|0|110000
staff|0|40000
umbrella|0|50000
book|0|80000
phone|0|50000
cup|0|80000
food|0|160000
cat|0|80000
bird|0|70000
holding weapon|0|100000
holding sword|0|60000
holding umbrella|0|20000
arms up|0|50000
arm up|0|70000
hand up|0|80000
hands on own cheeks|0|15000
outstretched arm|0|40000
v|0|90000
peace sign|0|10000
crossed arms|0|40000
looking back|0|120000
looking away|0|80000
looking up|0|50000
looking down|0|40000
head tilt|0|80000
leaning forward|0|50000
lying|0|130000
on back|0|90000
kneeling|0|60000
squatting|0|30000
walking|0|40000
running|0|30000
jumping|0|20000
dancing|0|15000
fighting stance|0|10000
2girls|0|500000
3girls|0|120000
2boys|0|100000
multiple boys|0|200000
couple|0|60000
hetero|0|250000
yuri|0|120000
hug|0|60000
holding hands|0|30000
masterpiece|5|20000
best quality|5|15000
very aesthetic|5|10000
absurdres|5|1000000
highres|5|3000000
lowres|5|200000
year 2024|5|200000
year 2025|5|180000
official art|5|90000
sketch|5|80000
monochrome|5|400000
greyscale|5|380000
lineart|5|20000
watercolor (medium)|5|15000
traditional media|5|120000
oil painting (medium)|5|5000
pixel art|5|40000
chibi|5|100000
realistic|5|60000
photorealistic|5|10000
anime coloring|5|20000
flat color|5|30000
limited palette|5|15000
spot color|5|12000
halftone|5|12000
screentone|5|8000
cel shading|5|8000
1990s (style)|5|8000
retro artstyle|5|10000
comic|5|200000
border|5|60000
letterboxed|5|10000
no text|5|500
text|5|60000
signature|5|200000
watermark|5|90000
hatsune miku|4|120000
hakurei reimu|4|90000
kirisame marisa|4|70000
remilia scarlet|4|50000
flandre scarlet|4|50000
izayoi sakuya|4|45000
artoria pendragon (fate)|4|50000
saber (fate)|4|30000
tohsaka rin|4|30000
gawr gura|4|20000
houshou marine|4|20000
frieren|4|15000
fern (sousou no frieren)|4|7000
rem (re:zero)|4|20000
megumin|4|15000
asuna (sao)|4|15000
kafka (honkai: star rail)|4|10000
firefly (honkai: star rail)|4|8000
raiden shogun|4|15000
furina (genshin impact)|4|12000
lumine (genshin impact)|4|20000
yae miko|4|15000
hoshino (blue archive)|4|8000
arona (blue archive)|4|6000
nahida (genshin impact)|4|10000
touhou|3|900000
fate (series)|3|400000
fate/grand order|3|330000
genshin impact|3|250000
honkai: star rail|3|80000
blue archive|3|150000
hololive|3|300000
vocaloid|3|180000
kantai collection|3|450000
azur lane|3|130000
arknights|3|130000
pokemon|3|500000
idolmaster|3|300000
sousou no frieren|3|20000
original|3|1300000
ask (askzy)|1|1000
wlop|1|1500
mika pikazo|1|1200
ningen mame|1|900
fkey|1|900
ciloranko|1|800
rella|1|700
kawacy|1|700
modare|1|900
sho (sho lwlw)|1|900
ke-ta|1|1200
hiten (hitenkei)|1|1300
torino aqua|1|1100
nardack|1|900
tianliang duohe fangdongye|1|900
quasarcake|1|700`;

export const TAGS = RAW.split('\n').map((l) => {
  const [name, cat, count] = l.split('|');
  return { tag: name, cat: Number(cat), count: Number(count) };
});

export function searchTags(q, limit = 10) {
  q = q.trim().toLowerCase().replace(/_/g, ' ');
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const t of TAGS) {
    const i = t.tag.indexOf(q);
    if (i === 0) starts.push(t);
    else if (i > 0) contains.push(t);
  }
  const by = (a, b) => b.count - a.count;
  return [...starts.sort(by), ...contains.sort(by)].slice(0, limit);
}

// Random prompt generator (dice button).
const POOLS = {
  subject: ['1girl', '1boy', '2girls', '1girl, 1boy', 'no humans, scenery'],
  hair: ['long hair', 'short hair', 'very long hair', 'twintails', 'ponytail', 'braid', 'hair bun', 'messy hair'],
  hairc: ['black hair', 'white hair', 'silver hair', 'pink hair', 'blue hair', 'red hair', 'blonde hair', 'multicolored hair', 'gradient hair'],
  eyes: ['blue eyes', 'red eyes', 'green eyes', 'purple eyes', 'yellow eyes', 'heterochromia', 'aqua eyes'],
  outfit: ['school uniform', 'kimono', 'hoodie', 'dress', 'armor', 'maid', 'witch hat', 'military uniform', 'oversized jacket', 'sweater', 'china dress'],
  pose: ['looking at viewer', 'looking back', 'arms up', 'head tilt', 'sitting', 'standing', 'lying', 'leaning forward', 'walking'],
  expr: ['smile', 'closed eyes', 'open mouth', 'expressionless', 'blush', 'grin', 'pout', 'serious'],
  place: ['outdoors', 'night sky', 'city', 'beach', 'forest', 'classroom', 'cherry blossoms', 'rain', 'snow', 'sunset', 'underwater', 'neon lights'],
  light: ['backlighting', 'sunlight', 'light particles', 'depth of field', 'glowing', 'lens flare', 'rim lighting', 'dappled sunlight'],
  style: ['flat color', 'limited palette', 'halftone', 'watercolor (medium)', 'cel shading', 'retro artstyle', 'spot color', 'pixel art', 'sketch'],
  frame: ['upper body', 'cowboy shot', 'full body', 'portrait', 'from above', 'from below', 'dutch angle', 'close-up'],
};

export function randomPrompt() {
  const pick = (k, n = 1) => {
    const arr = [...POOLS[k]];
    const out = [];
    for (let i = 0; i < n && arr.length; i++) out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
    return out;
  };
  const subj = pick('subject')[0];
  const human = !subj.startsWith('no humans');
  const parts = [subj];
  if (human) parts.push(...pick('hairc'), ...pick('hair'), ...pick('eyes'), ...pick('outfit'), ...pick('expr'), ...pick('pose'));
  parts.push(...pick('place', 2), ...pick('light'), ...pick('frame'));
  if (Math.random() < 0.6) parts.push('{' + pick('style')[0] + '}');
  return parts.join(', ');
}

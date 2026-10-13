// Seed: runtime config (from .env) + initial destinations.
//
//   npm run db:seed                       insert missing config keys, upsert destinations
//   npm run db:seed -- --reset-config     overwrite config keys from .env (kill switch included)
//
// Rules
// - Config: the database is the runtime source of truth. Existing keys are NOT overwritten
//   unless --reset-config, so a kill switch flipped in the DB survives a re-seed.
// - Destinations: upsert by slug. Only descriptive fields are updated; active,
//   last_featured_at and geo_verified are never touched by a re-seed.
// - Nothing here is a verified fact. geo_verified stays false and no LocationFact rows are
//   created: facts need a recorded source first (research step), per the editorial rules.
// - scene_briefs are visual ideas for AI images, not claims. They deliberately contain no
//   wildlife, no human structures and no identifiable landmarks.
import 'dotenv/config';
import { createPrisma } from '../src/db.ts';

const RESET = process.argv.includes('--reset-config');
const env = process.env;

const intEnv = (name: string, fallback: number): number => {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
};

const config: Record<string, { value: unknown; description: string }> = {
  schedule: {
    value: {
      timezone: env.PUBLISH_TIMEZONE || 'Africa/Tunis',
      window_start: env.PUBLISH_WINDOW_START || '07:00',
      window_end: env.PUBLISH_WINDOW_END || '21:00',
      interval_minutes: intEnv('PUBLISH_INTERVAL_MINUTES', 120),
    },
    description: 'Publishing window; slots every interval_minutes from window_start to window_end inclusive',
  },
  daily_post_cap: { value: intEnv('DAILY_POST_CAP', 8), description: 'Max posts committed per local day' },
  publishing_enabled: {
    value: env.PUBLISHING_ENABLED === 'true',
    description: 'GLOBAL KILL SWITCH. false = nothing is published; queued posts are kept',
  },
  production_enabled: { value: true, description: 'false = stop claiming slots / generating content' },
  enabled_platforms: {
    value: (env.ENABLED_PLATFORMS || 'facebook,instagram').split(',').map((p) => p.trim()).filter(Boolean),
    description: 'Platforms that get a publication row per post',
  },
  destination_cooldown_hours: {
    value: intEnv('DESTINATION_COOLDOWN_HOURS', 48),
    description: 'Hours before a destination may be featured again (falls back to least-recent if all cooling)',
  },
  cap_gemini_image_per_day: {
    value: intEnv('GEMINI_MAX_IMAGE_CALLS_PER_DAY', 12),
    description: 'Hard daily cap on Gemini image calls (reserved atomically before each call)',
  },
  cap_anthropic_per_day: {
    value: intEnv('ANTHROPIC_MAX_TEXT_CALLS_PER_DAY', 30),
    description: 'Hard daily cap on Claude calls: image audits + captions (reserved atomically before each call)',
  },
  slot_lead_minutes: { value: 45, description: 'Claim/produce a slot up to this many minutes before its time' },
  slot_max_lateness_minutes: { value: 60, description: 'A slot not produced this long after its time is skipped, never published late' },
  slot_lease_minutes: { value: 20, description: 'Claim lease; an expired lease can be re-claimed' },
  slot_max_attempts: { value: 3, description: 'Claims per slot before it is marked failed' },
};

type Seed = {
  slug: string; nameEn: string; nameAr: string; governorate: string; region: string;
  landscapeType: string; sceneBriefs: string[];
};

const locations: Seed[] = [
  { slug: 'ain-draham', nameEn: 'Aïn Draham', nameAr: 'عين دراهم', governorate: 'Jendouba', region: 'northwest', landscapeType: 'mountain_forest',
    sceneBriefs: ['dense cork oak forest on rolling hills with mist in the valleys', 'a quiet forest path under tall cork oaks and ferns after rain', 'layered green ridges fading into soft haze'] },
  { slug: 'el-feija', nameEn: 'El Feija National Park', nameAr: 'الحديقة الوطنية بالفايجة', governorate: 'Jendouba', region: 'northwest', landscapeType: 'mountain_forest',
    sceneBriefs: ['old oak forest with mossy trunks and soft filtered light', 'a misty forest clearing on a mountain slope'] },
  { slug: 'tabarka', nameEn: 'Tabarka', nameAr: 'طبرقة', governorate: 'Jendouba', region: 'northwest', landscapeType: 'coast',
    sceneBriefs: ['weathered rocky shore with clear turquoise coves and pine-covered hills', 'waves breaking on dark coastal rocks under a dramatic sky'] },
  { slug: 'cap-serrat', nameEn: 'Cap Serrat', nameAr: 'كاب سراط', governorate: 'Bizerte', region: 'north', landscapeType: 'coast',
    sceneBriefs: ['a secluded sandy cove framed by green maquis-covered hills', 'a wild beach with low dunes and clear water under a soft sky'] },
  { slug: 'ichkeul', nameEn: 'Ichkeul National Park', nameAr: 'الحديقة الوطنية بإشكل', governorate: 'Bizerte', region: 'north', landscapeType: 'wetland_lake',
    sceneBriefs: ['a wide calm lake with reed beds and low hills on the far shore', 'marsh grasses and reeds beside still water'] },
  { slug: 'ghar-el-melh', nameEn: 'Ghar El Melh lagoon', nameAr: 'بحيرة غار الملح', governorate: 'Bizerte', region: 'north', landscapeType: 'lagoon',
    sceneBriefs: ['a quiet lagoon with mirror-like water and low hills', 'a wide sky reflected in a calm shallow lagoon'] },
  { slug: 'bou-kornine', nameEn: 'Bou Kornine National Park', nameAr: 'الحديقة الوطنية ببوقرنين', governorate: 'Ben Arous', region: 'north', landscapeType: 'mountain',
    sceneBriefs: ['pine-covered mountain slopes with a distant view toward the sea', 'a rocky mountain slope with Aleppo pines'] },
  { slug: 'jebel-zaghouan', nameEn: 'Jebel Zaghouan', nameAr: 'جبل زغوان', governorate: 'Zaghouan', region: 'north', landscapeType: 'mountain',
    sceneBriefs: ['a rugged limestone ridge above green plains', 'rocky mountain slopes with wild shrubs under drifting clouds'] },
  { slug: 'el-haouaria', nameEn: 'El Haouaria', nameAr: 'الهوارية', governorate: 'Nabeul', region: 'northeast', landscapeType: 'coast',
    sceneBriefs: ['steep limestone cliffs dropping into a deep blue sea', 'a wild coastal headland with maquis shrubs and sea spray'] },
  { slug: 'kesra', nameEn: 'Kesra plateau', nameAr: 'هضبة كسرى', governorate: 'Siliana', region: 'center', landscapeType: 'mountain',
    sceneBriefs: ['a high rocky plateau edge with pine trees and wide views over plains', 'rolling highland hills under a wide sky'] },
  { slug: 'bouhedma', nameEn: 'Bouhedma National Park', nameAr: 'الحديقة الوطنية ببوهدمة', governorate: 'Sidi Bouzid', region: 'center', landscapeType: 'steppe',
    sceneBriefs: ['open steppe with scattered acacia trees and low mountains behind', 'dry golden grassland with flat-topped acacia trees'] },
  { slug: 'kerkennah', nameEn: 'Kerkennah Islands', nameAr: 'جزر قرقنة', governorate: 'Sfax', region: 'east', landscapeType: 'island',
    sceneBriefs: ['a flat low island shoreline with shallow turquoise water and palm trees', 'a calm shallow sea over pale sandbanks'] },
  { slug: 'djerba', nameEn: 'Djerba', nameAr: 'جربة', governorate: 'Medenine', region: 'southeast', landscapeType: 'island',
    sceneBriefs: ['a calm shallow lagoon with soft sand and palms', 'olive trees on flat sandy land near a turquoise sea'] },
  { slug: 'chott-el-jerid', nameEn: 'Chott el Jerid', nameAr: 'شط الجريد', governorate: 'Tozeur / Kebili', region: 'south', landscapeType: 'salt_lake',
    sceneBriefs: ['a vast flat salt crust stretching to the horizon', 'shallow water over white salt flats reflecting the sky'] },
  { slug: 'tozeur-oases', nameEn: 'Tozeur oases', nameAr: 'واحات توزر', governorate: 'Tozeur', region: 'south', landscapeType: 'oasis',
    sceneBriefs: ['dense date palm groves with layered shade and small water channels', 'tall date palms against a wide desert sky'] },
  { slug: 'chebika', nameEn: 'Chebika', nameAr: 'الشبيكة', governorate: 'Tozeur', region: 'south', landscapeType: 'mountain_oasis',
    sceneBriefs: ['a small palm oasis tucked into a rocky desert mountain gorge', 'a narrow clear stream flowing between rocky walls and palm trees'] },
  { slug: 'tamerza', nameEn: 'Tamerza', nameAr: 'تمغزة', governorate: 'Tozeur', region: 'south', landscapeType: 'canyon',
    sceneBriefs: ['a red and ochre rocky gorge with palms along a stream', 'eroded ochre desert mountains'] },
  { slug: 'mides', nameEn: 'Midès Canyon', nameAr: 'ميداس', governorate: 'Tozeur', region: 'south', landscapeType: 'canyon',
    sceneBriefs: ['a deep winding canyon with layered sandstone walls', 'the edge of a dramatic desert canyon under a clear blue sky'] },
  { slug: 'ksar-ghilane', nameEn: 'Ksar Ghilane', nameAr: 'قصر غيلان', governorate: 'Kebili', region: 'south', landscapeType: 'desert_dunes',
    sceneBriefs: ['golden Saharan dunes meeting a small palm oasis', 'rippled sand dunes stretching to the horizon'] },
  { slug: 'douz-grand-erg', nameEn: 'Douz and the Grand Erg Oriental', nameAr: 'دوز والعرق الشرقي الكبير', governorate: 'Kebili', region: 'south', landscapeType: 'desert_dunes',
    sceneBriefs: ['endless rolling sand dunes with sharp crests', 'soft wind-shaped dune ridges'] },
  { slug: 'matmata-hills', nameEn: 'Matmata hills', nameAr: 'جبال مطماطة', governorate: 'Gabès', region: 'south', landscapeType: 'mountain',
    sceneBriefs: ['eroded ochre hills and dry valleys under a clear sky', 'layered arid ridges under a clear sky'] },
  { slug: 'chenini-gabes', nameEn: 'Chenini coastal oasis', nameAr: 'واحة شنني بقابس', governorate: 'Gabès', region: 'south', landscapeType: 'oasis',
    sceneBriefs: ['lush layered oasis greenery with palms and smaller trees beneath', 'dappled light through a dense palm canopy over a small water channel'] },
];

// Light comes from the slot time (src/core/rules.ts timeOfDay); briefs must not fight it.
const TIME_WORDS = /\b(dawn|sunrise|sunset|morning|evening|night|afternoon|golden hour|dusk|twilight|midday|noon|stars?)\b/i;
for (const l of locations) {
  for (const b of l.sceneBriefs) {
    if (TIME_WORDS.test(b)) throw new Error(`scene brief for ${l.slug} mentions a time of day: "${b}"`);
  }
}

async function main(): Promise<void> {
  const prisma = createPrisma();
  try {
    let inserted = 0;
    let reset = 0;
    for (const [key, { value, description }] of Object.entries(config)) {
      const existing = await prisma.appConfig.findUnique({ where: { key } });
      if (!existing) {
        await prisma.appConfig.create({ data: { key, value: value as object, description } });
        inserted++;
      } else if (RESET) {
        await prisma.appConfig.update({ where: { key }, data: { value: value as object, description } });
        reset++;
      }
    }
    console.log(`app_config: ${inserted} inserted, ${reset} reset from .env, ${Object.keys(config).length - inserted - reset} kept`);

    for (const l of locations) {
      const descriptive = {
        nameEn: l.nameEn, nameAr: l.nameAr, governorate: l.governorate, region: l.region,
        landscapeType: l.landscapeType, sceneBriefs: l.sceneBriefs,
      };
      await prisma.location.upsert({ where: { slug: l.slug }, create: { slug: l.slug, ...descriptive }, update: descriptive });
    }
    const total = await prisma.location.count();
    console.log(`locations: ${locations.length} upserted (${total} in table); geo_verified=false, no facts seeded`);

    const tz = (config.schedule!.value as { timezone: string }).timezone;
    const slots = await prisma.$queryRaw<{ n: number }[]>`SELECT tn_ensure_slots_ahead(2) AS n`;
    console.log(`publish_slots: ${slots[0]?.n ?? 0} new slot(s) for today + tomorrow (${tz})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// notify-morning — one line of encouragement at 6:30am local.
//
// Opt-in twice over: it needs a live push subscription *and*
// plates.notification_prefs.morning_quotes set. A daily notification nobody
// asked for is the kind of thing people uninstall an app over, so the pref
// defaults to false and the settings sheet is the only thing that sets it.
//
// Scheduling is the awkward part. pg_cron has no per-job timezone, so a fixed
// UTC hour drifts by one across daylight saving — 6:30 in Denver is 12:30 UTC in
// summer and 13:30 in winter. The cron therefore fires at *both*, and this
// function decides which one is really 6am local. A date stamp in app_config
// makes the second call a no-op, so exactly one lands per local day.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy, not an import. Edge Functions deploy as independent bundles, so a
// relative path out of this directory does not resolve once uploaded. The two
// copies are byte-identical and must stay that way; the RFC 8291 encryption in
// there is not something to let drift.
import { sendPush } from "./webpush.ts";

/** Where "morning" is. Not a member preference yet — there is one household. */
const ZONE = "America/Denver";

/** The hour that counts as morning, local. */
const SEND_HOUR = 6;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** Local wall-clock parts, without pulling in a date library. */
function localParts(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/**
 * Day and week streaks from finished sessions, in local dates.
 *
 * A deliberately smaller version of stats.trainingConsistency in the client: it
 * needs the same two numbers and cannot import a browser module. Both are
 * forgiving of the day you are still in, which at 6:30am is the entire point —
 * yesterday's training still counts this morning.
 */
function streaks(startedAt: string[], todayLocal: string, zone: string) {
  const dayOf = (iso: string) => localParts(new Date(iso), zone).date;
  const days = new Set(startedAt.map(dayOf));

  const shift = (date: string, by: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + by);
    return d.toISOString().slice(0, 10);
  };

  let cursor = days.has(todayLocal) ? todayLocal : shift(todayLocal, -1);
  let dayStreak = 0;
  while (days.has(cursor)) { dayStreak++; cursor = shift(cursor, -1); }

  // Monday-anchored, matching the client and weeklyTraining.
  const mondayOf = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const weeks = new Set([...days].map(mondayOf));

  let week = weeks.has(mondayOf(todayLocal)) ? mondayOf(todayLocal) : shift(mondayOf(todayLocal), -7);
  let weekStreak = 0;
  while (weeks.has(week)) { weekStreak++; week = shift(week, -7); }

  const lastDay = [...days].sort().pop() ?? null;
  const daysSince = lastDay
    ? Math.round((Date.parse(`${todayLocal}T12:00:00Z`) - Date.parse(`${lastDay}T12:00:00Z`)) / 86_400_000)
    : null;

  return { dayStreak, weekStreak, daysSince, everTrained: days.size > 0 };
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Quotes, attributed — and attributed correctly, which took some checking.
 *
 * "We are what we repeatedly do" is the one everyone hands to Aristotle. It is
 * Will Durant, summarising him in The Story of Philosophy, and it is credited to
 * Durant here. Anything whose provenance would not survive that kind of look is
 * left out rather than guessed at, or credited to the tradition it came from —
 * which is why two of these credit a proverb and a motto rather than a person.
 *
 * Two famous ones are deliberately absent. "Success is not final, failure is not
 * fatal" and "If you're going through hell, keep going" are both hung on
 * Churchill and appear nowhere in what he wrote.
 *
 * Ronnie Coleman's is gone too. His actual line has a word in it Carter does not
 * want, and quietly editing a quotation to suit is worse than dropping it: the
 * attribution stops being true the moment the words stop being his.
 */
const QUOTES: Array<[string, string]> = [
  // Discipline and doing the work
  ["Discipline equals freedom.", "Jocko Willink"],
  ["Discipline is the bridge between goals and accomplishment.", "Jim Rohn"],
  ["Motivation is what gets you started. Habit is what keeps you going.", "Jim Rohn"],
  ["Suffer the pain of discipline or suffer the pain of regret.", "Jim Rohn"],
  ["Take care of your body. It's the only place you have to live.", "Jim Rohn"],
  ["We are what we repeatedly do. Excellence, then, is not an act, but a habit.", "Will Durant"],
  ["Success is the sum of small efforts repeated day in and day out.", "Robert Collier"],
  ["Nothing in the world can take the place of persistence.", "Calvin Coolidge"],
  ["Energy and persistence conquer all things.", "Benjamin Franklin"],
  ["Well done is better than well said.", "Benjamin Franklin"],
  ["Perseverance is not a long race. It is many short races one after another.", "Walter Elliot"],
  ["Hard choices, easy life. Easy choices, hard life.", "Jerzy Gregorek"],
  ["There are no shortcuts to any place worth going.", "Beverly Sills"],
  ["A year from now you may wish you had started today.", "Karen Lamb"],

  // The gym, specifically
  ["The last three or four reps is what makes the muscle grow.", "Arnold Schwarzenegger"],
  ["If you don't find the time, if you don't do the work, you don't get the results.", "Arnold Schwarzenegger"],
  ["I don't count my sit-ups. I only start counting when it starts hurting.", "Muhammad Ali"],
  ["The fight is won or lost far away from witnesses, behind the lines, in the gym.", "Muhammad Ali"],
  ["I hated every minute of training. But I said, don't quit. Suffer now and live the rest of your life as a champion.", "Muhammad Ali"],
  ["Don't count the days. Make the days count.", "Muhammad Ali"],
  ["No man has the right to be an amateur in the matter of physical training.", "Socrates"],
  ["Physical fitness is the first requisite of happiness.", "Joseph Pilates"],
  ["If it doesn't challenge you, it won't change you.", "Fred DeVito"],
  ["The groundwork for all happiness is good health.", "Leigh Hunt"],
  ["The only easy day was yesterday.", "Navy SEAL motto"],

  // Showing up when you would rather not
  ["Nothing will work unless you do.", "Maya Angelou"],
  ["You must do the thing you think you cannot do.", "Eleanor Roosevelt"],
  ["Do what you can, with what you have, where you are.", "Theodore Roosevelt"],
  ["It always seems impossible until it's done.", "Nelson Mandela"],
  ["Whether you think you can, or you think you can't — you're right.", "Henry Ford"],
  ["Fall seven times, stand up eight.", "Japanese proverb"],
  ["It is not the mountain we conquer, but ourselves.", "Edmund Hillary"],
  ["It isn't the mountains ahead that wear you out. It's the pebble in your shoe.", "Muhammad Ali"],
  ["Strength does not come from physical capacity. It comes from an indomitable will.", "Mahatma Gandhi"],
  ["Do not pray for an easy life. Pray for the strength to endure a difficult one.", "Bruce Lee"],
  ["Absorb what is useful. Discard what is useless.", "Bruce Lee"],
  ["The successful warrior is the average man, with laser-like focus.", "Bruce Lee"],

  // Competitors
  ["It's not whether you get knocked down. It's whether you get up.", "Vince Lombardi"],
  ["Once you learn to quit, it becomes a habit.", "Vince Lombardi"],
  ["The only place where success comes before work is in the dictionary.", "Vince Lombardi"],
  ["I've failed over and over and over again in my life. And that is why I succeed.", "Michael Jordan"],
  ["Some people want it to happen, some wish it would happen, others make it happen.", "Michael Jordan"],
  ["You miss 100% of the shots you don't take.", "Wayne Gretzky"],
  ["Everybody has a plan until they get punched in the mouth.", "Mike Tyson"],
  ["Hard work beats talent when talent doesn't work hard.", "Tim Notke"],
  ["Today I will do what others won't, so tomorrow I can accomplish what others can't.", "Jerry Rice"],
  ["Age is no barrier. It's a limitation you put on your mind.", "Jackie Joyner-Kersee"],
  ["The will to win means nothing without the will to prepare.", "Juma Ikangaa"],
  ["Champions keep playing until they get it right.", "Billie Jean King"],
  ["It's supposed to be hard. The hard is what makes it great.", "A League of Their Own"],
  ["Ability is what you're capable of doing. Motivation determines what you do. Attitude determines how well you do it.", "Lou Holtz"],

  // The old ones, who were mostly writing about exactly this
  ["The impediment to action advances action. What stands in the way becomes the way.", "Marcus Aurelius"],
  ["You have power over your mind, not outside events. Realize this, and you will find strength.", "Marcus Aurelius"],
  ["Waste no more time arguing what a good man should be. Be one.", "Marcus Aurelius"],
  ["Difficulties strengthen the mind, as labor does the body.", "Seneca"],
  ["It is not because things are difficult that we do not dare. It is because we do not dare that they are difficult.", "Seneca"],
  ["First say to yourself what you would be, then do what you have to do.", "Epictetus"],
  ["He who has a why to live can bear almost any how.", "Friedrich Nietzsche"],
  ["That which does not kill us makes us stronger.", "Friedrich Nietzsche"],
];

/**
 * The ones about why. Written rather than quoted, because the famous lines on
 * this subject are mostly greeting cards.
 */
const HOME = [
  "The strongest version of you is the one your family gets.",
  "Nobody at home needs you to be perfect. Consistent is plenty.",
  "Look after the body. There are people depending on it.",
  "You and Aana are on the same routines. Go get yours.",
  "The habit you keep is the one the people around you copy.",
  "Thirty years from now, the training is why you can still keep up.",
  "An hour today buys a lot of hours later on.",
  "Set the example. Someone is always watching.",
  "The people who love you would rather have you around a long while.",
];

/**
 * The message.
 *
 * Every candidate is written or quoted by hand; the only thing generated is
 * which one gets picked. It draws from three pools rather than one flat list —
 * lines that know your training, quotes, and the ones about why you bother —
 * because a flat list of seventy would bury the personal ones at one-in-seventy
 * and they are the reason this reads as yours rather than as a quote app.
 */
function compose(
  s: { dayStreak: number; weekStreak: number; daysSince: number | null; everTrained: boolean },
  last: { name: string | null; weight: number | null; reps: number | null; when: string | null },
  random: () => number,
) {
  if (!s.everTrained) {
    return "Morning. Nothing logged yet — today is a good day to start.";
  }

  const personal: string[] = [
    "Morning. The bar is where you left it.",
    "Show up today. That is most of it.",
    "Nobody has ever regretted the session they did.",
    "Small session beats no session.",
  ];

  if (s.weekStreak >= 2) {
    personal.push(`${plural(s.weekStreak, "week")} running. Today makes ${s.weekStreak + 1}.`);
    personal.push(`You have not missed a week in ${plural(s.weekStreak, "week")}. Keep it.`);
  }
  if (s.dayStreak >= 2) {
    personal.push(`${plural(s.dayStreak, "day")} in a row. Again?`);
  }
  if (s.daysSince !== null && s.daysSince >= 3) {
    personal.push(`${plural(s.daysSince, "day")} off. The bar is still there.`);
    personal.push("Longest part of any break is starting it again. Today?");
  }
  if (last.weight && last.reps && last.name) {
    personal.push(`You put up ${last.weight} × ${last.reps} on ${last.name}${last.when ? ` ${last.when}` : ""}.`);
  }

  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const roll = random();

  if (roll < 0.40) return pick(personal);
  if (roll < 0.85) {
    const [text, who] = pick(QUOTES);
    return `"${text}" — ${who}`;
  }
  return pick(HOME);
}

Deno.serve(async (req) => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  const { data: configRows, error: configError } = await db.from("app_config").select("key, value");
  if (configError) return json({ error: configError.message }, 500);
  const config = Object.fromEntries((configRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));

  // Same shared secret as the idle job. It runs as service role across every
  // member, so it must not be invocable by anyone who finds the URL.
  if (!config.cron_secret || req.headers.get("x-cron-secret") !== config.cron_secret) {
    return json({ error: "forbidden" }, 403);
  }
  if (!config.vapid_public_key || !config.vapid_private_key) {
    // notify-idle-workouts mints these; nothing here should be creating keys.
    return json({ error: "no vapid keys yet" }, 503);
  }

  const now = new Date();
  const { date: today, hour } = localParts(now, ZONE);
  const force = new URL(req.url).searchParams.get("force") === "1";

  if (!force && hour !== SEND_HOUR) return json({ skipped: "not the hour", hour, zone: ZONE });
  if (!force && config.morning_sent_on === today) return json({ skipped: "already sent", today });

  const { data: wanting, error: prefsError } = await db
    .from("notification_prefs")
    .select("owner_email")
    .eq("morning_quotes", true);
  if (prefsError) return json({ error: prefsError.message }, 500);
  if (!wanting?.length) return json({ sent: 0, note: "nobody opted in" });

  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };

  let sent = 0;
  let pruned = 0;
  const bodies: string[] = [];

  for (const { owner_email } of wanting) {
    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("owner_email", owner_email)
      .is("failed_at", null);
    if (!subs?.length) continue;

    const { data: sessions } = await db
      .from("sessions")
      .select("id, name, started_at")
      .eq("owner_email", owner_email)
      .not("ended_at", "is", null)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(400);

    const s = streaks((sessions ?? []).map((x: { started_at: string }) => x.started_at), today, ZONE);

    // The heaviest completed working set of the most recent session, for the
    // lines that name something you actually did.
    let last: { name: string | null; weight: number | null; reps: number | null; when: string | null } =
      { name: null, weight: null, reps: null, when: null };

    if (sessions?.length) {
      const { data: best } = await db
        .from("session_sets")
        .select("exercise_name, weight_lb, reps")
        .eq("session_id", sessions[0].id)
        .not("completed_at", "is", null)
        .eq("is_warmup", false)
        .not("weight_lb", "is", null)
        .order("weight_lb", { ascending: false })
        .limit(1);

      if (best?.[0]) {
        last = {
          name: best[0].exercise_name,
          weight: best[0].weight_lb,
          reps: best[0].reps,
          when: new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "long" })
            .format(new Date(sessions[0].started_at)),
        };
      }
    }

    const body = compose(s, last, Math.random);
    bodies.push(body);

    const payload = JSON.stringify({
      title: "Plates",
      body,
      tag: `morning-${today}`,
    });

    for (const sub of subs) {
      const result = await sendPush(sub, payload, vapid);
      if (result.ok) { sent++; continue; }
      if (result.gone) {
        await db.from("push_subscriptions")
          .update({ failed_at: new Date().toISOString() })
          .eq("id", sub.id);
        pruned++;
      }
    }
  }

  // Stamped only when something landed, so a total failure retries on the
  // second cron hour rather than being silently swallowed for the day.
  if (sent > 0 && !force) {
    await db.from("app_config").upsert(
      { key: "morning_sent_on", value: today, is_public: false, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  }

  // The composed text comes back so a forced test run can be checked without
  // waiting for the phone. Behind the cron secret, so it discloses nothing.
  return json({ today, hour, recipients: wanting.length, sent, pruned, bodies });
});

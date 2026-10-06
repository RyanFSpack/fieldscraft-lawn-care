/**
 * /api/create-fall-checkout
 * -----------------------------------------------------------------------------
 * NEW checkout path for Fall Fest 2026 only.
 *
 * Do NOT route book.html or weekly.html here. Those still use
 * /api/create-checkout-session.js and must keep their existing behavior.
 *
 * Two offers:
 *
 *  A) Spring 2027 starter lock-in  (fair-promo.html, offer=spring_starter)
 *     - $30 deposit charged TODAY (one-time).
 *     - Card + customer saved.
 *     - Weekly plan they picked is attached as a subscription with
 *       trial_end = 2027-04-20 16:00 UTC, so NOTHING weekly is charged today.
 *     - The other $30 is NOT charged today. Ryan charges that once, manually,
 *       when mowing actually starts (see SPRING CHARGE below).
 *
 *  B) Leaf pickup  (leaf-pickup.html, offer=leaf_pickup)
 *     - One-time $40. No subscription. No haul-away.
 *
 * Stripe Dashboard products Ryan must create (or confirm) before go-live.
 * Until the Price ID env vars are set, this file creates the Product + Price
 * on the fly and reuses them by lookup_key so we do not mint a new Price
 * on every scan of the QR code.
 *
 *   1. Product name:  Spring 2027 Starter Deposit
 *      Price:         $30.00 USD, one-time
 *      lookup_key:    spring_2027_starter_deposit
 *      Env override:  STRIPE_PRICE_SPRING_DEPOSIT
 *
 *   2. Product name:  Fall Leaf Pickup — yard waste bin
 *      Price:         $40.00 USD, one-time
 *      lookup_key:    fall_leaf_pickup_bin
 *      Env override:  STRIPE_PRICE_LEAF_PICKUP
 *
 * Weekly plans already exist and are reused (not created here):
 *   Basic weekly $18:        price_1TuxzEIwpXk8ife0iLcI5L4R
 *   Full Service weekly $20: price_1TuxyXIwpXk8ife0gx9HvW6T
 *
 * -----------------------------------------------------------------------------
 * HOW THE $30 + SAVED CARD + DELAYED WEEKLY START WORKS
 * -----------------------------------------------------------------------------
 * Preferred path (implemented below):
 *   Checkout Session mode = 'subscription' with TWO line items:
 *     - one-time Price "Spring 2027 Starter Deposit" ($30)  → charged now
 *     - recurring weekly Price they picked                   → on trial
 *   subscription_data.trial_end = 2027-04-20 16:00 UTC.
 *   Stripe invoices the one-time price on the first invoice and does not
 *   bill the weekly price until the trial ends. The card is saved on the
 *   Customer because subscription Checkout always collects a payment method.
 *
 *   IMPORTANT — trial_end is a SAFETY NET, not the spring charge date.
 *   When the trial ends (~April 20, 2027, 10:00am America/Denver), Stripe
 *   will try to charge the WEEKLY plan ($18 or $20), not the remaining $30.
 *   Ryan must, before that date:
 *     1. Text in March 2027 to confirm they still live there and pick a day.
 *     2. If they moved and told us: refund the $30 deposit and cancel the
 *        subscription. Do not guess — they have to contact us.
 *     3. When mowing actually starts (target window late April 2027; weather
 *        may push this to early May — never promise a specific start date):
 *        charge the remaining $30 ONCE as a one-time invoice, then let weekly
 *        billing run at the plan they chose.
 *     4. If weather pushes the first mow past April 20, move trial_end (or
 *        pause the subscription) BEFORE April 20 so Stripe does not start
 *        weekly billing early. Card-expiry emails are Stripe’s. We still
 *        text before the first spring charge.
 *
 * Fallback (documented, not the default — used only if Stripe rejects the
 * mixed one-time + trial subscription session):
 *   - mode: 'payment'
 *   - line item: $30 deposit only
 *   - payment_intent_data.setup_future_usage = 'off_session'
 *   - customer_creation = 'always' so the card is saved on a Customer
 *   - NO subscription is created
 *   - plan (basic|full) is stored in Session + Customer metadata
 *   - Ryan starts the weekly subscription himself in spring, after the
 *     March text and after charging the remaining $30.
 *   The response includes mode: 'payment_fallback' when this path runs.
 *
 * The remaining $30 is never a silent automatic charge. There is no Price
 * and no subscription item for it. Ryan charges it by hand when mowing starts.
 * -----------------------------------------------------------------------------
 */

const Stripe = require('stripe');

const WEEKLY_PRICE_IDS = {
  basic: 'price_1TuxzEIwpXk8ife0iLcI5L4R', // Basic Weekly Mow – $18/week
  full: 'price_1TuxyXIwpXk8ife0gx9HvW6T', // Full Service Weekly Mow – $20/week
};

/**
 * Trial end for the spring starter subscription.
 * 2027-04-20 16:00 UTC = 10:00am America/Denver (MDT, UTC-6).
 * Must be > 48 hours in the future (Stripe rule). It is — this is Fall 2026.
 * This is NOT a promised mow date. See the header comment.
 */
const SPRING_TRIAL_END_UNIX = Math.floor(Date.UTC(2027, 3, 20, 16, 0, 0) / 1000);

const DEPOSIT_LOOKUP_KEY = 'spring_2027_starter_deposit';
const LEAF_LOOKUP_KEY = 'fall_leaf_pickup_bin';

function getSiteOrigin(req) {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length) {
    return JSON.parse(req.body);
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clip(value, max) {
  return String(value || '').trim().slice(0, max || 500);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Soft neighborhood flag. We still accept the lead.
 * Obvious outsides: a different city named outright, or a ZIP that is not
 * Fort Collins 80521–80528 / 80553. "Fort Collins" alone is not enough to
 * clear the flag — Kechter Farm should appear, or a known local street.
 */
function neighborhoodFlag(address) {
  const text = String(address || '').toLowerCase();
  const zip = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zipOk = !zip || /^(8052[1-8]|80553)$/.test(zip[1]);

  const otherCity =
    /\b(loveland|windsor|timnath|greeley|denver|boulder|longmont|berthoud|johnstown|severance|wellington)\b/.test(
      text
    );

  const mentionsKechter = /kechter/.test(text);
  const localStreet =
    /\b(cinque\s?foil|jupiter|kechter|ziegler|strauss|harmony|amber harvest|twin silo|zach)\b/.test(
      text
    );

  if (!zipOk || otherCity || (!mentionsKechter && !localStreet)) {
    return 'outside_or_unconfirmed';
  }
  return 'kechter_farm';
}

/**
 * Find an existing one-time Price by lookup_key, or create Product + Price.
 * Prefer STRIPE_PRICE_* env vars when Ryan has pasted a Dashboard Price ID.
 */
async function getOrCreateOneTimePrice(stripe, options) {
  if (options.envPriceId) return options.envPriceId;

  const existing = await stripe.prices.list({
    lookup_keys: [options.lookupKey],
    active: true,
    limit: 1,
  });
  const match = existing.data && existing.data.find((price) => price.lookup_key === options.lookupKey);
  if (match) {
    if (match.unit_amount !== options.unitAmount) {
      throw new Error(
        `Stripe Price ${match.id} (${options.lookupKey}) is ${match.unit_amount} cents, expected ${options.unitAmount}. Fix the Dashboard price before taking Fall Fest payments.`
      );
    }
    return match.id;
  }

  const product = await stripe.products.create({
    name: options.productName,
    description: options.description,
    metadata: {
      source: 'fall_fest_2026',
      offer: options.offer,
    },
  });

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: options.unitAmount,
    lookup_key: options.lookupKey,
    metadata: {
      source: 'fall_fest_2026',
      offer: options.offer,
    },
  });

  return price.id;
}

function springMetadata(fields) {
  return {
    name: clip(fields.name),
    phone: clip(fields.phone),
    email: clip(fields.email),
    address: clip(fields.address),
    plan: fields.plan,
    offer: 'spring_starter',
    deposit: '30',
    neighborhood: 'kechter_farm',
    neighborhood_flag: fields.neighborhoodFlag,
    source: 'fall_fest_2026',
    consent: 'yes',
    // Ryan-facing reminder. Not a charge.
    spring_charge_note: clip(
      'Remaining $30 is NOT charged today. Text in March 2027. Charge $30 once when mowing starts, then weekly. Refund deposit and cancel if they moved and told us. Move trial_end if weather pushes the first mow past 2027-04-20.',
      500
    ),
  };
}

async function createSpringSession(stripe, body, origin) {
  const name = clip(fieldsName(body));
  const phone = clip(body.phone);
  const email = clip(body.email).toLowerCase();
  const address = clip(body.address);
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!name || !phone || !email || !address) {
    return {
      status: 400,
      payload: { error: 'Name, phone, email, and street address are required.' },
    };
  }
  if (!isEmail(email)) {
    return { status: 400, payload: { error: 'Please enter a valid email for the Stripe receipt.' } };
  }
  if (plan !== 'basic' && plan !== 'full') {
    return {
      status: 400,
      payload: { error: 'Choose Basic ($18/week) or Full Service ($20/week) for after the 4-pack.' },
    };
  }
  if (body.consent !== true && body.consent !== 'yes' && body.consent !== 'true') {
    return {
      status: 400,
      payload: { error: 'Consent to text and email about spring scheduling is required.' },
    };
  }

  const flag = neighborhoodFlag(address);
  const meta = springMetadata({ name, phone, email, address, plan, neighborhoodFlag: flag });
  const weeklyPriceId = WEEKLY_PRICE_IDS[plan];
  const planLabel = plan === 'full' ? 'Full Service $20/week' : 'Basic $18/week';

  const depositPriceId = await getOrCreateOneTimePrice(stripe, {
    envPriceId: process.env.STRIPE_PRICE_SPRING_DEPOSIT,
    lookupKey: DEPOSIT_LOOKUP_KEY,
    productName: 'Spring 2027 Starter Deposit',
    description:
      'Fall Fest lock-in. $30 today holds the spring starter rate and one of 10 spots. Remaining $30 is charged when mowing starts, not today.',
    unitAmount: 3000,
    offer: 'spring_starter',
  });

  const submitMessage =
    'Pays $30 today only. Weekly billing does not start today. We’ll text in March before anything else is charged. Questions: 303.906.8597.';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      // Card only. A mixed one-time + subscription Checkout can otherwise
      // offer bank debit, which does not save a card for the spring charge.
      payment_method_types: ['card'],
      customer_email: email,
      // One-time deposit is invoiced now. Weekly price is on trial until
      // 2027-04-20 and is not charged today. Remaining $30 is not a line item.
      line_items: [
        { price: depositPriceId, quantity: 1 },
        { price: weeklyPriceId, quantity: 1 },
      ],
      metadata: meta,
      subscription_data: {
        trial_end: SPRING_TRIAL_END_UNIX,
        metadata: meta,
        description: `Spring 2027 starter — ${planLabel} after 4-pack. Trial until 2027-04-20. Deposit $30 paid today.`,
      },
      // Customer object is created by subscription Checkout. Copy metadata
      // onto it via customer_update is not available the same way; we set
      // customer metadata after the session is created if a customer id exists,
      // and also pass it on the session so the webhook/dashboard has it now.
      success_url: `${origin}/fair-promo-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/fair-promo.html`,
      custom_text: {
        submit: { message: submitMessage },
      },
    });

    if (session.customer) {
      try {
        await stripe.customers.update(session.customer, {
          name,
          email,
          phone,
          metadata: meta,
        });
      } catch (customerErr) {
        // Session already has the metadata. Do not fail checkout over this.
        console.error('Could not copy spring metadata onto Customer:', customerErr);
      }
    }

    return {
      status: 200,
      payload: {
        url: session.url,
        sessionId: session.id,
        mode: 'subscription',
        trialEnd: '2027-04-20T16:00:00Z',
        neighborhoodFlag: flag,
      },
    };
  } catch (primaryErr) {
    console.error(
      'Spring starter subscription+deposit session failed; using payment fallback (no subscription yet):',
      primaryErr
    );

    // FALLBACK: charge the $30 deposit, save the card, do not start weekly.
    // Ryan creates the subscription in spring from metadata.plan.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      customer_creation: 'always',
      line_items: [{ price: depositPriceId, quantity: 1 }],
      payment_intent_data: {
        setup_future_usage: 'off_session',
        metadata: meta,
        description: 'Spring 2027 Starter Deposit — $30 today. Weekly not started.',
      },
      metadata: Object.assign({}, meta, {
        billing_path: 'payment_fallback',
        weekly_price_id: weeklyPriceId,
        note: 'Subscription NOT started. Start it in spring after the March text and the remaining $30.',
      }),
      success_url: `${origin}/fair-promo-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/fair-promo.html`,
      custom_text: {
        submit: { message: submitMessage },
      },
    });

    if (session.customer) {
      try {
        await stripe.customers.update(session.customer, {
          name,
          email,
          phone,
          metadata: Object.assign({}, meta, {
            billing_path: 'payment_fallback',
            weekly_price_id: weeklyPriceId,
          }),
        });
      } catch (customerErr) {
        console.error('Could not copy fallback metadata onto Customer:', customerErr);
      }
    }

    return {
      status: 200,
      payload: {
        url: session.url,
        sessionId: session.id,
        mode: 'payment_fallback',
        neighborhoodFlag: flag,
      },
    };
  }
}

async function createLeafSession(stripe, body, origin) {
  const name = clip(fieldsName(body));
  const phone = clip(body.phone);
  const email = clip(body.email).toLowerCase();
  const address = clip(body.address);
  const preferredWeek = clip(body.preferredWeek || body.preferred_week);
  const notes = clip(body.notes);
  const binConfirmed =
    body.binConfirmed === true ||
    body.bin_confirmed === 'yes' ||
    body.bin_confirmed === true ||
    body.binConfirmed === 'yes';

  if (!name || !phone || !email || !address) {
    return {
      status: 400,
      payload: { error: 'Name, phone, email, and street address are required.' },
    };
  }
  if (!isEmail(email)) {
    return { status: 400, payload: { error: 'Please enter a valid email for the Stripe receipt.' } };
  }
  if (!binConfirmed) {
    return {
      status: 400,
      payload: {
        error:
          'Leaf pickup needs a yard-waste bin on site. Check the bin box, or text Ryan at 303.906.8597.',
      },
    };
  }
  if (!preferredWeek) {
    return { status: 400, payload: { error: 'Pick a preferred week, or “as soon as you can.”' } };
  }
  if (body.consent !== true && body.consent !== 'yes' && body.consent !== 'true') {
    return { status: 400, payload: { error: 'Consent to text about the pickup day is required.' } };
  }

  const flag = neighborhoodFlag(address);
  const meta = {
    name,
    phone,
    email,
    address,
    offer: 'leaf_pickup',
    bin_confirmed: 'yes',
    preferred_week: preferredWeek,
    notes,
    neighborhood: 'kechter_farm',
    neighborhood_flag: flag,
    source: 'fall_fest_2026',
    consent: 'yes',
    plan: '',
    deposit: '',
  };

  const leafPriceId = await getOrCreateOneTimePrice(stripe, {
    envPriceId: process.env.STRIPE_PRICE_LEAF_PICKUP,
    lookupKey: LEAF_LOOKUP_KEY,
    productName: 'Fall Leaf Pickup — yard waste bin',
    description:
      'Bromley mows and bags leaves into the customer’s own yard-waste bin. Nothing is hauled away. $40 per visit.',
    unitAmount: 4000,
    offer: 'leaf_pickup',
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: email,
    customer_creation: 'always',
    line_items: [{ price: leafPriceId, quantity: 1 }],
    metadata: meta,
    payment_intent_data: {
      metadata: meta,
      description: 'Fall leaf pickup — leaves go in the customer yard-waste bin only. $40.',
    },
    success_url: `${origin}/leaf-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/leaf-pickup.html`,
    custom_text: {
      submit: {
        message:
          'Leaves go in your yard-waste bin only. Nothing is hauled away. Ryan will text from 303.906.8597 to confirm the day.',
      },
    },
  });

  if (session.customer) {
    try {
      await stripe.customers.update(session.customer, {
        name,
        email,
        phone,
        metadata: meta,
      });
    } catch (customerErr) {
      console.error('Could not copy leaf metadata onto Customer:', customerErr);
    }
  }

  return {
    status: 200,
    payload: {
      url: session.url,
      sessionId: session.id,
      mode: 'payment',
      neighborhoodFlag: flag,
    },
  };
}

function fieldsName(body) {
  return body.name || body.full_name || '';
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing STRIPE_SECRET_KEY environment variable');
    return sendJson(res, 500, {
      error: 'Payment system is not configured. Text Ryan at 303.906.8597.',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    console.error('Invalid JSON body', err);
    return sendJson(res, 400, { error: 'Invalid request body. Expected JSON.' });
  }

  const offer = String(body.offer || body.form_type || '').trim().toLowerCase();
  const origin = getSiteOrigin(req);

  try {
    if (offer === 'spring_starter' || offer === 'fair_promo') {
      const result = await createSpringSession(stripe, body, origin);
      return sendJson(res, result.status, result.payload);
    }
    if (offer === 'leaf_pickup') {
      const result = await createLeafSession(stripe, body, origin);
      return sendJson(res, result.status, result.payload);
    }
    return sendJson(res, 400, {
      error: 'Unknown Fall Fest offer. Use spring_starter or leaf_pickup.',
    });
  } catch (err) {
    console.error('Fall Fest Checkout error:', err);
    return sendJson(res, 500, {
      error:
        (err && err.message) ||
        'Could not start checkout. Try again or text Ryan at 303.906.8597.',
    });
  }
};

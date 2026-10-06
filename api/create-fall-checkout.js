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
 *     - $30 deposit charged TODAY (one-time). Nothing else.
 *     - Customer is created and saved. Card is saved for the later $30.
 *     - NO weekly subscription. Do not attach basic_weekly or full_weekly.
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
 * Weekly plans are NOT part of this offer. Do not attach
 * basic_weekly or full_weekly to a spring_starter Checkout Session.
 * book.html and weekly.html still use /api/create-checkout-session.js.
 *
 * -----------------------------------------------------------------------------
 * HOW THE $30 DEPOSIT + SAVED CUSTOMER WORKS
 * -----------------------------------------------------------------------------
 * spring_starter Checkout Session (implemented below):
 *   - mode: 'payment'
 *   - one line item: one-time Price "Spring 2027 Starter Deposit" ($30)
 *   - customer_creation: 'always' so the Customer is saved
 *   - payment_intent_data.setup_future_usage = 'off_session' so the card
 *     is saved on that Customer for the later $30
 *   - NO subscription is created
 *   - NO weekly price (basic_weekly / full_weekly) is attached
 *
 * Ryan, in spring:
 *   1. Text in March 2027 to confirm they still live there and pick a day.
 *   2. If they moved and told us: refund the $30 deposit. Do not guess —
 *      they have to contact us.
 *   3. When mowing actually starts (target window late April 2027; weather
 *      may push this to early May — never promise a specific start date):
 *      charge the remaining $30 ONCE as a one-time invoice.
 *
 * The remaining $30 is never a silent automatic charge. There is no Price
 * and no subscription item for it. Ryan charges it by hand when mowing starts.
 * -----------------------------------------------------------------------------
 */

const Stripe = require('stripe');

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
    offer: 'spring_starter',
    deposit: '30',
    neighborhood: 'kechter_farm',
    neighborhood_flag: fields.neighborhoodFlag,
    source: 'fall_fest_2026',
    consent: 'yes',
    // Ryan-facing reminder. Not a charge. No weekly subscription on this offer.
    spring_charge_note: clip(
      'Remaining $30 is NOT charged today. No weekly subscription. Text in March 2027. Charge $30 once when mowing starts. Refund the deposit if they moved and told us before we start.',
      500
    ),
  };
}

async function createSpringSession(stripe, body, origin) {
  const name = clip(fieldsName(body));
  const phone = clip(body.phone);
  const email = clip(body.email).toLowerCase();
  const address = clip(body.address);

  if (!name || !phone || !email || !address) {
    return {
      status: 400,
      payload: { error: 'Name, phone, email, and street address are required.' },
    };
  }
  if (!isEmail(email)) {
    return { status: 400, payload: { error: 'Please enter a valid email for the Stripe receipt.' } };
  }
  if (body.consent !== true && body.consent !== 'yes' && body.consent !== 'true') {
    return {
      status: 400,
      payload: { error: 'Consent to text and email about spring scheduling is required.' },
    };
  }

  const flag = neighborhoodFlag(address);
  const meta = springMetadata({ name, phone, email, address, neighborhoodFlag: flag });

  const depositPriceId = await getOrCreateOneTimePrice(stripe, {
    envPriceId: process.env.STRIPE_PRICE_SPRING_DEPOSIT,
    lookupKey: DEPOSIT_LOOKUP_KEY,
    productName: 'Spring 2027 Starter Deposit',
    description:
      'Fall Fest lock-in. $30 today holds the spring starter rate and one of 10 spots. Remaining $30 is charged when mowing starts, not today. No weekly subscription.',
    unitAmount: 3000,
    offer: 'spring_starter',
  });

  // $30 deposit only. Save the customer and card. Do not start a subscription.
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: email,
    customer_creation: 'always',
    line_items: [{ price: depositPriceId, quantity: 1 }],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: meta,
      description: 'Spring 2027 Starter Deposit — $30 today. No weekly subscription.',
    },
    metadata: meta,
    success_url: `${origin}/fair-promo-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/fair-promo.html`,
    custom_text: {
      submit: {
        message:
          'Pays $30 today only. We’ll text you in March before anything else is charged. Questions: 303.906.8597.',
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
      // Session already has the metadata. Do not fail checkout over this.
      console.error('Could not copy spring metadata onto Customer:', customerErr);
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
